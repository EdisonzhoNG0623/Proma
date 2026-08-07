/**
 * Hermes Dashboard WS 客户端与 Adapter BDD 测试
 *
 * 覆盖：JSON-RPC 请求/响应、notification 分发、超时、断线、session create/resume、
 * prompt.submit、approval/clarify/sudo/secret 响应、响应解析。
 */

import { describe, expect, test } from 'bun:test'
import { HermesDashboardWsClient } from './hermes-dashboard-ws-client'
import {
  HermesDashboardAdapter,
  parseSessionResult,
  parseProjectTree,
  parseSessionList,
  parseHistoryMessages,
} from './hermes-dashboard-adapter'
import { HermesError } from './hermes-errors'

/** fake WebSocket（支持 message/close 事件与 send 捕获） */
class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = []
  sent: string[] = []
  closed = false
  constructor() {
    super()
    FakeWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.dispatchEvent(new Event('close'))
  }
  emitMessage(data: unknown): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }),
    )
  }
}

const createClient = (): { client: HermesDashboardWsClient; socket: FakeWebSocket } => {
  FakeWebSocket.instances = []
  const socket = new FakeWebSocket()
  const connector = async (): Promise<{ socket: WebSocket; errorCode: null; errorMessage: null }> => ({
    socket: socket as unknown as WebSocket,
    errorCode: null,
    errorMessage: null,
  })
  const client = new HermesDashboardWsClient(connector)
  return { client, socket }
}

const connectClient = async (): Promise<{ client: HermesDashboardWsClient; socket: FakeWebSocket }> => {
  const ctx = createClient()
  await ctx.client.connect('ws://h.example.com/api/ws')
  return ctx
}

describe('HermesDashboardWsClient JSON-RPC', () => {
  test('Given 已连接 When 请求 Then 发送 JSON-RPC 并等待 result', async () => {
    const { client, socket } = await connectClient()
    const promise = client.request('session.create', { cols: 96 })
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.jsonrpc).toBe('2.0')
    expect(sent.method).toBe('session.create')
    expect(sent.params).toEqual({ cols: 96 })
    expect(sent.id).toBe(1)
    socket.emitMessage({ jsonrpc: '2.0', id: 1, result: { session_id: 'abc' } })
    expect(await promise).toEqual({ session_id: 'abc' })
  })

  test('Given 服务端返回 error When 请求 Then reject HermesError', async () => {
    const { client, socket } = await connectClient()
    const promise = client.request('prompt.submit', { session_id: 's' })
    socket.emitMessage({
      jsonrpc: '2.0',
      id: 1,
      error: { code: 4001, message: 'session not found' },
    })
    const error = await promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HermesError)
  })

  test('Given 无响应 When 请求超时 Then reject timeout', async () => {
    const { client } = await connectClient()
    const error = await client
      .request('prompt.submit', {}, { timeoutMs: 20 })
      .catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('timeout')
  })

  test('Given 收到 notification When 已注册处理器 Then 分发 method 与 params', async () => {
    const { client, socket } = await connectClient()
    const events: Array<{ method: string; params: unknown }> = []
    client.onNotification((method, params) => events.push({ method, params }))
    socket.emitMessage({
      jsonrpc: '2.0',
      method: 'message.delta',
      params: { text: 'hi' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.method).toBe('message.delta')
    expect((events[0]?.params as { text: string }).text).toBe('hi')
  })

  test('Given 取消处理器 When 再收到通知 Then 不再分发', async () => {
    const { client, socket } = await connectClient()
    let count = 0
    const off = client.onNotification(() => {
      count += 1
    })
    off()
    socket.emitMessage({ jsonrpc: '2.0', method: 'x', params: {} })
    expect(count).toBe(0)
  })

  test('Given 连接断开 When 有 pending 请求 Then reject network', async () => {
    const { client, socket } = await connectClient()
    const promise = client.request('prompt.submit', {})
    socket.close()
    const error = await promise.catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('network')
    expect(client.isConnected).toBe(false)
  })

  test('Given 未连接 When 请求 Then reject network', async () => {
    const { client } = createClient()
    const error = await client.request('x', {}).catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('network')
  })

  test('Given 连接失败 When connect Then reject network', async () => {
    const connector = async (): Promise<{ socket: null; errorCode: 'network'; errorMessage: string }> => ({
      socket: null,
      errorCode: 'network',
      errorMessage: 'connection refused',
    })
    const client = new HermesDashboardWsClient(connector)
    const error = await client.connect('ws://h').catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('network')
  })

  test('Given 非 JSON 消息 When 收到 Then 忽略', async () => {
    const { client, socket } = await connectClient()
    const events: string[] = []
    client.onNotification((method) => events.push(method))
    socket.emitMessage(': ping')
    expect(events).toHaveLength(0)
  })
})

describe('HermesDashboardAdapter 会话与交互', () => {
  const setupAdapter = async (): Promise<{ adapter: HermesDashboardAdapter; socket: FakeWebSocket }> => {
    const { client, socket } = await connectClient()
    return { adapter: new HermesDashboardAdapter(client), socket }
  }

  test('Given createSession When 调用 Then 返回 runtime 与 stored session', async () => {
    const { adapter, socket } = await setupAdapter()
    const promise = adapter.createSession({ profile: 'work', cwd: '/srv' })
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.params).toMatchObject({ cols: 96, profile: 'work', cwd: '/srv' })
    socket.emitMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { session_id: 'run-1', stored_session_id: 'stored-1' },
    })
    const result = await promise
    expect(result.sessionId).toBe('run-1')
    expect(result.storedSessionId).toBe('stored-1')
    expect(result.created).toBe(true)
  })

  test('Given resumeSession When 调用 Then 发送 stored id 且 created=false', async () => {
    const { adapter, socket } = await setupAdapter()
    const promise = adapter.resumeSession('stored-1', { profile: 'work' })
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.params).toMatchObject({ session_id: 'stored-1' })
    socket.emitMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { session_id: 'run-2', resumed: 'stored-1' },
    })
    const result = await promise
    expect(result.created).toBe(false)
    expect(result.storedSessionId).toBe('stored-1')
  })

  test('Given submitPrompt When 调用 Then 发送 text 与 profile', async () => {
    const { adapter, socket } = await setupAdapter()
    const promise = adapter.submitPrompt('run-1', '你好', 'work')
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.method).toBe('prompt.submit')
    expect(sent.params).toEqual({ session_id: 'run-1', text: '你好', profile: 'work' })
    socket.emitMessage({ jsonrpc: '2.0', id: 1, result: {} })
    await promise
  })

  test('Given submitPrompt 无 profile When 调用 Then 不带 profile 参数', async () => {
    const { adapter, socket } = await setupAdapter()
    const promise = adapter.submitPrompt('run-1', 'hi')
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.params).toEqual({ session_id: 'run-1', text: 'hi' })
    socket.emitMessage({ jsonrpc: '2.0', id: 1, result: {} })
    await promise
  })

  test('Given respondApproval allow When 调用 Then 发送 choice', async () => {
    const { adapter, socket } = await setupAdapter()
    const promise = adapter.respondApproval({ sessionId: 'run-1', choice: 'allow', all: true })
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.method).toBe('approval.respond')
    expect(sent.params).toEqual({ session_id: 'run-1', choice: 'allow', all: true })
    socket.emitMessage({ jsonrpc: '2.0', id: 1, result: { resolved: true } })
    expect(await promise).toEqual({ resolved: true })
  })

  test('Given respondClarify When 调用 Then 发送 answer', async () => {
    const { adapter, socket } = await setupAdapter()
    const promise = adapter.respondClarify({ sessionId: 'run-1', answer: '是', requestId: 'rid-1' })
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.method).toBe('clarify.respond')
    expect(sent.params).toEqual({ session_id: 'run-1', answer: '是', request_id: 'rid-1' })
    socket.emitMessage({ jsonrpc: '2.0', id: 1, result: {} })
    await promise
  })

  test('Given respondSudo When 调用 Then 发送 password', async () => {
    const { adapter, socket } = await setupAdapter()
    const promise = adapter.respondSudo({ sessionId: 'run-1', password: 'p', requestId: 'rid-1' })
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.method).toBe('sudo.respond')
    expect(sent.params).toEqual({ session_id: 'run-1', password: 'p', request_id: 'rid-1' })
    socket.emitMessage({ jsonrpc: '2.0', id: 1, result: {} })
    await promise
  })

  test('Given interruptSession When 调用 Then 发送 session.interrupt', async () => {
    const { adapter, socket } = await setupAdapter()
    const promise = adapter.interruptSession('run-1')
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.method).toBe('session.interrupt')
    expect(sent.params).toEqual({ session_id: 'run-1' })
    socket.emitMessage({ jsonrpc: '2.0', id: 1, result: {} })
    await promise
  })
})

describe('parseSessionResult 响应解析', () => {
  test('Given 合法响应 When 解析 Then 返回 session id', () => {
    const result = parseSessionResult({ session_id: 'a', stored_session_id: 'b' }, true)
    expect(result.sessionId).toBe('a')
    expect(result.storedSessionId).toBe('b')
  })

  test('Given 缺少 stored 字段 When 解析 Then 回退到 session_id', () => {
    const result = parseSessionResult({ session_id: 'a' }, false)
    expect(result.storedSessionId).toBe('a')
  })

  test('Given 畸形响应 When 解析 Then 抛错', () => {
    expect(() => parseSessionResult(null, true)).toThrow('格式异常')
    expect(() => parseSessionResult({}, true)).toThrow('缺少 session_id')
  })
})

describe('parseProjectTree / parseSessionList 项目视图解析', () => {
  test('Given projects.tree 响应 When 解析 Then 返回项目列表', () => {
    const tree = parseProjectTree({
      projects: [
        { id: 'p_1', label: '项目A', path: '/srv/a', sessionCount: 3, lastActive: 123 },
        { id: 'p_2', label: '项目B', path: '/srv/b' },
        { id: 42 }, // 畸形项被过滤
      ],
      active_id: 'p_1',
      scoped_session_ids: ['s1', 's2'],
    })
    expect(tree.projects).toHaveLength(2)
    expect(tree.projects[0]?.id).toBe('p_1')
    expect(tree.projects[0]?.sessionCount).toBe(3)
    expect(tree.activeId).toBe('p_1')
    expect(tree.scopedSessionIds).toEqual(['s1', 's2'])
  })

  test('Given 畸形 projects.tree When 解析 Then 返回空列表', () => {
    expect(parseProjectTree(null)).toEqual({ projects: [], activeId: null, scopedSessionIds: [] })
    expect(parseProjectTree({})).toEqual({ projects: [], activeId: null, scopedSessionIds: [] })
  })

  test('Given session.list 响应 When 解析 Then 返回会话摘要', () => {
    const sessions = parseSessionList({
      sessions: [
        { id: 's1', title: '会话1', preview: 'hi', started_at: 123, message_count: 5, source: 'cli' },
        { id: 42 }, // 畸形项被过滤
      ],
    })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: 's1', title: '会话1', messageCount: 5, source: 'cli' })
  })

  test('Given 畸形 session.list When 解析 Then 返回空列表', () => {
    expect(parseSessionList(null)).toEqual([])
    expect(parseSessionList({})).toEqual([])
  })

  test('Given session.history 响应 When 解析 Then 返回消息列表', () => {
    const messages = parseHistoryMessages({
      count: 2,
      messages: [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '你好！' },
        { role: 'tool', text: '' }, // 空文本过滤
        { role: 'unknown', text: 'x' }, // 非法角色过滤
      ],
    })
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'user', text: '你好' })
    expect(messages[1]).toEqual({ role: 'assistant', text: '你好！' })
  })
})

describe('HermesDashboardAdapter 远端项目视图', () => {
  const setupAdapter = async (): Promise<{ adapter: HermesDashboardAdapter; socket: FakeWebSocket }> => {
    const { client, socket } = await connectClient()
    return { adapter: new HermesDashboardAdapter(client), socket }
  }

  test('Given listProjects When 调用 Then 发送 projects.tree 并返回项目树', async () => {
    const { adapter, socket } = await setupAdapter()
    const promise = adapter.listProjects()
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.method).toBe('projects.tree')
    socket.emitMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { projects: [{ id: 'p_1', label: '项目A', path: '/srv/a' }], active_id: 'p_1', scoped_session_ids: [] },
    })
    const tree = await promise
    expect(tree.projects[0]?.label).toBe('项目A')
  })

  test('Given listSessions When 调用 Then 发送 session.list 并返回会话', async () => {
    const { adapter, socket } = await setupAdapter()
    const promise = adapter.listSessions(50)
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent.method).toBe('session.list')
    expect(sent.params).toEqual({ limit: 50 })
    socket.emitMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { sessions: [{ id: 's1', title: '会话1', preview: '', started_at: 1, message_count: 2, source: 'cli' }] },
    })
    const sessions = await promise
    expect(sessions[0]?.title).toBe('会话1')
  })
})
