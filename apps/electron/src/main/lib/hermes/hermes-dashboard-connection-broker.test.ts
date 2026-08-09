import { describe, expect, test } from 'bun:test'
import type { HermesTarget } from '@proma/shared'
import { HermesEndpointManager } from './hermes-endpoint-manager'
import { HermesDashboardWsClient } from './hermes-dashboard-ws-client'
import { HermesDashboardConnectionBroker } from './hermes-dashboard-connection-broker'
import type { HermesTransport } from './transport/hermes-transport'

class FakeSocket extends EventTarget {
  sent: Array<Record<string, unknown>> = []
  closed = false
  autoRespond = true
  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>
    this.sent.push(message)
    if (this.autoRespond && message.id !== undefined) {
      const method = message.method
      const params = message.params as Record<string, unknown>
      queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: message.id, result:
        method === 'session.resume'
          ? { session_id: `runtime-${this.sent.length}`, stored_session_id: params.session_id }
          : {} }))
    }
  }
  close(): void { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event('close')) } }
  emit(value: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  ready(): void { this.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { change_events: true } } }) }
  sessionEvent(sessionId: string, type: string, payload: unknown): void {
    this.emit({ jsonrpc: '2.0', method: 'event', params: { type, session_id: sessionId, payload } })
  }
}

const target: HermesTarget = {
  id: 't1', name: 'remote', mode: 'direct',
  endpoints: { dashboard: { baseUrl: 'https://d.example.com' } },
  auth: {}, createdAt: 1, updatedAt: 1,
}

const fakeTransport: HermesTransport = {
  baseUrl: 'https://d.example.com/',
  requestJson: async () => ({ status: 200, body: {} }),
  openSse: async () => ({ abort: () => undefined, done: Promise.resolve() }),
  connectWebSocket: async () => ({ socket: null, errorCode: null, errorMessage: null }),
  dispose: () => undefined,
}

function setup(options: { emitReady?: boolean; reconnectDelayMs?: number; connectError?: Error; connectFailures?: number } = {}) {
  const sockets: FakeSocket[] = []
  let prepares = 0
  let connectFailuresRemaining = options.connectFailures ?? 0
  const endpoints = new HermesEndpointManager({
    idleTtlMs: 1_000,
    build: async () => ({ dashboard: fakeTransport, dispose: async () => undefined }),
  })
  const broker = new HermesDashboardConnectionBroker({
    endpointManager: endpoints,
    readyTimeoutMs: 25,
    reconnectDelayMs: options.reconnectDelayMs ?? 0,
    prepareConnection: async (_target, _transport, onClose) => {
      prepares += 1
      const socket = new FakeSocket()
      sockets.push(socket)
      const client = new HermesDashboardWsClient(async () => {
        if (options.connectError) throw options.connectError
        if (connectFailuresRemaining > 0) {
          connectFailuresRemaining -= 1
          throw new Error('transient connect failure')
        }
        const bufferedMessages = options.emitReady === false
          ? []
          : [new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { change_events: true } } }) })]
        return { socket: socket as unknown as WebSocket, errorCode: null, errorMessage: null, bufferedMessages }
      }, onClose)
      return { client, url: 'wss://d.example.com/api/ws' }
    },
  })
  return { broker, endpoints, sockets, get prepares() { return prepares } }
}

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('wait timeout')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('HermesDashboardConnectionBroker', () => {
  test('Given 同 target 并发 acquire When ready Then 只建立一个 WS', async () => {
    const ctx = setup()
    const [a, b] = await Promise.all([ctx.broker.acquire(target), ctx.broker.acquire(target)])
    expect(ctx.prepares).toBe(1)
    expect(a.generation).toBe(b.generation)
    a.release(); b.release()
    await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })

  test('Given 未收到 gateway.ready When acquire Then fail closed 并关闭 socket', async () => {
    const ctx = setup({ emitReady: false })
    await expect(ctx.broker.acquire(target)).rejects.toThrow('gateway.ready')
    expect(ctx.sockets[0]?.closed).toBe(true)
    await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })

  test('Given WebSocket connect 先失败 When ready timer 到期 Then 不产生未处理拒绝', async () => {
    const ctx = setup({ connectError: new Error('connect failed') })
    await expect(ctx.broker.acquire(target)).rejects.toThrow('connect failed')
    await new Promise((resolve) => setTimeout(resolve, 40))
    await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })

  test('Given 首次连接失败关闭 entry When 再次 acquire Then 创建新 entry 并恢复', async () => {
    const ctx = setup({ connectFailures: 1 })
    await expect(ctx.broker.acquire(target)).rejects.toThrow('transient connect failure')
    const lease = await ctx.broker.acquire(target)
    expect(ctx.prepares).toBe(2)
    expect(lease.generation).toBe(1)
    lease.release()
    await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })

  test('Given session subscriber When 收到其他 session/global event Then 不串线', async () => {
    const ctx = setup()
    const lease = await ctx.broker.acquire(target)
    lease.trackSession('binding-a', 'stored-a', {}, undefined, 'runtime-a')
    const seen: string[] = []
    const off = lease.subscribeSession('binding-a', (event) => seen.push(event.type))
    ctx.sockets[0]!.sessionEvent('runtime-b', 'message.delta', { text: 'wrong' })
    ctx.sockets[0]!.ready()
    ctx.sockets[0]!.sessionEvent('runtime-a', 'message.delta', { text: 'right' })
    expect(seen).toEqual(['message.delta'])
    off(); lease.release()
    await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })

  test('Given live lease + tracked stored session When socket closes Then 新 ticket/WS generation 并 resume', async () => {
    const ctx = setup({ reconnectDelayMs: 0 })
    const lease = await ctx.broker.acquire(target)
    const resumed: string[] = []
    const seen: string[] = []
    lease.trackSession('binding-a', 'stored-a', { profile: 'work' }, (result) => resumed.push(result.sessionId), 'runtime-old')
    const off = lease.subscribeSession('binding-a', (event) => seen.push(String((event.payload as { text?: unknown })?.text ?? '')))
    ctx.sockets[0]!.close()
    await waitFor(() => ctx.prepares === 2 && resumed.length === 1)
    expect(ctx.sockets[1]?.sent.some((message) => message.method === 'session.resume')).toBe(true)
    expect(resumed[0]).toStartWith('runtime-')
    ctx.sockets[0]!.sessionEvent('runtime-old', 'message.delta', { text: 'stale' })
    ctx.sockets[1]!.sessionEvent(resumed[0]!, 'message.delta', { text: 'fresh' })
    expect(seen).toEqual(['fresh'])
    await lease.withAdapter(async (adapter) => adapter.interruptSession(resumed[0]!))
    off(); lease.release()
    await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })
})
