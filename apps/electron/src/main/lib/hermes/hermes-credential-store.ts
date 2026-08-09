import { randomUUID } from 'node:crypto'
import type { safeStorage } from 'electron'
import { readJsonWithBackup, writeJsonAtomic } from './hermes-atomic-json-store'

export const HERMES_CREDENTIALS_CONFIG_VERSION = 2

/** 由 main ownership broker 管理的固定凭据槽。 */
export type HermesCredentialSlot =
  | 'dashboard-token'
  | 'dashboard-password'
  | 'api-server-key'
  | 'ssh-password'
  | 'ssh-private-key'
  | 'ssh-private-key-passphrase'

/** legacy kind 仅保留迁移兼容；新代码应使用 HermesCredentialSlot。 */
export type HermesCredentialKind = HermesCredentialSlot | 'ssh-key' | 'dashboard-cookie'

export interface HermesCredentialEntry {
  ref: string
  kind: HermesCredentialKind
  /** V2 ownership；legacy V1 条目在被真实 target 引用 claim 前保持为空。 */
  ownerTargetId?: string
  slot?: HermesCredentialSlot
  encrypted: string
  createdAt: number
  updatedAt: number
}

export interface HermesCredentialsConfig {
  version: number
  credentials: HermesCredentialEntry[]
}

export interface CredentialCrypto {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buffer: Buffer): string
}

export function createElectronCredentialCrypto(
  storage: Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>,
): CredentialCrypto {
  return {
    isEncryptionAvailable: () => storage.isEncryptionAvailable(),
    encryptString: (plain) => storage.encryptString(plain),
    decryptString: (buffer) => storage.decryptString(buffer),
  }
}

function defaultHermesCredentialsPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getHermesCredentialsPath } = require('../config-paths') as typeof import('../config-paths')
  return getHermesCredentialsPath()
}

function decodeConfig(value: unknown): HermesCredentialsConfig {
  if (!value || typeof value !== 'object') throw new Error('hermes-credentials.json 结构不合法')
  const data = value as { version?: unknown; credentials?: unknown }
  if (!Array.isArray(data.credentials)) {
    throw new Error('hermes-credentials.json 结构不合法（credentials 必须为数组）')
  }
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    credentials: data.credentials as HermesCredentialEntry[],
  }
}

export class HermesCredentialStore {
  private cryptoImpl: CredentialCrypto | null = null

  constructor(
    private readonly filePath: string = defaultHermesCredentialsPath(),
    crypto?: CredentialCrypto,
  ) {
    this.cryptoImpl = crypto ?? null
  }

  private getCrypto(): CredentialCrypto {
    if (!this.cryptoImpl) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as typeof import('electron')
      this.cryptoImpl = createElectronCredentialCrypto(electron.safeStorage)
    }
    return this.cryptoImpl
  }

  private readConfig(): HermesCredentialsConfig {
    const config = readJsonWithBackup(this.filePath, decodeConfig)
    if (!config) return { version: HERMES_CREDENTIALS_CONFIG_VERSION, credentials: [] }
    if (config.version !== HERMES_CREDENTIALS_CONFIG_VERSION) {
      const migrated = { version: HERMES_CREDENTIALS_CONFIG_VERSION, credentials: config.credentials }
      writeJsonAtomic(this.filePath, migrated)
      return migrated
    }
    return config
  }

  private writeConfig(config: HermesCredentialsConfig): void {
    writeJsonAtomic(this.filePath, {
      version: HERMES_CREDENTIALS_CONFIG_VERSION,
      credentials: config.credentials,
    })
  }

  private encrypt(secret: string): string {
    if (!secret) throw new Error('凭据内容不能为空')
    const crypto = this.getCrypto()
    if (!crypto.isEncryptionAvailable()) {
      throw new Error('系统加密不可用，无法安全保存 Hermes 凭据（Hermes 凭据不允许明文落盘）')
    }
    return crypto.encryptString(secret).toString('base64')
  }

  private decrypt(entry: HermesCredentialEntry | undefined): string | null {
    if (!entry) return null
    const crypto = this.getCrypto()
    if (!crypto.isEncryptionAvailable()) return null
    try {
      return crypto.decryptString(Buffer.from(entry.encrypted, 'base64'))
    } catch {
      // 不记录 ref 或密文，避免 credential metadata 泄漏到普通日志。
      return null
    }
  }

  /** legacy ref API：只供迁移和内部兼容，新 IPC 不得暴露 ref。 */
  setCredential(kind: HermesCredentialKind, secret: string, ref: string = randomUUID()): string {
    const config = this.readConfig()
    const encrypted = this.encrypt(secret)
    const now = Date.now()
    const index = config.credentials.findIndex((item) => item.ref === ref)
    const previous = index >= 0 ? config.credentials[index] : undefined
    const entry: HermesCredentialEntry = {
      ref,
      kind,
      encrypted,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ownerTargetId: previous?.ownerTargetId,
      slot: previous?.slot,
    }
    if (index >= 0) config.credentials[index] = entry
    else config.credentials.push(entry)
    this.writeConfig(config)
    return ref
  }

  getCredential(ref: string): string | null {
    return this.decrypt(this.readConfig().credentials.find((item) => item.ref === ref))
  }

  deleteCredential(ref: string): boolean {
    const config = this.readConfig()
    const index = config.credentials.findIndex((item) => item.ref === ref)
    if (index < 0) return false
    config.credentials.splice(index, 1)
    this.writeConfig(config)
    return true
  }

  setOwnedCredential(targetId: string, slot: HermesCredentialSlot, secret: string): void {
    if (!targetId.trim()) throw new Error('targetId 不能为空')
    const config = this.readConfig()
    const encrypted = this.encrypt(secret)
    const now = Date.now()
    const matches = config.credentials
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.ownerTargetId === targetId && entry.slot === slot)
    const existing = matches[0]
    const entry: HermesCredentialEntry = {
      ref: existing?.entry.ref ?? randomUUID(),
      kind: slot,
      ownerTargetId: targetId,
      slot,
      encrypted,
      createdAt: existing?.entry.createdAt ?? now,
      updatedAt: now,
    }
    if (existing) config.credentials[existing.index] = entry
    else config.credentials.push(entry)
    // 修复旧版本可能遗留的同 owner/slot 重复项。
    config.credentials = config.credentials.filter((item) =>
      item.ref === entry.ref || item.ownerTargetId !== targetId || item.slot !== slot)
    this.writeConfig(config)
  }

  getOwnedCredential(targetId: string, slot: HermesCredentialSlot): string | null {
    return this.decrypt(this.readConfig().credentials.find((item) =>
      item.ownerTargetId === targetId && item.slot === slot))
  }

  hasOwnedCredential(targetId: string, slot: HermesCredentialSlot): boolean {
    return this.readConfig().credentials.some((item) =>
      item.ownerTargetId === targetId && item.slot === slot)
  }

  clearOwnedCredential(targetId: string, slot: HermesCredentialSlot): boolean {
    const config = this.readConfig()
    const before = config.credentials.length
    config.credentials = config.credentials.filter((item) =>
      item.ownerTargetId !== targetId || item.slot !== slot)
    if (before === config.credentials.length) return false
    this.writeConfig(config)
    return true
  }

  clearTargetCredentials(targetId: string): number {
    const config = this.readConfig()
    const before = config.credentials.length
    config.credentials = config.credentials.filter((item) => item.ownerTargetId !== targetId)
    const removed = before - config.credentials.length
    if (removed > 0) this.writeConfig(config)
    return removed
  }

  claimLegacyCredential(targetId: string, slot: HermesCredentialSlot, ref: string): boolean {
    const config = this.readConfig()
    const index = config.credentials.findIndex((item) => item.ref === ref)
    if (index < 0) return false
    const entry = config.credentials[index]!
    if (entry.ownerTargetId && entry.ownerTargetId !== targetId) {
      throw new Error('该 legacy 凭据已属于其他 target')
    }
    if (entry.slot && entry.slot !== slot) {
      throw new Error('该 legacy 凭据已绑定其他 slot')
    }
    config.credentials = config.credentials.filter((item) =>
      item.ref === ref || item.ownerTargetId !== targetId || item.slot !== slot)
    const owned = config.credentials.find((item) => item.ref === ref)!
    owned.ownerTargetId = targetId
    owned.slot = slot
    owned.kind = slot
    owned.updatedAt = Date.now()
    this.writeConfig(config)
    return true
  }

  listCredentials(): Array<Omit<HermesCredentialEntry, 'encrypted'>> {
    return this.readConfig().credentials.map(({ encrypted: _encrypted, ...meta }) => meta)
  }
}

export const hermesCredentialStore = new HermesCredentialStore()
