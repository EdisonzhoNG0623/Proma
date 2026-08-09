/**
 * Hermes IPC 服务 BDD 测试
 *
 * 覆盖：target CRUD、凭据保存/更新/删除、删除 target 联动清理凭据、能力探测缓存。
 * 通过注入临时目录 store 实例隔离数据，不污染真实配置。
 */

import { mock } from 'bun:test'

// 0.16.10 官方新增 conversation-manager → attachment-service → electron 的 import 链；
// bun 在 Windows 无法解析 electron 具名导出（BrowserWindow），此处 mock 掉 attachment-service。
mock.module('../attachment-service', () => ({
  deleteConversationAttachments: () => {},
  deleteAttachment: () => {},
  isImageAttachment: () => false,
  getMimeType: () => '',
  saveAttachment: () => ({ id: '', localPath: '' }),
  readAttachmentAsBase64: () => '',
}))

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HermesIpcService } from './hermes-ipc-service'
import { HermesTargetStore } from './hermes-target-store'
import { HermesCredentialStore } from './hermes-credential-store'
import { HermesCredentialBroker } from './hermes-credential-broker'
import { HermesCookieSessionManager } from './hermes-cookie-session'
import { HermesEndpointManager } from './hermes-endpoint-manager'
import { HermesDashboardConnectionBroker } from './hermes-dashboard-connection-broker'
import { HermesDashboardWsClient } from './hermes-dashboard-ws-client'
import { HermesSshConnectionBroker } from './hermes-ssh-connection-broker'
import type { HermesSshConnection } from './transport/hermes-ssh-connection'
import type { HermesTransport } from './transport/hermes-transport'
import type { SFTPWrapper } from 'ssh2'

let dir: string
let targetStore: HermesTargetStore
let credentialStore: HermesCredentialStore
let service: HermesIpcService

const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buffer: Buffer) => buffer.toString('utf-8').replace(/^enc:/, ''),
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'proma-hermes-ipc-'))
  targetStore = new HermesTargetStore(join(dir, 'hermes-targets.json'))
  credentialStore = new HermesCredentialStore(join(dir, 'hermes-credentials.json'), fakeCrypto)
  const cookieSessions = new HermesCookieSessionManager(() => ({
    fetch: async () => new Response('{}'),
    cookies: { get: async () => [], remove: async () => undefined },
    flushStorageData: async () => undefined,
  }))
  service = new HermesIpcService({ targetStore, credentialStore, cookieSessions })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('HermesIpcService target CRUD', () => {
  test('Given 创建 target When list Then 返回并持久化', () => {
    const created = service.createTarget({
      name: 'IPC 测试',
      mode: 'direct',
      remoteUrl: 'https://hermes.example.com',
    })
    expect(created.id).toBeTruthy()
    expect(service.listTargets().some((t) => t.id === created.id)).toBe(true)
    expect(service.getTarget(created.id)?.name).toBe('IPC 测试')
  })

  test('Given 更新 target When update Then 保留 id', async () => {
    const created = service.createTarget({
      name: 'a',
      mode: 'direct',
      remoteUrl: 'https://a.example.com',
    })
    const updated = await service.updateTarget(created.id, { name: 'b' })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('b')
  })
})

describe('HermesIpcService 远端项目根目录', () => {
  test('Given Proma 创建远端项目 When 执行 Then 固定使用 /opt/ai/projects', async () => {
    const realpaths: string[] = []
    const createdPaths: string[] = []
    const sftp = {
      realpath: (remotePath: string, callback: (error: Error | undefined, resolved: string) => void) => {
        realpaths.push(remotePath)
        callback(undefined, remotePath)
      },
      mkdir: (remotePath: string, callback: (error?: Error) => void) => {
        createdPaths.push(remotePath)
        callback()
      },
      end: () => undefined,
    } as unknown as SFTPWrapper
    const connection = {
      openSftp: async () => sftp,
      close: async () => undefined,
    } as unknown as HermesSshConnection
    const sshBroker = new HermesSshConnectionBroker({ connect: async () => connection })
    const isolated = new HermesIpcService({ targetStore, credentialStore, sshBroker })
    const target = targetStore.createTarget({
      name: 'remote-root',
      mode: 'ssh-tunnel',
      ssh: { host: 'remote.example.com', port: 22, username: 'ai' },
    })

    expect(await isolated.createRemoteProject(target.id, 'next-project')).toBe('/opt/ai/projects/next-project')
    expect(realpaths).toEqual(['/opt/ai/projects', '/opt/ai/projects/next-project'])
    expect(createdPaths).toEqual(['/opt/ai/projects/next-project'])
    await sshBroker.disposeAll()
  })
})

describe('HermesIpcService remote snapshot history', () => {
  test('Given 远端 session When 读取 canonical snapshot Then 保留媒体指令且不调用 session.resume', async () => {
    const target = targetStore.createTarget({
      name: 'history',
      mode: 'direct',
      endpoints: { dashboard: { baseUrl: 'https://history.example.com/root' } },
    })
    const paths: string[] = []
    const transport: HermesTransport = {
      baseUrl: 'https://history.example.com/root/',
      requestJson: async (path) => {
        paths.push(path)
        if (path.includes('/messages')) return {
          status: 200,
          body: { messages: [
            { id: 699, role: 'system', content: '内部系统提示' },
            { id: 700, role: 'tool', content: '{"skill":"完整内部 Skill 正文"}' },
            { id: 701, role: 'user', content: '@image:/remote/a.png' },
            { id: 702, role: 'assistant', content: '看到了' },
          ] },
        }
        return { status: 200, body: { message_count: 700 } }
      },
      openSse: async () => ({ abort: () => undefined, done: Promise.resolve() }),
      connectWebSocket: async () => ({ socket: null, errorCode: null, errorMessage: null }),
      dispose: () => undefined,
    }
    const endpoints = new HermesEndpointManager({
      build: async () => ({ dashboard: transport, dispose: async () => undefined }),
    })
    const socket = new class extends EventTarget {
      send(): void { /* history path must not issue RPC */ }
      close(): void { this.dispatchEvent(new Event('close')) }
    }()
    const broker = new HermesDashboardConnectionBroker({
      endpointManager: endpoints,
      prepareConnection: async (_target, _transport, onClose) => ({
        url: 'wss://history.example.com/root/api/ws',
        client: new HermesDashboardWsClient(async () => ({
          socket: socket as unknown as WebSocket,
          errorCode: null,
          errorMessage: null,
          bufferedMessages: [new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }) })],
        }), onClose),
      }),
    })
    const isolated = new HermesIpcService({ targetStore, credentialStore, endpointManager: endpoints, dashboardBroker: broker })
    const snapshot = await isolated.getRemoteSessionHistory('proma-1', target.id, 'stored-1', 'work')
    expect(snapshot).toHaveLength(2)
    expect((snapshot[0] as { uuid?: string }).uuid).toBe(`hermes:${target.id}:dashboard:stored-1:701`)
    expect((snapshot[0] as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text).toBe('@image:/remote/a.png')
    expect(paths[0]).toContain('/api/sessions/stored-1?profile=work')
    expect(paths[1]).toContain('/messages?profile=work&limit=300&offset=400')
    expect(paths.some((path) => path.includes('session.resume'))).toBe(false)
    await broker.disposeAll(); await endpoints.disposeAll()
  })
})

describe('HermesIpcService 凭据管理', () => {
  test('Given 保存 Dashboard 密码 When 返回 Target Then 只暴露 credentialState', () => {
    const created = service.createTarget({ name: '凭据测试', mode: 'direct', remoteUrl: 'https://h.example.com' })
    expect(service.setDashboardPassword({
      targetId: created.id,
      provider: 'basic',
      username: 'admin',
      password: 'p@ss',
    })).toEqual({ configured: true })
    const target = service.getTarget(created.id)!
    expect(target.credentialState['dashboard-password']).toBe(true)
    expect(target.auth.dashboardProvider).toBe('basic')
    expect(JSON.stringify(target)).not.toContain('CredentialRef')
    expect(new HermesCredentialBroker(credentialStore).getSecret(created.id, 'dashboard-password')).toContain('p@ss')
  })

  test('Given 保存 API/SSH secret When 返回 Then 不返回 ref', () => {
    const api = service.createTarget({ name: 'api', mode: 'direct', remoteUrl: 'https://h.example.com' })
    expect(service.setApiServerKey({ targetId: api.id, secret: 'sk-mock' })).toEqual({ configured: true })
    expect(service.getTarget(api.id)?.credentialState['api-server-key']).toBe(true)

    const ssh = service.createTarget({
      name: 'ssh',
      mode: 'ssh-tunnel',
      ssh: { host: 'vps.example.com', port: 22, username: 'deploy' },
    })
    expect(service.setSshPassword({ targetId: ssh.id, secret: 'ssh-pass' })).toEqual({ configured: true })
    expect(service.getTarget(ssh.id)?.credentialState['ssh-password']).toBe(true)
  })

  test('Given 删除 target When delete Then 按 ownership 清理全部凭据', async () => {
    const created = service.createTarget({ name: '删除测试', mode: 'direct', remoteUrl: 'https://h.example.com' })
    service.setDashboardPassword({ targetId: created.id, provider: 'basic', username: 'u', password: 'p' })
    service.setApiServerKey({ targetId: created.id, secret: 'sk' })
    const result = await service.deleteTarget(created.id)
    expect(result).toEqual({ ok: true, targetId: created.id, removedCredentialCount: 2 })
    expect(new HermesCredentialBroker(credentialStore).credentialState(created.id)).toEqual({})
  })

  test('Given 删除不存在的 target When delete Then 返回 ok=false', async () => {
    expect(await service.deleteTarget('missing')).toEqual({
      ok: false,
      targetId: 'missing',
      removedCredentialCount: 0,
    })
  })
})
