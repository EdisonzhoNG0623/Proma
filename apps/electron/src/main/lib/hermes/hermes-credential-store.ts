/**
 * Hermes 凭据存储
 *
 * 负责 Hermes 相关秘密（Dashboard token / 用户名密码 / API Server key / SSH 凭据）
 * 的加密持久化。使用 Electron safeStorage（OS 级加密）：
 * - macOS: Keychain
 * - Windows: DPAPI
 * - Linux: Secret Service API
 *
 * 安全约束（来自方案文档）：
 * - 凭据不进入 Renderer、普通日志或项目文件；
 * - 加密不可用时**拒绝持久化**（不静默明文降级），仅允许调用方选择内存态或明确报错；
 * - Target 配置中只保存凭据引用（ref），实际秘密在 credentials.json；
 * - 删除 Target 时应同步删除其关联凭据（由 IPC 层协调）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { getHermesCredentialsPath } from '../config-paths'
import type { safeStorage } from 'electron'

/** 配置文件版本 */
export const HERMES_CREDENTIALS_CONFIG_VERSION = 1

/** 凭据类型分类 */
export type HermesCredentialKind =
  | 'dashboard-token'
  | 'dashboard-password'
  | 'api-server-key'
  | 'ssh-password'
  | 'ssh-key'

/** 凭据条目（仅元数据 + 密文，不含明文） */
export interface HermesCredentialEntry {
  /** 凭据引用 ID（Target.auth.*Ref / ssh.credentialRef 中保存的值） */
  ref: string
  /** 凭据类型 */
  kind: HermesCredentialKind
  /** 加密后的 base64 字符串 */
  encrypted: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

/** 凭据配置文件格式 */
export interface HermesCredentialsConfig {
  version: number
  credentials: HermesCredentialEntry[]
}

/**
 * 加密能力抽象（默认 Electron safeStorage，测试可注入 fake）
 */
export interface CredentialCrypto {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buffer: Buffer): string
}

/** Electron safeStorage 适配（主进程默认实现） */
export function createElectronCredentialCrypto(
  storage: Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>,
): CredentialCrypto {
  return {
    isEncryptionAvailable: () => storage.isEncryptionAvailable(),
    encryptString: (plain: string) => storage.encryptString(plain),
    decryptString: (buffer: Buffer) => storage.decryptString(buffer),
  }
}

/** 默认配置文件路径（与 Proma 配置目录一致，开发模式为 .proma-dev） */
function defaultHermesCredentialsPath(): string {
  return getHermesCredentialsPath()
}

/**
 * Hermes 凭据存储
 *
 * 主进程单实例使用；文件读写为同步 I/O（配置小）。
 */
export class HermesCredentialStore {
  private cryptoImpl: CredentialCrypto | null = null

  constructor(
    private readonly filePath: string = defaultHermesCredentialsPath(),
    crypto?: CredentialCrypto,
  ) {
    // 允许测试注入 fake；未注入时延迟加载 Electron safeStorage（避免非 Electron 环境解析失败）
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
    if (!existsSync(this.filePath)) {
      return { version: HERMES_CREDENTIALS_CONFIG_VERSION, credentials: [] }
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as HermesCredentialsConfig
      if (!Array.isArray(parsed.credentials)) {
        throw new Error('hermes-credentials.json 结构不合法（credentials 必须为数组）')
      }
      return { version: HERMES_CREDENTIALS_CONFIG_VERSION, credentials: parsed.credentials }
    } catch (error) {
      console.error('[Hermes 凭据] 读取配置文件失败:', error)
      return { version: HERMES_CREDENTIALS_CONFIG_VERSION, credentials: [] }
    }
  }

  private writeConfig(config: HermesCredentialsConfig): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.filePath, JSON.stringify(config, null, 2), 'utf-8')
    } catch (error) {
      console.error('[Hermes 凭据] 写入配置文件失败:', error)
      throw new Error('写入 Hermes 凭据配置失败')
    }
  }

  /**
   * 保存凭据（新建或覆盖）。
   *
   * @param kind 凭据类型
   * @param secret 明文秘密
   * @param ref 可选显式引用 ID；缺省自动生成
   * @returns 凭据引用 ID
   * @throws 加密不可用时抛出明确错误（不静默明文落盘）
   */
  setCredential(
    kind: HermesCredentialKind,
    secret: string,
    ref: string = randomUUID(),
  ): string {
    if (!secret) {
      throw new Error('凭据内容不能为空')
    }
    const crypto = this.getCrypto()
    if (!crypto.isEncryptionAvailable()) {
      throw new Error(
        '系统加密不可用，无法安全保存 Hermes 凭据（Hermes 凭据不允许明文落盘）',
      )
    }
    const config = this.readConfig()
    const encrypted = crypto.encryptString(secret).toString('base64')
    const now = Date.now()
    const existing = config.credentials.findIndex((item) => item.ref === ref)
    if (existing >= 0) {
      config.credentials[existing] = { ref, kind, encrypted, createdAt: config.credentials[existing]!.createdAt, updatedAt: now }
    } else {
      config.credentials.push({ ref, kind, encrypted, createdAt: now, updatedAt: now })
    }
    this.writeConfig(config)
    return ref
  }

  /**
   * 读取凭据明文。
   *
   * @returns 明文秘密；ref 不存在或解密失败时返回 null
   */
  getCredential(ref: string): string | null {
    const crypto = this.getCrypto()
    if (!crypto.isEncryptionAvailable()) {
      return null
    }
    const entry = this.readConfig().credentials.find((item) => item.ref === ref)
    if (!entry) {
      return null
    }
    try {
      return crypto.decryptString(Buffer.from(entry.encrypted, 'base64'))
    } catch (error) {
      console.error(`[Hermes 凭据] 解密失败 (ref=${ref}):`, error)
      return null
    }
  }

  /** 删除凭据；返回是否删除成功 */
  deleteCredential(ref: string): boolean {
    const config = this.readConfig()
    const index = config.credentials.findIndex((item) => item.ref === ref)
    if (index < 0) {
      return false
    }
    config.credentials.splice(index, 1)
    this.writeConfig(config)
    return true
  }

  /** 列出全部凭据元数据（不含明文与密文） */
  listCredentials(): Array<Omit<HermesCredentialEntry, 'encrypted'>> {
    return this.readConfig().credentials.map(({ encrypted: _encrypted, ...meta }) => meta)
  }
}

/** 单例实例（主进程全局复用；加密能力在主进程初始化后生效） */
export const hermesCredentialStore = new HermesCredentialStore()
