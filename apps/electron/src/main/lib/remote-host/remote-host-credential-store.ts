import { randomUUID } from 'node:crypto'
import type { safeStorage } from 'electron'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'

const REMOTE_HOST_CREDENTIALS_VERSION = 1

export type RemoteHostCredentialSlot = 'bearer-token' | 'ssh-password' | 'ssh-private-key' | 'ssh-private-key-passphrase'

export interface RemoteHostCredentialEntry {
  ref: string
  slot: RemoteHostCredentialSlot
  ownerTargetId: string
  encrypted: string
  createdAt: number
  updatedAt: number
}

interface RemoteHostCredentialsConfig {
  version: number
  credentials: RemoteHostCredentialEntry[]
}

export interface CredentialCrypto {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buffer: Buffer): string
}

function defaultPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRemoteHostCredentialsPath } = require('../config-paths') as typeof import('../config-paths')
  return getRemoteHostCredentialsPath()
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

function decodeConfig(value: unknown): RemoteHostCredentialsConfig {
  if (!value || typeof value !== 'object') throw new Error('remote-host-credentials.json 结构不合法')
  const data = value as { version?: unknown; credentials?: unknown }
  if (!Array.isArray(data.credentials)) {
    throw new Error('remote-host-credentials.json 结构不合法（credentials 必须为数组）')
  }
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    credentials: data.credentials as RemoteHostCredentialEntry[],
  }
}

export class RemoteHostCredentialStore {
  private cryptoImpl: CredentialCrypto | null = null

  constructor(
    private readonly filePath: string = defaultPath(),
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

  private readConfig(): RemoteHostCredentialsConfig {
    return readJsonFileSafe<RemoteHostCredentialsConfig>(this.filePath)
      ?? { version: REMOTE_HOST_CREDENTIALS_VERSION, credentials: [] }
  }

  private writeConfig(config: RemoteHostCredentialsConfig): void {
    writeJsonFileAtomic(this.filePath, {
      version: REMOTE_HOST_CREDENTIALS_VERSION,
      credentials: config.credentials,
    })
  }

  private encrypt(secret: string): string {
    if (!secret) throw new Error('凭据内容不能为空')
    const crypto = this.getCrypto()
    if (!crypto.isEncryptionAvailable()) {
      throw new Error('系统加密不可用，无法安全保存 Remote Host 凭据')
    }
    return crypto.encryptString(secret).toString('base64')
  }

  private decrypt(entry: RemoteHostCredentialEntry | undefined): string | null {
    if (!entry) return null
    const crypto = this.getCrypto()
    if (!crypto.isEncryptionAvailable()) return null
    try {
      return crypto.decryptString(Buffer.from(entry.encrypted, 'base64'))
    } catch {
      return null
    }
  }

  setOwnedCredential(targetId: string, slot: RemoteHostCredentialSlot, secret: string): void {
    if (!targetId.trim()) throw new Error('targetId 不能为空')
    const config = this.readConfig()
    const encrypted = this.encrypt(secret)
    const now = Date.now()
    const existingIndex = config.credentials.findIndex(
      (item) => item.ownerTargetId === targetId && item.slot === slot,
    )
    const entry: RemoteHostCredentialEntry = {
      ref: existingIndex >= 0 ? config.credentials[existingIndex]!.ref : randomUUID(),
      slot,
      ownerTargetId: targetId,
      encrypted,
      createdAt: existingIndex >= 0 ? config.credentials[existingIndex]!.createdAt : now,
      updatedAt: now,
    }
    if (existingIndex >= 0) config.credentials[existingIndex] = entry
    else config.credentials.push(entry)
    config.credentials = config.credentials.filter((item) =>
      item.ref === entry.ref || item.ownerTargetId !== targetId || item.slot !== slot,
    )
    this.writeConfig(config)
  }

  getOwnedCredential(targetId: string, slot: RemoteHostCredentialSlot): string | null {
    return this.decrypt(
      this.readConfig().credentials.find((item) => item.ownerTargetId === targetId && item.slot === slot),
    )
  }

  hasOwnedCredential(targetId: string, slot: RemoteHostCredentialSlot): boolean {
    return this.readConfig().credentials.some((item) => item.ownerTargetId === targetId && item.slot === slot)
  }

  clearOwnedCredential(targetId: string, slot: RemoteHostCredentialSlot): boolean {
    const config = this.readConfig()
    const before = config.credentials.length
    config.credentials = config.credentials.filter(
      (item) => item.ownerTargetId !== targetId || item.slot !== slot,
    )
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
}

export const remoteHostCredentialStore = new RemoteHostCredentialStore()
