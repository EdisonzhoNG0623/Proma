import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HermesCredentialBroker } from './hermes-credential-broker'
import { HermesCredentialStore, type CredentialCrypto } from './hermes-credential-store'

const crypto: CredentialCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (value) => value.toString('utf8'),
}

function setup(): { broker: HermesCredentialBroker; store: HermesCredentialStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-broker-'))
  const store = new HermesCredentialStore(join(dir, 'credentials.json'), crypto)
  return { broker: new HermesCredentialBroker(store), store, dir }
}

describe('HermesCredentialBroker target ownership', () => {
  test('Given 两个 target When 访问相同 slot Then 凭据严格隔离', () => {
    const { broker, dir } = setup()
    try {
      broker.setSecret('target-a', 'dashboard-token', 'token-a')
      broker.setSecret('target-b', 'dashboard-token', 'token-b')
      expect(broker.getSecret('target-a', 'dashboard-token')).toBe('token-a')
      expect(broker.getSecret('target-b', 'dashboard-token')).toBe('token-b')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('Given 同 target/slot 更新 When 再保存 Then 不产生孤儿条目', () => {
    const { broker, store, dir } = setup()
    try {
      broker.setSecret('target-a', 'api-server-key', 'old')
      broker.setSecret('target-a', 'api-server-key', 'new')
      expect(broker.getSecret('target-a', 'api-server-key')).toBe('new')
      expect(store.listCredentials()).toHaveLength(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('Given target 有多个 slot When 删除 target Then 清理全部 slot', () => {
    const { broker, store, dir } = setup()
    try {
      broker.setSecret('target-a', 'dashboard-password', 'pw')
      broker.setSecret('target-a', 'ssh-private-key', 'key')
      broker.setSecret('target-b', 'dashboard-token', 'other')
      expect(broker.clearTarget('target-a')).toBe(2)
      expect(store.listCredentials()).toHaveLength(1)
      expect(broker.getSecret('target-b', 'dashboard-token')).toBe('other')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('Given legacy ref When A claim 后 B 再 claim Then B 被拒绝', () => {
    const { broker, store, dir } = setup()
    try {
      const ref = store.setCredential('dashboard-token', 'legacy-token', 'legacy-ref')
      expect(broker.claimLegacyRef('target-a', 'dashboard-token', ref)).toBe(true)
      expect(broker.getSecret('target-a', 'dashboard-token')).toBe('legacy-token')
      expect(() => broker.claimLegacyRef('target-b', 'dashboard-token', ref)).toThrow('其他 target')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('Given slot 状态 When 查询 Then 仅暴露布尔值不暴露 ref', () => {
    const { broker, dir } = setup()
    try {
      broker.setSecret('target-a', 'ssh-password', 'secret')
      const state = broker.credentialState('target-a')
      expect(state['ssh-password']).toBe(true)
      expect(JSON.stringify(state)).not.toContain('ref')
      expect(JSON.stringify(state)).not.toContain('secret')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
