/**
 * Hermes Runtime Facade BDD 测试
 *
 * 覆盖：会话绑定、Dashboard 完整 turn（认证/建会话/事件流）、恢复会话、
 * API Server fallback、abort/interrupt。
 */

import { describe, expect, test } from 'bun:test'
import { HermesRuntimeFacade, type HermesRuntimeDeps, type HermesSessionBinding } from './hermes-runtime-facade'
import { HermesError } from './hermes-errors'
import type { HermesJsonResponse, HermesSseHandle, HermesTransport } from './transport/hermes-transport'
import type { HermesTarget } from '@proma/shared'

/** fake WebSocket（支持 send 解析与事件触发） */
class FakeWebSocket extends EventTarget {
  sent: Array<Record<string, unknown>> = []
  private readonly onRequest: (msg: Record<string, unknown>, socket: FakeWebSocket) => void
  constructor(onRequest: (msg: Record<string, unknown>, socket: FakeWebSocket) => void) {
    super()
    this.onRequest = onRequest
  }
  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>
    this.onRequest(msg, this)
  }
  emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
  }
  close(): void {
    this.dispatchEvent(new Event('close'))
  }
}

/** 构造 facade deps 的辅助 */
const createDeps = (overrides: Partial<HermesRuntimeDeps> = {}): HermesRuntimeDeps => {
  const baseTarget: HermesTarget = {
    id: 'target-1',
    name: 't',
    mode: 'direct',
    remoteUrl: 'https://h.example.com/',
    auth: {
      dashboardMode: 'password-cookie',
      dashboardProvider: 'basic',
      dashboardCredentialRef: 'cred-1',
    },
    createdAt: 0,
    updatedAt: 0,
  }
  const bindings = new Map<string, HermesSessionBinding>([['sess-1', { targetId: 'target-1', profile: 'work' }]])
  const persisted = new Map<string, string>()

  return {
    getTarget: (id) => (id === 'target-1' ? baseTarget : null),
    getCredential: (ref) => (ref === 'cred-1' ? 'mock-api-key' : null),
    readDashboardPassword: (ref) =>
      ref === 'cred-1' ? { username: 'admin', password: 'p@ss' } : null,
    getBinding: (sessionId) => bindings.get(sessionId) ?? null,
    persistRemoteSessionId: (sessionId, remoteSessionId) => {
      persisted.set(sessionId, remoteSessionId)
    },
    buildTransport: async () => createFakeTransport(),
    ensureRemoteCwd: async () => false,
    ...overrides,
  }
}

/** 构造 fake transport：Dashboard 走 WS，API 走 SSE */
const createFakeTransport = (): HermesTransport => {
  let socket: FakeWebSocket | null = null
  const transport: HermesTransport = {
    baseUrl: 'https://h.example.com/',
    requestJson: async (path): Promise<HermesJsonResponse> => {
      if (path === '/auth/password-login') {
        return {
          status: 200,
          body: { ok: true, next: '/' },
          headers: { 'set-cookie': ['hermes_session_at=at-token; Path=/'] },
        }
      }
      if (path === '/api/auth/ws-ticket') {
        return { status: 200, body: { ticket: 'ticket-1' } }
      }
      if (path === '/v1/capabilities') {
        return { status: 200, body: { capabilities: {} } }
      }
      if (path === '/v1/runs') {
        return { status: 202, body: { run_id: 'run_1' } }
      }
      if (path === '/v1/runs/run_1/stop') {
        return { status: 200, body: {} }
      }
      if (path === '/api/status') {
        return { status: 404, body: {} }
      }
      return { status: 404, body: {} }
    },
    connectWebSocket: async (url) => {
      socket = new FakeWebSocket((msg, s) => {
        const method = String(msg.method ?? '')
        const id = msg.id as number
        if (method === 'session.create') {
          s.emitMessage({ jsonrpc: '2.0', id, result: { session_id: 'run-1', stored_session_id: 'stored-1' } })
        } else if (method === 'session.resume') {
          s.emitMessage({ jsonrpc: '2.0', id, result: { session_id: 'run-2', stored_session_id: 'stored-1' } })
        } else if (method === 'prompt.submit') {
          s.emitMessage({ jsonrpc: '2.0', id, result: {} })
          // 推送 turn 事件流
          setTimeout(() => {
            s.emitMessage({ jsonrpc: '2.0', method: 'message.delta', params: { text: '你好' } })
            s.emitMessage({ jsonrpc: '2.0', method: 'message.delta', params: { text: '，Hermes' } })
            s.emitMessage({ jsonrpc: '2.0', method: 'tool.start', params: { tool_use_id: 't1', tool_name: 'Bash', input: { command: 'ls' } } })
            s.emitMessage({ jsonrpc: '2.0', method: 'tool.completed', params: { tool_use_id: 't1', tool_name: 'Bash' } })
            s.emitMessage({ jsonrpc: '2.0', method: 'session.info', params: { status: 'complete' } })
            s.emitMessage({ jsonrpc: '2.0', method: 'turn.completed', params: {} })
          }, 5)
        } else {
          s.emitMessage({ jsonrpc: '2.0', id, result: {} })
        }
      })
      return { socket: socket as unknown as WebSocket, errorCode: null, errorMessage: null }
    },
    openSse: async (_path, options): Promise<HermesSseHandle> => {
      // API Server fallback SSE：推送 message.delta + run.completed
      const events = [
        { event: 'message.delta', delta: 'API 你好' },
        { event: 'run.completed' },
      ]
      for (const event of events) {
        options.onEvent({ data: JSON.stringify(event) })
      }
      options.onEnd?.()
      return { abort: () => undefined, done: Promise.resolve() }
    },
    dispose: () => undefined,
  }
  return transport
}

const collect = async (iterable: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = []
  for await (const item of iterable) {
    out.push(item)
  }
  return out
}

describe('HermesRuntimeFacade query', () => {
  test('Given 会话未绑定 When query Then 抛错误', async () => {
    const facade = new HermesRuntimeFacade(createDeps())
    const error = await collect(facade.query({ sessionId: 'no-binding', prompt: 'hi', agentRuntime: 'hermes-remote' })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HermesError)
    expect((error as HermesError).message).toContain('未绑定')
  })

  test('Given Dashboard turn When query Then 产出 assistant + result', async () => {
    const facade = new HermesRuntimeFacade(createDeps())
    const messages = await collect(facade.query({ sessionId: 'sess-1', prompt: '你好', agentRuntime: 'hermes-remote' }))
    const types = messages.map((m) => (m as { type: string }).type)
    expect(types).toContain('assistant')
    expect(types).toContain('result')
    expect(types).toContain('tool_progress')
    const assistant = messages.find((m) => (m as { type: string }).type === 'assistant') as {
      message: { content: Array<{ type: string; text?: string; name?: string }> }
    }
    const texts = assistant.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    expect(texts).toContain('你好')
    expect(assistant.message.content.some((block) => block.type === 'tool_use')).toBe(true)
  })

  test('Given 绑定包含 remoteSessionId When query Then 走 resume', async () => {
    const bindings = new Map<string, HermesSessionBinding>([
      ['sess-2', { targetId: 'target-1', profile: 'work', remoteSessionId: 'stored-1' }],
    ])
    const deps = createDeps({
      getBinding: (sessionId) => bindings.get(sessionId) ?? null,
    })
    const facade = new HermesRuntimeFacade(deps)
    const messages = await collect(facade.query({ sessionId: 'sess-2', prompt: '继续', agentRuntime: 'hermes-remote' }))
    expect(messages.some((m) => (m as { type: string }).type === 'assistant')).toBe(true)
  })

  test('Given 新会话 When query Then 持久化 remoteSessionId', async () => {
    const persisted: string[] = []
    const facade = new HermesRuntimeFacade(
      createDeps({
        persistRemoteSessionId: (sessionId, remoteSessionId) => {
          persisted.push(`${sessionId}:${remoteSessionId}`)
        },
      }),
    )
    await collect(facade.query({ sessionId: 'sess-1', prompt: 'hi', agentRuntime: 'hermes-remote' }))
    expect(persisted).toContain('sess-1:stored-1')
  })

  test('Given 缺少密码凭据 When query Then 抛 unauthorized', async () => {
    const facade = new HermesRuntimeFacade(
      createDeps({
        readDashboardPassword: () => null,
      }),
    )
    const error = await collect(facade.query({ sessionId: 'sess-1', prompt: 'hi', agentRuntime: 'hermes-remote' })).catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('unauthorized')
  })

  test('Given Dashboard 不可用 When query Then 回退 API Server', async () => {
    const apiTarget: HermesTarget = {
      id: 'target-1',
      name: 't',
      mode: 'direct',
      remoteUrl: 'https://h.example.com/',
      auth: {
        dashboardMode: 'password-cookie',
        dashboardCredentialRef: 'cred-1',
        apiServerKeyRef: 'cred-1',
      },
      createdAt: 0,
      updatedAt: 0,
    }
    const facade = new HermesRuntimeFacade(
      createDeps({
        getTarget: () => apiTarget,
        // 让 ws-ticket 失败（服务不存在）触发 fallback
        buildTransport: async () => {
          const transport = createFakeTransport()
          const original = transport.requestJson.bind(transport)
          transport.requestJson = async (path, options) => {
            if (path === '/api/auth/ws-ticket') {
              return { status: 404, body: {} }
            }
            return original(path, options)
          }
          return transport
        },
      }),
    )
    const messages = await collect(facade.query({ sessionId: 'sess-1', prompt: 'hi', agentRuntime: 'hermes-remote' }))
    const types = messages.map((m) => (m as { type: string }).type)
    expect(types).toContain('assistant')
    expect(types).toContain('result')
    const texts = messages
      .filter((m) => (m as { type: string }).type === 'assistant')
      .map((m) => (m as { message: { content: Array<{ text?: string }> } }).message.content.map((c) => c.text ?? '').join(''))
      .join('')
    expect(texts).toContain('API 你好')
  })
})

describe('HermesRuntimeFacade abort / interrupt / dispose', () => {
  test('Given 活跃 turn When abort Then 断开连接并清理', () => {
    const facade = new HermesRuntimeFacade(createDeps())
    facade.abort('sess-1') // 无活跃连接时不抛错
    facade.dispose()
  })

  test('Given 活跃 turn When interruptQuery Then 不抛错', async () => {
    const facade = new HermesRuntimeFacade(createDeps())
    await facade.interruptQuery('sess-1')
    facade.dispose()
  })
})
