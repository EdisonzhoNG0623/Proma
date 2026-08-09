import { describe, expect, test } from 'bun:test'
import type { AgentQueryInput, HermesProtocol, HermesTarget } from '@proma/shared'
import { HermesRuntimeFacade, resolveHermesSessionFilePath, type HermesRuntimeDeps, type HermesSessionBinding, validateHermesTurnAttachments } from './hermes-runtime-facade'
import { HermesDashboardConnectionBroker } from './hermes-dashboard-connection-broker'
import { HermesDashboardWsClient } from './hermes-dashboard-ws-client'
import { HermesEndpointManager } from './hermes-endpoint-manager'
import { HermesError } from './hermes-errors'
import type { HermesSseHandle, HermesTransport } from './transport/hermes-transport'

class FakeSocket extends EventTarget {
  requests: Array<{ method: string; params: Record<string, unknown> }> = []
  runtimeId = 'runtime-1'
  completeOnPrompt = true
  failFileAttach = false
  send(raw: string): void {
    const message = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }
    this.requests.push({ method: message.method, params: message.params })
    const reply = (result: unknown): void => queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: message.id, result }))
    if (message.method === 'session.create') reply({ session_id: this.runtimeId, stored_session_id: 'stored-1' })
    else if (message.method === 'session.resume') reply({ session_id: this.runtimeId, resumed: message.params.session_id })
    else if (message.method === 'image.attach_bytes') reply({ path: '/remote/image.png', text: '@image:/remote/image.png' })
    else if (message.method === 'file.attach' && this.failFileAttach) queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: message.id, error: { code: 5027, message: 'write failed' } }))
    else if (message.method === 'file.attach') reply({ path: '/remote/file.txt', ref_text: '@file:.hermes/desktop-attachments/file.txt' })
    else if (message.method === 'prompt.submit') {
      reply({ status: 'streaming' })
      if (this.completeOnPrompt) setTimeout(() => {
        this.event('message.delta', { text: 'Hermes 回复' })
        this.event('message.complete', { text: 'Hermes 回复', status: 'complete' })
      }, 2)
    } else if (message.method === 'session.interrupt') {
      reply({ status: 'interrupted' })
      setTimeout(() => this.event('message.complete', { status: 'error', text: 'interrupted' }), 1)
    } else reply({})
  }
  close(): void { this.dispatchEvent(new Event('close')) }
  emit(value: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  event(type: string, payload: unknown): void {
    this.emit({ jsonrpc: '2.0', method: 'event', params: { type, session_id: this.runtimeId, payload } })
  }
}

const target: HermesTarget = {
  id: 'target-1', name: 'remote', mode: 'direct',
  endpoints: {
    dashboard: { baseUrl: 'https://dashboard.example.com/root' },
    apiServer: { baseUrl: 'https://api.example.com:8642/root' },
  },
  auth: {}, createdAt: 1, updatedAt: 1,
}

function inertTransport(baseUrl: string): HermesTransport {
  return {
    baseUrl,
    requestJson: async () => ({ status: 404, body: {} }),
    openSse: async () => ({ abort: () => undefined, done: Promise.resolve() }),
    connectWebSocket: async () => ({ socket: null, errorCode: 'network', errorMessage: 'unused' }),
    dispose: () => undefined,
  }
}

function harness(options: { protocol?: HermesProtocol; dashboardFailure?: boolean; deferDashboard?: boolean; deferApi?: boolean; rejectBindingCas?: boolean; failAttachment?: boolean; existingRemoteSession?: boolean } = {}) {
  const socket = new FakeSocket()
  socket.completeOnPrompt = !options.deferDashboard
  socket.failFileAttach = options.failAttachment === true
  const apiPaths: string[] = []
  let stopped = false
  let persisted = ''
  let resolveApiSse: (() => void) | null = null
  const endpointManager = new HermesEndpointManager({
    build: async () => ({ dashboard: inertTransport('https://dashboard.example.com/root/'), dispose: async () => undefined }),
  })
  const broker = new HermesDashboardConnectionBroker({
    endpointManager,
    readyTimeoutMs: 20,
    prepareConnection: async (_target, _transport, onClose) => {
      if (options.dashboardFailure) throw new HermesError('dashboard unavailable', 'network')
      const ready = new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }) })
      return {
        url: 'wss://dashboard.example.com/root/api/ws',
        client: new HermesDashboardWsClient(async () => ({ socket: socket as unknown as WebSocket, errorCode: null, errorMessage: null, bufferedMessages: [ready] }), onClose),
      }
    },
  })
  const apiTransport: HermesTransport = {
    baseUrl: 'https://api.example.com:8642/root/',
    requestJson: async (path, request) => {
      apiPaths.push(`${request?.method ?? 'GET'} ${path}`)
      if (path === '/v1/runs') return { status: 202, body: { run_id: 'api-run-1' } }
      if (path === '/v1/runs/api-run-1/stop') { stopped = true; return { status: 200, body: { status: 'stopping' } } }
      if (path === '/v1/runs/api-run-1') { resolveApiSse?.(); return { status: 200, body: { status: 'cancelled' } } }
      if (path.startsWith('/api/media')) return { status: 200, body: { data_url: 'data:image/png;base64,eA==' } }
      if (path.startsWith('/api/sessions/stored-1')) return { status: 200, body: { cwd: '/srv/workspace' } }
      if (path.startsWith('/api/fs/read-data-url')) return { status: 200, body: { dataUrl: 'data:application/octet-stream;base64,eA==' } }
      return { status: 404, body: {} }
    },
    openSse: async (_path, streamOptions): Promise<HermesSseHandle> => {
      if (!options.deferApi) {
        streamOptions.onEvent({ data: JSON.stringify({ event: 'message.delta', delta: 'API 回复' }) })
        streamOptions.onEvent({ data: JSON.stringify({ event: 'run.completed' }) })
        streamOptions.onEnd?.()
        return { abort: () => undefined, done: Promise.resolve() }
      }
      const done = new Promise<void>((resolve) => { resolveApiSse = resolve })
      return { abort: () => { resolveApiSse?.() }, done }
    },
    connectWebSocket: async () => ({ socket: null, errorCode: 'network', errorMessage: 'unused' }),
    dispose: () => undefined,
  }
  const bindings = new Map<string, HermesSessionBinding>([['session-1', {
    targetId: target.id,
    protocol: options.protocol ?? 'dashboard',
    profile: 'work',
    ...(options.existingRemoteSession ? { remoteSessionId: 'stored-1' } : {}),
  }]])
  const deps: HermesRuntimeDeps = {
    getTarget: (id) => id === target.id ? target : null,
    getBinding: (id) => bindings.get(id) ?? null,
    persistRemoteSessionId: (_id, remote) => {
      if (options.rejectBindingCas) return false
      persisted = remote
      return true
    },
    getTargetCredential: (_id, slot) => slot === 'api-server-key' ? 'api-key' : null,
    buildTransport: async (_target, protocol = 'dashboard') => protocol === 'api-server' ? apiTransport : apiTransport,
    dashboardBroker: broker,
  }
  return {
    facade: new HermesRuntimeFacade(deps), socket, apiPaths, broker, endpointManager,
    get persisted() { return persisted },
    get stopped() { return stopped },
  }
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const output: unknown[] = []
  for await (const item of iterable) output.push(item)
  return output
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('wait timeout')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const input = (overrides: Partial<AgentQueryInput> = {}): AgentQueryInput => ({
  sessionId: 'session-1', prompt: '你好', agentRuntime: 'hermes-remote', ...overrides,
})

describe('HermesRuntimeFacade explicit protocol + atomic turn', () => {
  test('Given 未绑定 When query Then fail closed', async () => {
    const ctx = harness()
    const error = await collect(ctx.facade.query(input({ sessionId: 'missing' }))).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(HermesError)
    ctx.facade.dispose()
  })

  test('Given Dashboard text+attachments When query Then attach 全成功后只 submit 一次', async () => {
    const ctx = harness()
    const submitStates: string[] = []
    const messages = await collect(ctx.facade.query(input({
      hermesTurn: {
        clientMessageId: 'client-1',
        attachments: [
          { id: 'i1', kind: 'image', name: 'image.png', mimeType: 'image/png', base64: 'eA==' },
          { id: 'f1', kind: 'file', name: 'file.txt', mimeType: 'text/plain', base64: 'eA==' },
        ],
      },
      onHermesTurnSubmitState: (state) => submitStates.push(state.status),
    })))
    expect(ctx.socket.requests.map((request) => request.method)).toEqual([
      'session.create', 'image.attach_bytes', 'file.attach', 'prompt.submit',
    ])
    const prompt = ctx.socket.requests.at(-1)!.params.text as string
    expect(prompt).toContain('你好')
    expect(prompt).toContain('@image:/remote/image.png')
    expect(prompt).toContain('@file:.hermes/desktop-attachments/file.txt')
    expect(ctx.persisted).toBe('stored-1')
    expect(submitStates).toEqual(['accepted'])
    expect(messages.some((message) => (message as { type: string }).type === 'assistant')).toBe(true)
    ctx.facade.dispose()
  })

  test('Given 第 N 个附件失败 When query Then 不 submit 且只上报 rejected', async () => {
    const ctx = harness({ failAttachment: true })
    const states: string[] = []
    const error = await collect(ctx.facade.query(input({
      hermesTurn: {
        clientMessageId: 'client-fail',
        attachments: [
          { id: 'i', kind: 'image', name: 'x.png', mimeType: 'image/png', base64: 'eA==' },
          { id: 'f', kind: 'file', name: 'x.txt', mimeType: 'text/plain', base64: 'eA==' },
        ],
      },
      onHermesTurnSubmitState: (state) => states.push(state.status),
    }))).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(HermesError)
    expect(ctx.socket.requests.some((request) => request.method === 'prompt.submit')).toBe(false)
    expect(states).toEqual(['rejected'])
    ctx.facade.dispose()
  })

  test('Given image-only turn When query Then 仅持久化 canonical @image 指令且不补问句', async () => {
    const ctx = harness()
    await collect(ctx.facade.query(input({ prompt: '', hermesTurn: {
      clientMessageId: 'client-2',
      attachments: [{ id: 'i1', kind: 'image', name: 'image.png', mimeType: 'image/png', base64: 'eA==' }],
    } })))
    expect(ctx.socket.requests.at(-1)!.params.text).toBe('@image:/remote/image.png')
    ctx.facade.dispose()
  })

  test('Given create 期间 binding 已切换 When CAS 失败 Then 不 attach/submit 旧 session', async () => {
    const ctx = harness({ rejectBindingCas: true })
    const error = await collect(ctx.facade.query(input({ hermesTurn: {
      clientMessageId: 'stale-binding',
      attachments: [{ id: 'i', kind: 'image', name: 'x.png', mimeType: 'image/png', base64: 'eA==' }],
    } }))).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(HermesError)
    expect(ctx.socket.requests.map((request) => request.method)).toEqual(['session.create'])
    ctx.facade.dispose()
  })

  test('Given Dashboard 失败且 API 可用 When protocol=dashboard Then 不透明 fallback', async () => {
    const ctx = harness({ dashboardFailure: true })
    const error = await collect(ctx.facade.query(input())).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(HermesError)
    expect(ctx.apiPaths).toEqual([])
    ctx.facade.dispose()
  })

  test('Given protocol=api-server When query Then 只调用 API endpoint', async () => {
    const ctx = harness({ protocol: 'api-server' })
    const messages = await collect(ctx.facade.query(input()))
    expect(ctx.socket.requests).toHaveLength(0)
    expect(ctx.apiPaths).toContain('POST /v1/runs')
    expect(messages.some((message) => (message as { type: string }).type === 'assistant')).toBe(true)
    ctx.facade.dispose()
  })
})

describe('HermesRuntimeFacade stop / security', () => {
  test('Given Dashboard active turn When interrupt Then 调用 session.interrupt 而非关闭 WS', async () => {
    const ctx = harness({ deferDashboard: true })
    const running = collect(ctx.facade.query(input()))
    await waitFor(() => ctx.socket.requests.some((request) => request.method === 'prompt.submit'))
    await ctx.facade.interruptQuery('session-1')
    await running
    expect(ctx.socket.requests.some((request) => request.method === 'session.interrupt')).toBe(true)
    ctx.facade.dispose()
  })

  test('Given API active run When interrupt Then POST /stop', async () => {
    const ctx = harness({ protocol: 'api-server', deferApi: true })
    const running = collect(ctx.facade.query(input()))
    await waitFor(() => ctx.apiPaths.includes('POST /v1/runs'))
    await ctx.facade.interruptQuery('session-1')
    await running
    expect(ctx.apiPaths).toContain('POST /v1/runs/api-run-1/stop')
    expect(ctx.stopped).toBe(true)
    ctx.facade.dispose()
  })

  test('Given oversized attachment When validate Then 在 remote I/O 前拒绝', () => {
    const tooLarge = 'A'.repeat(Math.ceil((25 * 1024 * 1024 + 1) * 4 / 3))
    expect(() => validateHermesTurnAttachments([{ id: 'x', kind: 'file', name: 'x', mimeType: 'application/octet-stream', base64: tooLarge }])).toThrow('25 MiB')
  })

  test('Given first turn carries attachment When accepted Then 创建和附件属于同一 stored session', async () => {
    const ctx = harness()
    await collect(ctx.facade.query(input({ hermesTurn: {
      clientMessageId: 'first-attachment',
      attachments: [{ id: 'i', kind: 'image', name: 'image.png', mimeType: 'image/png', base64: 'eA==' }],
    } })))
    expect(ctx.persisted).toBe('stored-1')
    expect(ctx.socket.requests.map((request) => request.method).slice(0, 3)).toEqual(['session.create', 'image.attach_bytes', 'prompt.submit'])
    ctx.facade.dispose()
  })

  test('Given @file ref When fetchAttachment Then 绑定 session cwd 并读取 data URL', async () => {
    const ctx = harness({ existingRemoteSession: true })
    const result = await ctx.facade.fetchAttachment('session-1', '.hermes/desktop-attachments/report.xlsx')
    expect(result?.name).toBe('report.xlsx')
    expect(result?.dataUrl).toBe('data:application/octet-stream;base64,eA==')
    expect(ctx.apiPaths).toContain('GET /api/sessions/stored-1?profile=work')
    expect(ctx.apiPaths.some((path) => path.includes('/api/fs/read-data-url?path=%2Fsrv%2Fworkspace%2F.hermes%2Fdesktop-attachments%2Freport.xlsx'))).toBe(true)
    ctx.facade.dispose()
  })

  test('Given traversal @file ref When resolve Then fail closed', () => {
    expect(() => resolveHermesSessionFilePath('/srv/workspace', '../secret.txt')).toThrow('越出远端会话目录')
    expect(resolveHermesSessionFilePath('/srv/workspace', '.hermes/a.txt')).toBe('/srv/workspace/.hermes/a.txt')
  })

  test('Given target missing When fetchMedia Then null', async () => {
    const ctx = harness()
    expect(await ctx.facade.fetchMedia('missing', '/x')).toBeNull()
    ctx.facade.dispose()
  })
})
