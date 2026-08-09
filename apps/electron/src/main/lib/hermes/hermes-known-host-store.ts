import { createHash, randomUUID } from 'node:crypto'
import { readJsonWithBackup, writeJsonAtomic } from './hermes-atomic-json-store'

interface KnownHostEntry {
  host: string
  port: number
  fingerprint: string
  keyBase64: string
  trustedAt: number
}

interface KnownHostConfig {
  version: 1
  hosts: KnownHostEntry[]
}

interface Challenge {
  token: string
  host: string
  port: number
  fingerprint: string
  keyBase64: string
  expiresAt: number
}

export interface HermesHostKeyCheck {
  status: 'trusted' | 'unknown' | 'changed'
  fingerprint: string
  challenge?: string
}

function defaultPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getHermesKnownHostsPath } = require('../config-paths') as typeof import('../config-paths')
  return getHermesKnownHostsPath()
}

function decode(value: unknown): KnownHostConfig {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { hosts?: unknown }).hosts)) {
    throw new Error('Hermes known-hosts 配置结构不合法')
  }
  return { version: 1, hosts: (value as { hosts: KnownHostEntry[] }).hosts }
}

export function sshHostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** TOFU with explicit confirmation. Changed keys never receive an ordinary confirm challenge. */
export class HermesKnownHostStore {
  private readonly challenges = new Map<string, Challenge>()
  private readonly now: () => number
  private readonly challengeTtlMs: number

  constructor(
    private readonly filePath: string = defaultPath(),
    options: { now?: () => number; challengeTtlMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now
    this.challengeTtlMs = options.challengeTtlMs ?? 5 * 60_000
  }

  private read(): KnownHostConfig {
    return readJsonWithBackup(this.filePath, decode) ?? { version: 1, hosts: [] }
  }

  check(host: string, port: number, key: Buffer): HermesHostKeyCheck {
    const keyBase64 = key.toString('base64')
    const fingerprint = sshHostKeyFingerprint(key)
    const existing = this.read().hosts.find((item) => item.host === host && item.port === port)
    if (existing) {
      return existing.keyBase64 === keyBase64
        ? { status: 'trusted', fingerprint }
        : { status: 'changed', fingerprint }
    }
    const token = randomUUID()
    this.challenges.set(token, {
      token,
      host,
      port,
      fingerprint,
      keyBase64,
      expiresAt: this.now() + this.challengeTtlMs,
    })
    return { status: 'unknown', fingerprint, challenge: token }
  }

  confirm(token: string, expected?: { host: string; port: number }): void {
    const challenge = this.challenges.get(token)
    if (!challenge) throw new Error('Hermes host-key challenge 不存在')
    if (challenge.expiresAt < this.now()) {
      this.challenges.delete(token)
      throw new Error('Hermes host-key challenge 已过期')
    }
    if (expected && (expected.host !== challenge.host || expected.port !== challenge.port)) {
      throw new Error('Hermes host-key challenge 与目标不匹配')
    }
    this.challenges.delete(token)
    const config = this.read()
    const existing = config.hosts.find((item) => item.host === challenge.host && item.port === challenge.port)
    if (existing && existing.keyBase64 !== challenge.keyBase64) {
      throw new Error('Hermes host key 已变化，禁止通过普通 challenge 覆盖')
    }
    const entry: KnownHostEntry = {
      host: challenge.host,
      port: challenge.port,
      fingerprint: challenge.fingerprint,
      keyBase64: challenge.keyBase64,
      trustedAt: this.now(),
    }
    if (existing) Object.assign(existing, entry)
    else config.hosts.push(entry)
    writeJsonAtomic(this.filePath, config)
  }
}

export const hermesKnownHostStore = new HermesKnownHostStore()
