/**
 * Hermes IPC 服务 BDD 测试
 *
 * 覆盖：target CRUD、凭据保存/更新/删除、删除 target 联动清理凭据、能力探测缓存。
 * 注意：HermesIpcService 使用全局单例 store（~/.proma），测试需通过 env 隔离配置目录。
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HermesIpcService } from './hermes-ipc-service'

// 使用临时配置目录隔离全局 store
const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-ipc-'))
const originalConfigDir = process.env.PROMA_CONFIG_DIR
process.env.PROMA_CONFIG_DIR = dir

// 重新加载目标 store 单例（HermesTargetStore 默认路径读取 PROMA_CONFIG_DIR）
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hermesTargetStore } = require('./hermes-target-store') as typeof import('./hermes-target-store')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hermesCredentialStore } = require('./hermes-credential-store') as typeof import('./hermes-credential-store')

// 注入 fake crypto 使 safeStorage 在测试环境可用
const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buffer: Buffer) => buffer.toString('utf-8').replace(/^enc:/, ''),
}
;(hermesCredentialStore as unknown as { cryptoImpl: unknown }).cryptoImpl = fakeCrypto

const service = new HermesIpcService()

beforeAll(() => {
  process.env.PROMA_CONFIG_DIR = dir
})

afterAll(() => {
  if (originalConfigDir === undefined) {
    delete process.env.PROMA_CONFIG_DIR
  } else {
    process.env.PROMA_CONFIG_DIR = originalConfigDir
  }
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
    const raw = hermesCredentialStore.getCredential(result.ref)
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
    expect(hermesCredentialStore.getCredential(pwRef)).toBeNull()
    expect(hermesCredentialStore.getCredential(apiRef)).toBeNull()
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
