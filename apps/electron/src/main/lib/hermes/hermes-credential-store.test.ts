/**
 * Hermes Credential Store BDD 测试
 *
 * 覆盖：加密持久化、解密读取、覆盖更新、删除、加密不可用时拒绝落盘、损坏文件降级。
 * 通过注入 fake crypto 避免依赖 Electron 运行时。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HermesCredentialStore,
  type CredentialCrypto,
} from './hermes-credential-store'

/** 可逆伪加密：XOR 每个字节 + 1（仅测试用，验证加解密链路） */
function createFakeCrypto(available = true): CredentialCrypto & { available: boolean } {
  return {
    available,
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => {
      const bytes = Buffer.from(plain, 'utf-8')
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = (bytes[i]! ^ 0x5a) + 1
      }
      return bytes
    },
    decryptString: (buffer: Buffer) => {
      const bytes = Buffer.from(buffer)
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = (bytes[i]! - 1) ^ 0x5a
      }
      return bytes.toString('utf-8')
    },
  }
}

const setup = (available = true): { store: HermesCredentialStore; dir: string; crypto: CredentialCrypto & { available: boolean } } => {
  const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-cred-'))
  const crypto = createFakeCrypto(available)
  const store = new HermesCredentialStore(join(dir, 'hermes-credentials.json'), crypto)
  return { store, dir, crypto }
}

const cleanup = (dir: string): void => rmSync(dir, { recursive: true, force: true })

describe('HermesCredentialStore 加密持久化', () => {
  test('Given 加密可用 When 保存凭据 Then 落盘内容不含明文且可解密读取', () => {
    const { store, dir } = setup()
    try {
      const ref = store.setCredential('api-server-key', 'sk-hermes-secret-123')
      expect(ref).toBeTruthy()
      const raw = readFileSync(join(dir, 'hermes-credentials.json'), 'utf-8')
      expect(raw).not.toContain('sk-hermes-secret-123')
      expect(store.getCredential(ref)).toBe('sk-hermes-secret-123')
    } finally {
      cleanup(dir)
    }
  })

  test('Given 保存多种类型凭据 When 列出 Then 返回元数据且不含明文', () => {
    const { store, dir } = setup()
    try {
      const tokenRef = store.setCredential('dashboard-token', 'token-abc')
      const pwdRef = store.setCredential('dashboard-password', 'p@ssw0rd')
      const sshRef = store.setCredential('ssh-password', 'sshpass-secret-999')
      const listed = store.listCredentials()
      expect(listed.map((item) => item.ref).sort()).toEqual(
        [tokenRef, pwdRef, sshRef].sort(),
      )
      const serialized = JSON.stringify(listed)
      expect(serialized).not.toContain('token-abc')
      expect(serialized).not.toContain('p@ssw0rd')
      expect(serialized).not.toContain('sshpass-secret-999')
    } finally {
      cleanup(dir)
    }
  })

  test('Given 相同 ref When 再次保存 Then 覆盖密文并保留 createdAt', () => {
    const { store, dir } = setup()
    try {
      const ref = store.setCredential('api-server-key', 'old-secret')
      const createdAt = store.listCredentials().find((item) => item.ref === ref)?.createdAt
      store.setCredential('api-server-key', 'new-secret', ref)
      expect(store.getCredential(ref)).toBe('new-secret')
      const entry = store.listCredentials().find((item) => item.ref === ref)
      expect(entry?.createdAt).toBe(createdAt)
      expect(entry?.updatedAt).toBeGreaterThanOrEqual(entry?.createdAt ?? 0)
    } finally {
      cleanup(dir)
    }
  })

  test('Given 空秘密 When 保存 Then 拒绝', () => {
    const { store, dir } = setup()
    try {
      expect(() => store.setCredential('api-server-key', '')).toThrow('不能为空')
    } finally {
      cleanup(dir)
    }
  })

  test('Given 加密不可用 When 保存 Then 拒绝持久化且不创建文件', () => {
    const { store, dir } = setup(false)
    try {
      expect(() => store.setCredential('api-server-key', 'secret')).toThrow(
        '系统加密不可用',
      )
      expect(store.getCredential('any')).toBeNull()
      expect(() => readFileSync(join(dir, 'hermes-credentials.json'), 'utf-8')).toThrow()
    } finally {
      cleanup(dir)
    }
  })

  test('Given ref 不存在 When 读取 Then 返回 null', () => {
    const { store, dir } = setup()
    try {
      expect(store.getCredential('missing-ref')).toBeNull()
    } finally {
      cleanup(dir)
    }
  })

  test('Given 已存在凭据 When 删除 Then 成功且再次读取为 null', () => {
    const { store, dir } = setup()
    try {
      const ref = store.setCredential('ssh-key', 'ssh-key-secret')
      expect(store.deleteCredential(ref)).toBe(true)
      expect(store.getCredential(ref)).toBeNull()
      expect(store.deleteCredential(ref)).toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  test('Given 主配置与 backup 都损坏 When 读取 Then fail closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-cred-'))
    const file = join(dir, 'hermes-credentials.json')
    try {
      writeFileSync(file, 'broken{', 'utf-8')
      writeFileSync(`${file}.bak`, 'also broken{', 'utf-8')
      const store = new HermesCredentialStore(file, createFakeCrypto())
      expect(() => store.listCredentials()).toThrow('配置损坏')
      expect(() => store.setCredential('api-server-key', 'must-not-overwrite')).toThrow('配置损坏')
    } finally {
      cleanup(dir)
    }
  })

  test('Given 多个凭据 When 删除一个 Then 其余保留', () => {
    const { store, dir } = setup()
    try {
      const a = store.setCredential('api-server-key', 'a')
      const b = store.setCredential('dashboard-token', 'b')
      store.deleteCredential(a)
      expect(store.getCredential(a)).toBeNull()
      expect(store.getCredential(b)).toBe('b')
      expect(store.listCredentials()).toHaveLength(1)
    } finally {
      cleanup(dir)
    }
  })
})
