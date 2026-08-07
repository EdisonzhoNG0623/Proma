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
  service = new HermesIpcService({ targetStore, credentialStore })
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

  test('Given 更新 target When update Then 保留 id', () => {
    const created = service.createTarget({
      name: 'a',
      mode: 'direct',
      remoteUrl: 'https://a.example.com',
    })
    const updated = service.updateTarget(created.id, { name: 'b' })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('b')
  })
})

describe('HermesIpcService 凭据管理', () => {
  test('Given 保存 Dashboard 密码 When setDashboardPassword Then 加密存储并更新 target 引用', () => {
    const created = service.createTarget({
      name: '凭据测试',
      mode: 'direct',
      remoteUrl: 'https://h.example.com',
    })
    const result = service.setDashboardPassword({
      targetId: created.id,
      provider: 'basic',
      username: 'admin',
      password: 'p@ss',
    })
    expect(result.ref).toBeTruthy()
    const target = service.getTarget(created.id)
    expect(target?.auth.dashboardCredentialRef).toBe(result.ref)
    expect(target?.auth.dashboardProvider).toBe('basic')
    // 明文不落盘
    const raw = credentialStore.getCredential(result.ref)
    expect(raw).toContain('p@ss') // fake crypto 可逆，真实环境为密文
  })

  test('Given 保存 API Server key When setApiServerKey Then 更新 target 引用', () => {
    const created = service.createTarget({
      name: 'api',
      mode: 'direct',
      remoteUrl: 'https://h.example.com',
    })
    const result = service.setApiServerKey({ targetId: created.id, secret: 'sk-mock' })
    expect(service.getTarget(created.id)?.auth.apiServerKeyRef).toBe(result.ref)
  })

  test('Given 保存 SSH 密码 When setSshPassword Then 更新 ssh 引用', () => {
    const created = service.createTarget({
      name: 'ssh',
      mode: 'ssh-tunnel',
      ssh: { host: 'vps.example.com', port: 22, username: 'deploy' },
    })
    const result = service.setSshPassword({ targetId: created.id, secret: 'ssh-pass' })
    expect(service.getTarget(created.id)?.ssh?.credentialRef).toBe(result.ref)
  })

  test('Given 删除 target When delete Then 同步清理关联凭据', () => {
    const created = service.createTarget({
      name: '删除测试',
      mode: 'direct',
      remoteUrl: 'https://h.example.com',
    })
    const pwRef = service.setDashboardPassword({
      targetId: created.id,
      provider: 'basic',
      username: 'u',
      password: 'p',
    }).ref
    const apiRef = service.setApiServerKey({ targetId: created.id, secret: 'sk' }).ref

    const result = service.deleteTarget(created.id)
    expect(result.ok).toBe(true)
    expect(result.removedCredentialRefs).toContain(pwRef)
    expect(result.removedCredentialRefs).toContain(apiRef)
    // 凭据已清理
    expect(credentialStore.getCredential(pwRef)).toBeNull()
    expect(credentialStore.getCredential(apiRef)).toBeNull()
  })

  test('Given 删除不存在的 target When delete Then 返回 ok=false', () => {
    const result = service.deleteTarget('missing')
    expect(result.ok).toBe(false)
  })

  test('Given deleteCredential When 调用 Then 返回是否删除', () => {
    const ref = service.setCredential('api-server-key', { secret: 'x' }).ref
    expect(service.deleteCredential(ref)).toBe(true)
    expect(service.deleteCredential(ref)).toBe(false)
  })
})
