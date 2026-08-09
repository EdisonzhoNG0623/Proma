import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@proma/shared'
import { HermesRuntimeFacade, type HermesSessionBinding } from './hermes-runtime-facade'
import { HermesTargetStore } from './hermes-target-store'
import { HermesCredentialStore } from './hermes-credential-store'
import { HermesCredentialBroker } from './hermes-credential-broker'
import { HermesCookieSessionManager, type HermesCookieSession } from './hermes-cookie-session'
import { HermesEndpointManager } from './hermes-endpoint-manager'
import { HermesDashboardConnectionBroker } from './hermes-dashboard-connection-broker'
import { buildHermesTransport } from './hermes-connection'
import { HermesError } from './hermes-errors'
import { startMockHermesServer, type MockHermesServerHandle } from './testing/hermes-mock-server'

let server: MockHermesServerHandle
let dir: string
let targetStore: HermesTargetStore
let credentialStore: HermesCredentialStore
let credentials: HermesCredentialBroker
const bindings = new Map<string, HermesSessionBinding>()

const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buffer: Buffer) => buffer.toString('utf-8').replace(/^enc:/, ''),
}

function browserSession(): HermesCookieSession {
  const jar = new Map<string, string>()
  return {
    fetch: async (input, init = {}) => {
      const headers = new Headers(init.headers)
      if (jar.size > 0) headers.set('Cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '))
      const response = await fetch(input, { ...init, headers })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) {
        const pair = setCookie.split(';')[0]!
        const index = pair.indexOf('=')
        if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1))
      }
      return response
    },
    cookies: { get: async () => [], remove: async () => undefined },
    flushStorageData: async () => undefined,
  }
}

function createFacade() {
  const sessions = new Map<string, HermesCookieSession>()
  const cookies = new HermesCookieSessionManager((partition) => {
    let value = sessions.get(partition)
    if (!value) { value = browserSession(); sessions.set(partition, value) }
    return value
  })
  const endpoints = new HermesEndpointManager({ credentialBroker: credentials, cookieSessions: cookies })
  const broker = new HermesDashboardConnectionBroker({ endpointManager: endpoints, credentialBroker: credentials })
  const facade = new HermesRuntimeFacade({
    getTarget: (id) => targetStore.getTarget(id),
    getBinding: (sessionId) => bindings.get(sessionId) ?? null,
    persistRemoteSessionId: (sessionId, remoteSessionId, expected) => {
      const current = bindings.get(sessionId)
      if (!current || current.targetId !== expected.targetId || (current.protocol ?? 'dashboard') !== (expected.protocol ?? 'dashboard')) return false
      bindings.set(sessionId, { ...current, remoteSessionId })
      return true
    },
    getTargetCredential: (targetId, slot) => credentials.getSecret(targetId, slot),
    buildTransport: (target, protocol = 'dashboard') => buildHermesTransport(target, protocol, endpoints),
    dashboardBroker: broker,
  })
  return { facade, broker, endpoints }
}

function setupTarget(): string {
  const baseUrl = `http://127.0.0.1:${server.port}/`
  const target = targetStore.createTarget({
    name: '契约测试', mode: 'direct',
    endpoints: { dashboard: { baseUrl }, apiServer: { baseUrl } },
    auth: { dashboardMode: 'password-cookie', dashboardProvider: 'basic' },
  })
  credentials.setSecret(target.id, 'dashboard-password', JSON.stringify({ username: 'admin', password: 'correct-password' }))
  credentials.setSecret(target.id, 'api-server-key', 'mock-api-key')
  return target.id
}

async function collect(iterable: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const output: SDKMessage[] = []
  for await (const message of iterable) output.push(message)
  return output
}

beforeAll(async () => {
  server = await startMockHermesServer()
  dir = mkdtempSync(join(tmpdir(), 'proma-hermes-contract-'))
  targetStore = new HermesTargetStore(join(dir, 'targets.json'))
  credentialStore = new HermesCredentialStore(join(dir, 'credentials.json'), fakeCrypto)
  credentials = new HermesCredentialBroker(credentialStore)
})

afterAll(async () => {
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('Dashboard end-to-end contract', () => {
  test('password-cookie → ready → create → prompt → event stream', async () => {
    const targetId = setupTarget()
    bindings.set('s1', { targetId, protocol: 'dashboard', profile: 'work' })
    const ctx = createFacade()
    const messages = await collect(ctx.facade.query({ sessionId: 's1', prompt: '你好', agentRuntime: 'hermes-remote' }))
    expect(server.httpPaths).toContain('POST /auth/password-login')
    expect(server.httpPaths).toContain('POST /api/auth/ws-ticket')
    expect(server.wsRequests.map((request) => request.method)).toContain('session.create')
    expect(server.wsRequests.map((request) => request.method)).toContain('prompt.submit')
    expect(messages.some((message) => message.type === 'assistant')).toBe(true)
    expect(messages.some((message) => message.type === 'result')).toBe(true)
    expect(bindings.get('s1')?.remoteSessionId).toBe('stored-1')
    ctx.facade.dispose(); await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })

  test('stored session identity resumes on same target/protocol/profile', async () => {
    const targetId = setupTarget()
    bindings.set('s2', { targetId, protocol: 'dashboard', profile: 'work', remoteSessionId: 'stored-1' })
    const ctx = createFacade()
    await collect(ctx.facade.query({ sessionId: 's2', prompt: '继续', agentRuntime: 'hermes-remote' }))
    expect(server.wsRequests.some((request) => request.method === 'session.resume')).toBe(true)
    ctx.facade.dispose(); await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })

  test('no hidden mkdir/bootstrap prompt before user turn', async () => {
    const targetId = setupTarget()
    bindings.set('s3', { targetId, protocol: 'dashboard', remoteCwd: '~/proma-projects/demo', title: 'demo' })
    const before = server.wsRequests.length
    const ctx = createFacade()
    await collect(ctx.facade.query({ sessionId: 's3', prompt: '用户消息', agentRuntime: 'hermes-remote' }))
    const requests = server.wsRequests.slice(before)
    const submits = requests.filter((request) => request.method === 'prompt.submit')
    expect(submits).toHaveLength(1)
    expect(String((submits[0]!.params as Record<string, unknown>).text)).toBe('用户消息')
    ctx.facade.dispose(); await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })
})

describe('explicit API Server contract', () => {
  test('api binding only calls /v1/runs + SSE; no Dashboard fallback/probe', async () => {
    const targetId = setupTarget()
    bindings.set('api-s', { targetId, protocol: 'api-server' })
    const beforeHttp = server.httpPaths.length
    const beforeWs = server.wsRequests.length
    const ctx = createFacade()
    const messages = await collect(ctx.facade.query({ sessionId: 'api-s', prompt: 'API', agentRuntime: 'hermes-remote' }))
    const paths = server.httpPaths.slice(beforeHttp)
    expect(paths).toContain('POST /v1/runs')
    expect(paths.some((path) => path.endsWith('/events'))).toBe(true)
    expect(server.wsRequests.length).toBe(beforeWs)
    expect(messages.some((message) => message.type === 'assistant')).toBe(true)
    ctx.facade.dispose(); await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })
})

describe('auth and interaction contract', () => {
  test('wrong password fails unauthorized without API fallback', async () => {
    const targetId = setupTarget()
    credentials.setSecret(targetId, 'dashboard-password', JSON.stringify({ username: 'admin', password: 'wrong' }))
    bindings.set('bad-auth', { targetId, protocol: 'dashboard' })
    const before = server.httpPaths.length
    const ctx = createFacade()
    const error = await collect(ctx.facade.query({ sessionId: 'bad-auth', prompt: 'x', agentRuntime: 'hermes-remote' })).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(HermesError)
    expect((error as HermesError).code).toBe('unauthorized')
    expect(server.httpPaths.slice(before)).not.toContain('POST /v1/runs')
    ctx.facade.dispose(); await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })

  test('approval.request remains a recoverable timeline entity', async () => {
    await server.stop()
    server = await startMockHermesServer({ turnEvents: [
      { method: 'approval.request', params: { request_id: 'r1', message: '允许?', tool_name: 'Bash' } },
      { method: 'turn.completed', params: {} },
    ] })
    const targetId = setupTarget()
    bindings.set('approval', { targetId, protocol: 'dashboard' })
    const ctx = createFacade()
    const messages = await collect(ctx.facade.query({ sessionId: 'approval', prompt: 'run', agentRuntime: 'hermes-remote' }))
    const approval = messages.find((message) => message.type === 'hermes_approval_request') as unknown as { requestId?: string }
    expect(approval?.requestId).toBe('r1')
    ctx.facade.dispose(); await ctx.broker.disposeAll(); await ctx.endpoints.disposeAll()
  })
})
