/**
 * Hermes Direct Transport BDD 测试
 *
 * 覆盖：URL 拼接、JSON 请求与错误映射、SSE 解析、WebSocket 连接。
 * 通过注入 mock fetch / WebSocket 避免真实网络。
 */

import { describe, expect, test } from 'bun:test'
import {
  HermesDirectTransport,
  joinPath,
  normalizeBaseUrl,
  parseSseBuffer,
} from './hermes-direct-transport'
import { HermesError } from '../hermes-errors'

describe('HermesDirectTransport URL 工具', () => {
  test('Given 带尾斜杠 base When 归一化 Then 保留根路径', () => {
    expect(normalizeBaseUrl('https://hermes.example.com')).toBe('https://hermes.example.com/')
    expect(normalizeBaseUrl('http://127.0.0.1:9119/')).toBe('http://127.0.0.1:9119/')
  })

  test('Given 相对路径 When 拼接 Then 拼在 base 之后', () => {
    expect(joinPath('https://h.example.com/', 'api/status')).toBe(
      'https://h.example.com/api/status',
    )
  })

  test('Given reverse-proxy base 与 / 路径 When 拼接 Then 保留 path prefix', () => {
    expect(joinPath('https://h.example.com/base/', '/v1/capabilities')).toBe(
      'https://h.example.com/base/v1/capabilities',
    )
  })

  test('Given 绝对路径 When 拼接 Then 原样返回', () => {
    expect(joinPath('https://h.example.com/', 'https://other.example.com/x')).toBe(
      'https://other.example.com/x',
    )
  })
})

describe('HermesDirectTransport requestJson', () => {
  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status })

  test('Given 远端返回 JSON When 请求 Then 返回状态与 body', async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse(200, { version: '0.20.0', auth_required: false })
    const transport = new HermesDirectTransport('https://h.example.com', { fetchImpl })
    const result = await transport.requestJson('/api/status')
    expect(result.status).toBe(200)
    expect((result.body as { version: string }).version).toBe('0.20.0')
  })

  test('Given POST JSON 请求 When 请求 Then 序列化 body 并带 Content-Type', async () => {
    let sentBody = ''
    let sentHeaders: Record<string, string> = {}
    const fetchImpl = async (
      _url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      sentBody = String(init?.body)
      sentHeaders = (init?.headers as Record<string, string>) ?? {}
      return jsonResponse(200, { ok: true })
    }
    const transport = new HermesDirectTransport('https://h.example.com', { fetchImpl })
    await transport.requestJson('/auth/password-login', {
      method: 'POST',
      body: { provider: 'basic', username: 'u', password: 'p' },
    })
    expect(sentBody).toBe(JSON.stringify({ provider: 'basic', username: 'u', password: 'p' }))
    expect(sentHeaders['Content-Type']).toBe('application/json')
  })

  test('Given 远端返回非 JSON When 请求 Then 抛 protocol-incompatible', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('<html>login page</html>', { status: 200 })
    const transport = new HermesDirectTransport('https://h.example.com', { fetchImpl })
    const error = await transport.requestJson('/api/status').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HermesError)
    expect((error as HermesError).code).toBe('protocol-incompatible')
  })

  test('Given 远端返回 401 When 请求 Then 返回状态码 401（错误映射由调用方决策）', async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse(401, {})
    const transport = new HermesDirectTransport('https://h.example.com', { fetchImpl })
    const result = await transport.requestJson('/api/status')
    expect(result.status).toBe(401)
  })

  test('Given 请求超时 When 请求 Then 抛 timeout', async () => {
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => {
          const abortError = new Error('aborted')
          abortError.name = 'AbortError'
          reject(abortError)
        })
      })
    const transport = new HermesDirectTransport('https://h.example.com', { fetchImpl })
    const error = await transport.requestJson('/api/status', { timeoutMs: 20 }).catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('timeout')
  })

  test('Given TLS 证书错误 When 请求 Then 抛 tls', async () => {
    const cause = new Error('self-signed certificate')
    ;(cause as Error & { code?: string }).code = 'DEPTH_ZERO_SELF_SIGNED_CERT'
    const fetchImpl = async (): Promise<Response> => {
      throw new TypeError('fetch failed', { cause })
    }
    const transport = new HermesDirectTransport('https://h.example.com', { fetchImpl })
    const error = await transport.requestJson('/api/status').catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('tls')
  })

  test('Given 网络错误 When 请求 Then 抛 network', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new TypeError('fetch failed')
    }
    const transport = new HermesDirectTransport('https://h.example.com', { fetchImpl })
    const error = await transport.requestJson('/api/status').catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('network')
  })
})

describe('parseSseBuffer SSE 解析', () => {
  test('Given 单 data 事件 When 解析 Then 回调 event 数据', () => {
    const events: Array<{ id?: string; event?: string; data: string }> = []
    parseSseBuffer('data: hello\n\n', (event) => events.push(event))
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('hello')
    expect(events[0]?.event).toBeUndefined()
  })

  test('Given 多行 data When 解析 Then 以换行拼接', () => {
    const events: Array<{ data: string }> = []
    parseSseBuffer('data: line1\ndata: line2\n\n', (event) => events.push(event))
    expect(events[0]?.data).toBe('line1\nline2')
  })

  test('Given event 与 id 字段 When 解析 Then 保留类型与 id', () => {
    const events: Array<{ id?: string; event?: string; data: string }> = []
    parseSseBuffer('id: 42\nevent: message.start\ndata: {"x":1}\n\n', (event) =>
      events.push(event),
    )
    expect(events[0]?.id).toBe('42')
    expect(events[0]?.event).toBe('message.start')
    expect(events[0]?.data).toBe('{"x":1}')
  })

  test('Given 注释行与未知字段 When 解析 Then 忽略', () => {
    const events: Array<{ data: string }> = []
    parseSseBuffer(': heartbeat\nfoo: bar\ndata: ok\n\n', (event) => events.push(event))
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('ok')
  })

  test('Given 无尾随空行 When 解析 Then 结束时 flush 最后事件', () => {
    const events: Array<{ data: string }> = []
    parseSseBuffer('data: last', (event) => events.push(event))
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('last')
  })

  test('Given 多个事件 When 解析 Then 逐个回调', () => {
    const events: Array<{ data: string }> = []
    parseSseBuffer('data: a\n\ndata: b\n\n', (event) => events.push(event))
    expect(events.map((event) => event.data)).toEqual(['a', 'b'])
  })
})

describe('HermesDirectTransport openSse', () => {
  test('Given SSE 流 When 打开 Then 逐事件回调并触发 onEnd', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: {"b":2}\n\n'))
        controller.close()
      },
    })
    const fetchImpl = async (): Promise<Response> =>
      new Response(stream, { status: 200 })
    const transport = new HermesDirectTransport('https://h.example.com', { fetchImpl })
    const events: string[] = []
    let ended = false
    const handle = await transport.openSse('/api/stream', {
      onEvent: (event) => events.push(event.data),
      onEnd: () => {
        ended = true
      },
    })
    await handle.done
    expect(events).toEqual(['{"a":1}', '{"b":2}'])
    expect(ended).toBe(true)
  })

  test('Given SSE 读取中断 When 等待 done Then reject 而非伪装正常结束', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() { throw new Error('socket reset') },
    })
    const transport = new HermesDirectTransport('https://h.example.com', {
      fetchImpl: async () => new Response(stream, { status: 200 }),
    })
    const handle = await transport.openSse('/stream', { onEvent: () => undefined })
    expect(handle.done).rejects.toThrow('socket reset')
    await handle.done.catch(() => undefined)
  })

  test('Given SSE 返回 401 When 打开 Then 拒绝 unauthorized', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('{}', { status: 401 })
    const transport = new HermesDirectTransport('https://h.example.com', { fetchImpl })
    const error = await transport
      .openSse('/api/stream', { onEvent: () => undefined })
      .catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('unauthorized')
  })
})

describe('HermesDirectTransport connectWebSocket', () => {
  class FakeWebSocket extends EventTarget {
    static instances: FakeWebSocket[] = []
    url: string
    readyState = 0
    constructor(url: string) {
      super()
      this.url = url
      FakeWebSocket.instances.push(this)
    }
    open(): void {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    }
    message(data: string): void {
      this.dispatchEvent(new MessageEvent('message', { data }))
    }
    fail(): void {
      this.dispatchEvent(new Event('error'))
    }
    close(): void {
      this.readyState = 3
      this.dispatchEvent(new Event('close'))
    }
  }

  test('Given WebSocket 打开成功 When 连接 Then 返回 socket 并切换 wss 协议', async () => {
    FakeWebSocket.instances = []
    const transport = new HermesDirectTransport('https://h.example.com', {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const promise = transport.connectWebSocket('/api/ws?ticket=t')
    queueMicrotask(() => FakeWebSocket.instances[0]?.open())
    const result = await promise
    expect(result.socket).not.toBeNull()
    expect(FakeWebSocket.instances[0]?.url).toBe('wss://h.example.com/api/ws?ticket=t')
  })

  test('Given gateway.ready 紧随 open When 上层尚未装 listener Then transport 缓冲早到消息', async () => {
    FakeWebSocket.instances = []
    const transport = new HermesDirectTransport('https://h.example.com', {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const promise = transport.connectWebSocket('/api/ws')
    queueMicrotask(() => {
      const socket = FakeWebSocket.instances[0]!
      socket.open()
      socket.message('{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready"}}')
    })
    const result = await promise
    result.stopBuffering?.()
    expect(result.bufferedMessages?.map((event) => event.data)).toContain('{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready"}}')
  })

  test('Given WebSocket 构造器同步抛错 When 连接 Then 返回 network 且无 timer TDZ', async () => {
    class ThrowingWebSocket {
      constructor() { throw new Error('bad url') }
    }
    const transport = new HermesDirectTransport('https://h.example.com/base/', {
      WebSocketImpl: ThrowingWebSocket as unknown as typeof WebSocket,
    })
    const result = await transport.connectWebSocket('/api/ws')
    expect(result.errorCode).toBe('network')
    expect(result.errorMessage).toContain('构造失败')
  })

  test('Given WebSocket 失败 When 连接 Then 返回 network 错误码', async () => {
    FakeWebSocket.instances = []
    const transport = new HermesDirectTransport('http://127.0.0.1:9119/', {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const promise = transport.connectWebSocket('/api/ws')
    queueMicrotask(() => FakeWebSocket.instances[0]?.fail())
    const result = await promise
    expect(result.socket).toBeNull()
    expect(result.errorCode).toBe('network')
  })

  test('Given 超时未打开 When 连接 Then 返回 timeout', async () => {
    FakeWebSocket.instances = []
    const transport = new HermesDirectTransport('http://127.0.0.1:9119/', {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const result = await transport.connectWebSocket('/api/ws', { timeoutMs: 15 })
    expect(result.socket).toBeNull()
    expect(result.errorCode).toBe('timeout')
  })
})
