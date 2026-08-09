/**
 * Hermes API Server Adapter BDD 测试
 *
 * 覆盖：认证头、createRun、getRunStatus、SSE 事件订阅、approval、stop、错误映射。
 */

import { describe, expect, test } from 'bun:test'
import {
  HermesApiServerAdapter,
  buildApiServerAuthHeaders,
  parseRunCreated,
} from './hermes-api-server-adapter'
import { HermesError } from './hermes-errors'
import type { HermesJsonResponse, HermesSseHandle, HermesTransport } from './transport/hermes-transport'

describe('认证头与响应解析', () => {
  test('Given apiKey When 构建头 Then 生成 Bearer', () => {
    expect(buildApiServerAuthHeaders('sk-123').Authorization).toBe('Bearer sk-123')
  })

  test('Given 合法响应 When 解析 Then 返回 runId', () => {
    expect(parseRunCreated({ run_id: 'run_abc' }).runId).toBe('run_abc')
  })

  test('Given 缺少 run_id When 解析 Then 抛 invalid-response', () => {
    expect(() => parseRunCreated({})).toThrow('未返回 run_id')
  })
})

describe('HermesApiServerAdapter', () => {
  const createAdapter = (): {
    adapter: HermesApiServerAdapter
    sentAuth: string[]
    sentBodies: unknown[]
    respondWith: (handler: (path: string, body?: unknown) => HermesJsonResponse) => void
  } => {
    const sentAuth: string[] = []
    const sentBodies: unknown[] = []
    let handler: (path: string, body?: unknown) => HermesJsonResponse = () => ({ status: 404, body: {} })
    const transport: HermesTransport = {
      baseUrl: 'https://h.example.com/',
      requestJson: async (path, options) => {
        sentAuth.push(String(options?.headers?.Authorization ?? ''))
        sentBodies.push(options?.body)
        return handler(path, options?.body)
      },
      openSse: async (_path, options) => {
        const handle: HermesSseHandle = {
          abort: () => undefined,
          done: Promise.resolve(),
        }
        // 由测试自行调用 options.onEvent
        const sseEvents = (options as { __sse?: Array<{ data: string }> }).__sse ?? []
        for (const event of sseEvents) {
          options.onEvent({ data: event.data })
        }
        options.onEnd?.()
        return handle
      },
      connectWebSocket: async () => ({ socket: null, errorCode: null, errorMessage: null }),
      dispose: () => undefined,
    }
    const adapter = new HermesApiServerAdapter(transport, 'sk-123')
    return {
      adapter,
      sentAuth,
      sentBodies,
      respondWith: (newHandler) => {
        handler = newHandler
      },
    }
  }

  test('Given createRun When 调用 Then 发送 input 与 Bearer 头', async () => {
    const { adapter, sentAuth, sentBodies, respondWith } = createAdapter()
    respondWith((path, body) => {
      expect(path).toBe('/v1/runs')
      expect((body as { input: string }).input).toBe('你好')
      return { status: 202, body: { run_id: 'run_1' } }
    })
    const result = await adapter.createRun({ input: '你好' })
    expect(result.runId).toBe('run_1')
    expect(sentAuth[0]).toBe('Bearer sk-123')
    expect(sentBodies[0]).toEqual({ input: '你好' })
  })

  test('Given createRun 带完整字段 When 调用 Then 透传可选字段', async () => {
    const { adapter, respondWith } = createAdapter()
    respondWith((_path, body) => {
      const b = body as Record<string, unknown>
      expect(b.instructions).toBe('你是助手')
      expect(b.model).toBe('deepseek')
      expect(b.session_id).toBe('sess-1')
      expect(Array.isArray(b.conversation_history)).toBe(true)
      return { status: 202, body: { run_id: 'run_2' } }
    })
    const result = await adapter.createRun({
      input: 'hi',
      instructions: '你是助手',
      model: 'deepseek',
      sessionId: 'sess-1',
      conversationHistory: [{ role: 'user', content: 'hello' }],
    })
    expect(result.runId).toBe('run_2')
  })

  test('Given createRun 返回 401 When 调用 Then 抛 unauthorized', async () => {
    const { adapter, respondWith } = createAdapter()
    respondWith(() => ({ status: 401, body: {} }))
    const error = await adapter.createRun({ input: 'x' }).catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('unauthorized')
  })

  test('Given createRun 返回 400 When 调用 Then 抛 network 类错误', async () => {
    const { adapter, respondWith } = createAdapter()
    respondWith(() => ({ status: 400, body: { error: 'Missing input' } }))
    const error = await adapter.createRun({ input: '' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HermesError)
  })

  test('Given getRunStatus When 调用 Then 返回状态', async () => {
    const { adapter, respondWith } = createAdapter()
    respondWith(() => ({ status: 200, body: { status: 'completed' } }))
    expect(await adapter.getRunStatus('run_1')).toEqual({ status: 'completed' })
  })

  test('Given openRunEvents When 调用 Then 逐事件回调并附带 runId', async () => {
    const { adapter } = createAdapter()
    const events: Array<{ event: string; runId: string }> = []
    const handle = await adapter.openRunEvents('run_1', (event) => {
      events.push({ event: event.event, runId: event.runId })
    })
    // 直接通过 transport 注入的 __sse 不可行；改用真实 SSE 流模拟
    const transportMock = {
      baseUrl: '',
      requestJson: async () => ({ status: 200, body: {} }),
      openSse: async (_path: string, options: { onEvent: (e: { data: string }) => void; onEnd?: () => void }): Promise<HermesSseHandle> => {
        options.onEvent({ data: JSON.stringify({ event: 'message.delta', delta: 'hi' }) })
        options.onEvent({ data: JSON.stringify({ event: 'run.completed' }) })
        options.onEnd?.()
        return { abort: () => undefined, done: Promise.resolve() }
      },
      connectWebSocket: async () => ({ socket: null, errorCode: null, errorMessage: null }),
      dispose: () => undefined,
    }
    const realAdapter = new HermesApiServerAdapter(transportMock as unknown as HermesTransport, 'k')
    await realAdapter.openRunEvents('run_1', (event) => {
      events.push({ event: event.event, runId: event.runId })
    })
    expect(events).toEqual([
      { event: 'message.delta', runId: 'run_1' },
      { event: 'run.completed', runId: 'run_1' },
    ])
    expect(handle).toBeDefined()
  })

  test('Given respondApproval When 调用 Then 发送 choice', async () => {
    const { adapter, sentBodies, respondWith } = createAdapter()
    respondWith(() => ({ status: 200, body: { ok: true } }))
    await adapter.respondApproval('run_1', 'once')
    expect((sentBodies[0] as { choice: string }).choice).toBe('once')
  })

  test('Given respondApproval 非法 choice When 调用 Then 透传服务端错误', async () => {
    const { adapter, respondWith } = createAdapter()
    respondWith(() => ({ status: 400, body: { error: 'Invalid approval choice' } }))
    const error = await adapter.respondApproval('run_1', 'deny').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HermesError)
  })

  test('Given stopRun When 调用 Then 发送 stop', async () => {
    const { adapter, respondWith } = createAdapter()
    let stoppedPath = ''
    respondWith((path) => {
      stoppedPath = path
      return { status: 200, body: {} }
    })
    await adapter.stopRun('run_1')
    expect(stoppedPath).toBe('/v1/runs/run_1/stop')
  })

  test('Given stop ACK=stopping When stopRunAndWait Then 轮询到 cancelled 才返回', async () => {
    const { adapter, respondWith } = createAdapter()
    let statusReads = 0
    respondWith((path) => {
      if (path.endsWith('/stop')) return { status: 200, body: { status: 'stopping' } }
      statusReads += 1
      return { status: 200, body: { status: statusReads > 1 ? 'cancelled' : 'stopping' } }
    })
    expect(await adapter.stopRunAndWait('run_1', { pollIntervalMs: 1, timeoutMs: 100 })).toEqual({ status: 'cancelled' })
    expect(statusReads).toBe(2)
  })

  test('Given listCapabilities When 调用 Then 返回能力', async () => {
    const { adapter, respondWith } = createAdapter()
    respondWith(() => ({ status: 200, body: { capabilities: { runs: { method: 'POST', path: '/v1/runs' } } } }))
    const caps = await adapter.listCapabilities()
    expect((caps as { capabilities: object }).capabilities).toBeDefined()
  })
})
