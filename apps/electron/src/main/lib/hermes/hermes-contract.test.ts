/**
 * Hermes 端到端契约测试
 *
 * 用本地 mock Hermes 服务器（真实 HTTP + WebSocket）驱动 HermesRuntimeFacade 完整链路，
 * 验证客户端与 Hermes 协议契约的一致性：
 * - Dashboard 完整 turn（密码登录 → WS ticket → session.create → prompt.submit → 事件流）
 * - 恢复会话（session.resume）
 * - API Server fallback（/v1/runs + SSE）
 * - 错误密码（401）
 * - approval 透传
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HermesTargetStore } from './hermes-target-store'
import { HermesCredentialStore } from './hermes-credential-store'
import { HermesRuntimeFacade, type HermesSessionBinding } from './hermes-runtime-facade'
import { buildHermesTransport } from './hermes-connection'
import { startMockHermesServer, type MockHermesServerHandle } from './testing/hermes-mock-server'
import { HermesError } from './hermes-errors'
import type { SDKMessage } from '@proma/shared'

let server: MockHermesServerHandle
let dir: string
let targetStore: HermesTargetStore
let credentialStore: HermesCredentialStore
const bindings = new Map<string, HermesSessionBinding>()

const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buffer: Buffer) => buffer.toString('utf-8').replace(/^enc:/, ''),
}

const createFacade = (): HermesRuntimeFacade => {
  return new HermesRuntimeFacade({
    getTarget: (id) => targetStore.getTarget(id),
    getCredential: (ref) => (ref ? credentialStore.getCredential(ref) : null),
    readDashboardPassword: (ref) => {
      const secret = ref ? credentialStore.getCredential(ref) : null
      if (!secret) return null
      try {
        const parsed = JSON.parse(secret) as { username?: string; password?: string }
        return { username: parsed.username ?? '', password: parsed.password ?? '' }
      } catch {
        return { username: '', password: secret }
      }
    },
    getBinding: (sessionId) => bindings.get(sessionId) ?? null,
    persistRemoteSessionId: (sessionId, remoteSessionId) => {
      const current = bindings.get(sessionId) ?? { targetId: 'target-1' }
      bindings.set(sessionId, { ...current, remoteSessionId })
    },
    buildTransport: async (target) => buildHermesTransport(target),
    ensureRemoteCwd: async () => false,
    saveCredential: () => {},
  })
}

const setupTarget = (overrides: { apiServerKeyRef?: string } = {}): string => {
  const target = targetStore.createTarget({
    name: '契约测试',
    mode: 'direct',
    remoteUrl: `http://127.0.0.1:${server.port}/`,
    auth: {
      dashboardMode: 'password-cookie',
      dashboardProvider: 'basic',
      dashboardCredentialRef: 'cred-pw',
      ...(overrides.apiServerKeyRef ? { apiServerKeyRef: overrides.apiServerKeyRef } : {}),
    },
  })
  return target.id
}

const collect = async (iterable: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = []
  for await (const item of iterable) {
    out.push(item)
  }
  return out
}

beforeAll(async () => {
  server = await startMockHermesServer()
  dir = mkdtempSync(join(tmpdir(), 'proma-hermes-contract-'))
  targetStore = new HermesTargetStore(join(dir, 'hermes-targets.json'))
  credentialStore = new HermesCredentialStore(join(dir, 'hermes-credentials.json'), fakeCrypto)
  credentialStore.setCredential('dashboard-password', '{"username":"admin","password":"correct-password"}', 'cred-pw')
  credentialStore.setCredential('api-server-key', 'mock-api-key', 'cred-api')
})

afterAll(async () => {
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('Dashboard 完整契约', () => {
  test('Given 绑定 target When query Then 完整请求序列与 SDKMessage 流', async () => {
    const targetId = setupTarget()
    bindings.set('sess-1', { targetId, profile: 'work' })
    const facade = createFacade()

    const messages = await collect(
      facade.query({ sessionId: 'sess-1', prompt: '你好', agentRuntime: 'hermes-remote' }),
    )

    // 1. 请求序列（HTTP + WS）
    const http = server.httpPaths
    expect(http.some((p) => p === 'POST /auth/password-login')).toBe(true)
    expect(http.some((p) => p === 'POST /api/auth/ws-ticket')).toBe(true)
    const methods = server.wsRequests.map((r) => r.method)
    expect(methods).toContain('session.create')
    expect(methods).toContain('prompt.submit')

    // 2. SDKMessage 流
    const types = messages.map((m) => (m as { type: string }).type)
    expect(types).toContain('assistant')
    expect(types).toContain('result')
    expect(types).toContain('tool_progress')

    const assistants = messages.filter((m) => (m as { type: string }).type === 'assistant' && (m as { _partial?: boolean })._partial !== true) as Array<{
      message: { content: Array<{ type: string; text?: string }> }
    }>
    const text = assistants
      .flatMap((a) => a.message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    expect(text).toBe('契约测试的消息')

    // 3. result 为 success
    const result = messages.find((m) => (m as { type: string }).type === 'result') as {
      subtype: string
    }
    expect(result.subtype).toBe('success')
  })

  test('Given 绑定含 remoteSessionId When query Then 走 session.resume', async () => {
    const targetId = setupTarget()
    bindings.set('sess-2', { targetId, profile: 'work', remoteSessionId: 'stored-1' })
    const facade = createFacade()
    await collect(facade.query({ sessionId: 'sess-2', prompt: '继续', agentRuntime: 'hermes-remote' }))
    expect(server.wsRequests.some((r) => r.method === 'session.resume')).toBe(true)
  })

  test('Given 新会话 When query Then 持久化远端 session id', async () => {
    const targetId = setupTarget()
    bindings.set('sess-3', { targetId })
    const facade = createFacade()
    await collect(facade.query({ sessionId: 'sess-3', prompt: 'hi', agentRuntime: 'hermes-remote' }))
    expect(bindings.get('sess-3')?.remoteSessionId).toBe('stored-1')
  })

  test('Given 新会话无 SSH 且绑定 workspaceSlug When query Then 免 SSH 引导 mkdir + session.cwd.set', async () => {
    const targetId = setupTarget()
    // 无 remoteSessionId（新会话）+ workspaceSlug → remoteCwd 推导为 ~/proma-projects/<slug>
    bindings.set('sess-bootstrap', { targetId, workspaceSlug: 'my-project', title: 'my-project 对话' })
    const facade = createFacade()
    await collect(facade.query({ sessionId: 'sess-bootstrap', prompt: '你好', agentRuntime: 'hermes-remote' }))

    // 1. 引导：先提交 mkdir 初始化指令（prompt.submit 引导消息）
    const wsMethods = server.wsRequests.map((r) => r.method)
    const submits = server.wsRequests.filter((r) => r.method === 'prompt.submit')
    expect(submits.length).toBeGreaterThanOrEqual(2) // 引导 + 用户消息
    expect(wsMethods).toContain('session.cwd.set')
    // cwd 指向 ~/proma-projects/my-project
    const cwdReq = server.wsRequests.find((r) => r.method === 'session.cwd.set')
    expect((cwdReq?.params as Record<string, unknown>)?.cwd).toBe('~/proma-projects/my-project')
    // 存在引导消息（mkdir -p 指令）
    const mkdirSubmit = server.wsRequests.find(
      (r) => r.method === 'prompt.submit' && String((r.params as Record<string, unknown>)?.text ?? '').includes('mkdir -p'),
    )
    expect(mkdirSubmit).toBeTruthy()
    // 新建会话时同步 Proma 标题为 Hermes 标题（session.create title 参数，取本测试最后一次创建）
    const createReqs = server.wsRequests.filter((r) => r.method === 'session.create')
    expect((createReqs.at(-1)?.params as Record<string, unknown>)?.title).toBe('my-project 对话')
  })
})

describe('API Server fallback 契约', () => {
  test('Given Dashboard WS 不可用 When query Then 走 /v1/runs + SSE', async () => {
    // 关闭当前服务器的 WS，换一个 disableDashboardWs 服务器
    await server.stop()
    server = await startMockHermesServer({ disableDashboardWs: true })
    const targetId = setupTarget({ apiServerKeyRef: 'cred-api' })
    bindings.set('sess-4', { targetId })
    const facade = createFacade()

    const messages = await collect(
      facade.query({ sessionId: 'sess-4', prompt: 'hi', agentRuntime: 'hermes-remote' }),
    )
    const http = server.httpPaths
    expect(http.some((p) => p === 'POST /v1/runs')).toBe(true)
    expect(http.some((p) => p.startsWith('GET /v1/runs/') && p.endsWith('/events'))).toBe(true)

    const text = messages
      .filter((m) => (m as { type: string }).type === 'assistant')
      .map((m) => (m as { message: { content: Array<{ text?: string }> } }).message.content.map((c) => c.text ?? '').join(''))
      .join('')
    expect(text).toContain('API 契约')
  })
})

describe('认证错误契约', () => {
  test('Given 密码错误 When query Then 抛 unauthorized', async () => {
    await server.stop()
    server = await startMockHermesServer()
    const targetId = setupTarget()
    bindings.set('sess-5', { targetId })
    const facade = createFacade()
    // 覆盖凭据为错误密码
    credentialStore.setCredential('dashboard-password', '{"username":"admin","password":"wrong"}', 'cred-pw')
    const error = await collect(
      facade.query({ sessionId: 'sess-5', prompt: 'hi', agentRuntime: 'hermes-remote' }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HermesError)
    expect((error as HermesError).code).toBe('unauthorized')
    // 恢复正确凭据
    credentialStore.setCredential('dashboard-password', '{"username":"admin","password":"correct-password"}', 'cred-pw')
  })
})

describe('approval 透传契约', () => {
  test('Given turn 包含 approval.request When query Then 产出 hermes_approval_request 消息', async () => {
    await server.stop()
    server = await startMockHermesServer({
      turnEvents: [
        { method: 'message.delta', params: { text: '请求批准' } },
        {
          method: 'approval.request',
          params: { request_id: 'r1', message: '允许执行 rm -rf?', tool_name: 'Bash' },
        },
        { method: 'turn.completed', params: {} },
      ],
    })
    const targetId = setupTarget()
    bindings.set('sess-6', { targetId })
    const facade = createFacade()
    const messages = await collect(
      facade.query({ sessionId: 'sess-6', prompt: '执行危险命令', agentRuntime: 'hermes-remote' }),
    )
    const approvalMsg = messages.find(
      (m) => (m as { type: string }).type === 'hermes_approval_request',
    ) as { type: string; requestId: string; tool_name?: string } | undefined
    expect(approvalMsg).toBeDefined()
    expect(approvalMsg?.requestId).toBe('r1')
    expect(approvalMsg?.tool_name).toBe('Bash')
    // 仍正常结束
    expect(messages.some((m) => (m as { type: string }).type === 'result')).toBe(true)
  })
})
