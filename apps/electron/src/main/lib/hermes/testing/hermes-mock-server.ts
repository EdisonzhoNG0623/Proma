/**
 * Mock Hermes 服务器（测试辅助）
 *
 * 用 Bun.serve 提供 HTTP + WebSocket，模拟 Hermes Agent Dashboard 与 API Server 的
 * 协议契约，供端到端契约测试使用。
 *
 * 覆盖协议面：
 * - Dashboard HTTP：/api/status、/api/auth/providers、/auth/password-login、/api/auth/ws-ticket
 * - Dashboard WS：/api/ws JSON-RPC（session.create/resume、prompt.submit、approval.respond、session.interrupt）
 * - API Server：/v1/capabilities、/v1/runs、/v1/runs/{id}/events（SSE）
 *
 * 该文件仅用于测试，不进入生产构建路径。
 */

import type { Server } from 'bun'

/** Bun Server 实例类型（带 WebSocketData 泛型） */
type BunServer = Server<{ authenticated: boolean }>

/** mock 可配置选项 */
export interface MockHermesServerOptions {
  /** 是否开启认证（默认 true） */
  authRequired?: boolean
  /** 密码登录校验（默认 admin/correct-password） */
  validCredentials?: { username: string; password: string }
  /** ws-ticket 是否返回 404（模拟 Dashboard 不可用，触发 API fallback） */
  disableDashboardWs?: boolean
  /** prompt.submit 后推送的事件序列（默认 message.delta × 2 + turn.completed） */
  turnEvents?: Array<{ method: string; params?: Record<string, unknown> }>
  /** 监听端口（默认 0=随机） */
  port?: number
}

/** 记录收到的请求 */
export interface MockHermesRequest {
  method: string
  params: unknown
}

/** Mock 服务器句柄 */
export interface MockHermesServerHandle {
  /** 实际端口 */
  port: number
  /** 记录的全部 WS JSON-RPC 请求 */
  wsRequests: MockHermesRequest[]
  /** 记录的全部 HTTP 请求（path） */
  httpPaths: string[]
  /** 停止服务器 */
  stop(): Promise<void>
}

const DEFAULT_TURN_EVENTS = [
  { method: 'message.delta', params: { text: '契约测试' } },
  { method: 'message.delta', params: { text: '的消息' } },
  { method: 'tool.start', params: { tool_use_id: 't1', tool_name: 'Bash', input: { command: 'ls' } } },
  { method: 'tool.completed', params: { tool_use_id: 't1', tool_name: 'Bash' } },
  { method: 'turn.completed', params: {} },
]

/**
 * 启动 mock Hermes 服务器。
 */
export async function startMockHermesServer(
  options: MockHermesServerOptions = {},
): Promise<MockHermesServerHandle> {
  const authRequired = options.authRequired ?? true
  const valid = options.validCredentials ?? { username: 'admin', password: 'correct-password' }
  const wsRequests: MockHermesRequest[] = []
  const httpPaths: string[] = []
  const turnEvents = options.turnEvents ?? DEFAULT_TURN_EVENTS

  const server = Bun.serve<{ authenticated: boolean }>({
    port: options.port ?? 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      httpPaths.push(`${req.method} ${url.pathname}`)

      // ---- Dashboard HTTP ----
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return Response.json({
          version: '0.20.0',
          auth_required: authRequired,
          auth_flows: authRequired ? ['cookie'] : [],
        })
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/providers') {
        return Response.json({
          providers: [
            { name: 'basic', display_name: 'Username & Password', supports_password: true },
          ],
        })
      }
      if (req.method === 'POST' && url.pathname === '/auth/password-login') {
        const body = (await req.json()) as { username?: string; password?: string }
        if (body.username === valid.username && body.password === valid.password) {
          const headers = new Headers({
            'Content-Type': 'application/json',
            'Set-Cookie': 'hermes_session_at=mock-at-token; Path=/; HttpOnly',
          })
          return new Response(JSON.stringify({ ok: true, next: '/' }), { status: 200, headers })
        }
        return Response.json({ detail: 'Invalid credentials' }, { status: 401 })
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/ws-ticket') {
        if (options.disableDashboardWs) {
          return Response.json({ detail: 'Not found' }, { status: 404 })
        }
        const cookie = req.headers.get('cookie') ?? ''
        if (!cookie.includes('hermes_session_at=mock-at-token')) {
          return Response.json({ detail: 'Unauthorized' }, { status: 401 })
        }
        return Response.json({ ticket: 'mock-ws-ticket' })
      }

      // ---- API Server ----
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
        if (req.headers.get('authorization') !== 'Bearer mock-api-key') {
          return Response.json({ detail: 'Unauthorized' }, { status: 401 })
        }
        return Response.json({
          features: { run_submission: true, run_stop: true },
          endpoints: {
            runs: { method: 'POST', path: '/v1/runs' },
            run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
            run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
          },
        })
      }
      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        return Response.json({ run_id: 'run_contract_1' }, { status: 202 })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/runs/') && url.pathname.endsWith('/events')) {
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const push = (data: string): void => {
              controller.enqueue(encoder.encode(`data: ${data}\n\n`))
            }
            push(JSON.stringify({ event: 'message.delta', delta: 'API 契约' }))
            push(JSON.stringify({ event: 'run.completed' }))
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }
      if (req.method === 'POST' && url.pathname.startsWith('/v1/runs/') && url.pathname.endsWith('/stop')) {
        return Response.json({}, { status: 200 })
      }

      // ---- WS 升级 ----
      if (req.method === 'GET' && url.pathname === '/api/ws') {
        const cookie = req.headers.get('cookie') ?? ''
        const ticket = url.searchParams.get('ticket') ?? ''
        const authenticated =
          cookie.includes('hermes_session_at=mock-at-token') || ticket === 'mock-ws-ticket'
        if (srv.upgrade(req, { data: { authenticated } })) {
          return undefined
        }
        return new Response('upgrade failed', { status: 400 })
      }

      return Response.json({ detail: 'not found' }, { status: 404 })
    },
    websocket: {
      open(ws) {
        const data = ws.data
        if (!data.authenticated) {
          ws.close(4001, 'unauthorized')
          return
        }
        ws.send(JSON.stringify({
          jsonrpc: '2.0', method: 'event',
          params: { type: 'gateway.ready', payload: { skin: {}, change_events: true } },
        }))
      },
      message(ws, rawMessage) {
        let msg: { id?: number; method?: string; params?: unknown }
        try {
          msg = JSON.parse(String(rawMessage)) as typeof msg
        } catch {
          return
        }
        if (!msg.method) return
        const method = msg.method
        const id = msg.id

        const reply = (result: unknown): void => {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
        }
        const push = (type: string, payload: Record<string, unknown> = {}): void => {
          // 真实 Hermes 格式：method='event'，事件类型在 params.type，数据在 params.payload
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'event',
            params: { type, session_id: String((msg.params as Record<string, unknown>)?.session_id ?? ''), payload },
          }))
        }

        wsRequests.push({ method, params: msg.params })
        if (method === 'session.create') {
          reply({ session_id: 'run-1', stored_session_id: 'stored-1' })
        } else if (method === 'session.resume') {
          reply({ session_id: 'run-2', stored_session_id: 'stored-1' })
        } else if (method === 'session.list') {
          reply({
            sessions: [
              { id: 's1', title: 'Mock 会话 A', preview: '你好', started_at: Date.now() - 60000, message_count: 3, source: 'cli' },
              { id: 's2', title: 'Mock 会话 B', preview: '继续', started_at: Date.now() - 120000, message_count: 8, source: 'gateway' },
            ],
          })
        } else if (method === 'projects.tree') {
          reply({
            projects: [
              { id: 'p_1', label: 'mock-project-a', path: '/srv/a', sessionCount: 2, lastActive: Date.now(), previewSessions: [{ id: 's1', title: 'Mock 会话 A' }] },
              { id: 'p_2', label: 'mock-project-b', path: '/srv/b', sessionCount: 1, lastActive: Date.now(), previewSessions: [] },
            ],
            active_id: 'p_1',
            scoped_session_ids: ['s1', 's2'],
          })
        } else if (method === 'projects.project_sessions') {
          reply({
            project: {
              id: String((msg.params as Record<string, unknown>)?.project_id ?? 'p_1'),
              label: 'mock-project-a',
              path: '/srv/a',
              sessionCount: 2,
              repos: [],
              previewSessions: [],
            },
          })
        } else if (method === 'prompt.submit') {
          reply({})
          // 推送 turn 事件序列（微延迟保证请求响应先到）
          setTimeout(() => {
            for (const event of turnEvents) {
              push(event.method, event.params ?? {})
            }
          }, 5)
        } else if (method === 'approval.respond') {
          reply({ resolved: true })
        } else if (method === 'session.interrupt') {
          reply({})
        } else {
          reply({})
        }
      },
      close() {
        // 连接关闭无需处理
      },
    },
  })

  return {
    port: (server as BunServer).port!,
    wsRequests,
    httpPaths,
    stop: async () => {
      server.stop()
    },
  }
}
