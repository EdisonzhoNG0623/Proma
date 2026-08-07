/**
 * Hermes Target 存储
 *
 * 负责 Hermes 连接目标（Target）的 CRUD 与持久化。
 * 数据存储到 ~/.proma/hermes-targets.json（JSON 文件，无本地数据库）。
 *
 * 安全约束：
 * - Target 只保存连接配置与凭据引用，不保存任何明文凭据；
 * - URL 不允许携带 userinfo（user:pass@host），防止凭据进入配置文件；
 * - 删除 Target 时应由调用方同步清理关联凭据与 Cookie partition。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  HermesTarget,
  HermesTargetCreateInput,
  HermesTargetsConfig,
  HermesTargetUpdateInput,
} from '@proma/shared'

/** 配置文件版本 */
export const HERMES_TARGETS_CONFIG_VERSION = 1

/** 远端 Dashboard 默认端口 */
export const DEFAULT_HERMES_DASHBOARD_PORT = 9119

/** 远端 API Server 默认端口 */
export const DEFAULT_HERMES_API_SERVER_PORT = 8642

/** SSH 默认端口 */
export const DEFAULT_SSH_PORT = 22

/** 默认配置文件路径（与 Proma 配置目录一致，开发模式为 .proma-dev） */
function defaultHermesTargetsPath(): string {
  // 惰性 require：避免全量测试并发加载时与 config-paths 的 ESM 解析竞态（Bun Windows）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getHermesTargetsPath } = require('../config-paths') as typeof import('../config-paths')
  return getHermesTargetsPath()
}

/**
 * 校验 Direct 模式远端 URL。
 *
 * 规则：
 * - 必须为 http/https；
 * - 不允许 userinfo（user:pass@host），防止把凭据写进配置文件；
 * - 不允许 hash 片段；
 * - 空 pathname 时归一化为根路径。
 *
 * @returns 归一化后的 URL 字符串
 * @throws 校验失败时抛出带明确原因的 Error
 */
export function validateAndNormalizeDirectUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    throw new Error('Hermes 远端 URL 不能为空')
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Hermes 远端 URL 无效: ${trimmed}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Hermes 远端 URL 仅支持 http/https 协议')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Hermes 远端 URL 不允许包含用户名密码（请使用认证配置填写凭据）')
  }
  if (parsed.hash) {
    throw new Error('Hermes 远端 URL 不允许包含 hash 片段')
  }
  // 归一化：去掉尾随斜杠与 query，保留根路径
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  if (!parsed.pathname) parsed.pathname = '/'
  return parsed.toString()
}

/**
 * 校验 SSH Tunnel 配置。
 *
 * 规则：
 * - host 必填；
 * - port 1-65535；
 * - username 必填；
 * - 远端端口 1-65535（默认 9119 / 8642）。
 *
 * @returns 归一化后的 SSH 配置（补默认端口）
 */
export function validateAndNormalizeSshConfig(
  ssh: HermesTargetCreateInput['ssh'],
): NonNullable<HermesTargetCreateInput['ssh']> {
  if (!ssh) {
    throw new Error('SSH Tunnel 模式必须提供 SSH 配置')
  }
  const host = ssh.host.trim()
  if (!host) {
    throw new Error('SSH 主机不能为空')
  }
  const username = ssh.username.trim()
  if (!username) {
    throw new Error('SSH 用户名不能为空')
  }
  if (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535) {
    throw new Error('SSH 端口必须在 1-65535 之间')
  }
  const assertRemotePort = (
    value: number | undefined,
    fallback: number,
    label: string,
  ): number => {
    if (value === undefined) {
      return fallback
    }
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${label} 远端端口必须在 1-65535 之间`)
    }
    return value
  }
  return {
    host,
    port: ssh.port,
    username,
    credentialRef: ssh.credentialRef,
    dashboardRemotePort: assertRemotePort(
      ssh.dashboardRemotePort,
      DEFAULT_HERMES_DASHBOARD_PORT,
      'Dashboard',
    ),
    apiServerRemotePort: assertRemotePort(
      ssh.apiServerRemotePort,
      DEFAULT_HERMES_API_SERVER_PORT,
      'API Server',
    ),
  }
}

/**
 * 创建时的 Target 归一化（纯函数，便于测试）。
 *
 * 根据 mode 校验并归一化连接字段，生成 id 与时间戳。
 */
export function normalizeCreateInput(
  input: HermesTargetCreateInput,
  now: number = Date.now(),
): HermesTarget {
  const name = input.name.trim()
  if (!name) {
    throw new Error('Hermes 连接名称不能为空')
  }
  if (input.mode === 'direct') {
    if (!input.remoteUrl) {
      throw new Error('Direct 模式必须提供远端 URL')
    }
    return {
      id: randomUUID(),
      name,
      mode: 'direct',
      remoteUrl: validateAndNormalizeDirectUrl(input.remoteUrl),
      auth: input.auth ?? {},
      defaultProfile: input.defaultProfile?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    }
  }
  if (input.mode === 'ssh-tunnel') {
    return {
      id: randomUUID(),
      name,
      mode: 'ssh-tunnel',
      ssh: validateAndNormalizeSshConfig(input.ssh),
      auth: input.auth ?? {},
      defaultProfile: input.defaultProfile?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    }
  }
  throw new Error(`未知的 Hermes 连接模式: ${String(input.mode)}`)
}

/**
 * Hermes Target Store
 *
 * 线程模型：主进程单实例使用；文件读写为同步 I/O（配置小，参考 channel-manager）。
 */
export class HermesTargetStore {
  constructor(
    private readonly filePath: string = defaultHermesTargetsPath(),
  ) {}

  private readConfig(): HermesTargetsConfig {
    if (!existsSync(this.filePath)) {
      return { version: HERMES_TARGETS_CONFIG_VERSION, targets: [] }
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as HermesTargetsConfig
      if (!Array.isArray(parsed.targets)) {
        throw new Error('hermes-targets.json 结构不合法（targets 必须为数组）')
      }
      return { version: HERMES_TARGETS_CONFIG_VERSION, targets: parsed.targets }
    } catch (error) {
      console.error('[Hermes Target] 读取配置文件失败:', error)
      return { version: HERMES_TARGETS_CONFIG_VERSION, targets: [] }
    }
  }

  private writeConfig(config: HermesTargetsConfig): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.filePath, JSON.stringify(config, null, 2), 'utf-8')
    } catch (error) {
      console.error('[Hermes Target] 写入配置文件失败:', error)
      throw new Error('写入 Hermes Target 配置失败')
    }
  }

  /** 列出全部 Target（按创建时间升序） */
  listTargets(): HermesTarget[] {
    return this.readConfig().targets.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 获取单个 Target */
  getTarget(id: string): HermesTarget | null {
    return this.readConfig().targets.find((target) => target.id === id) ?? null
  }

  /** 创建 Target */
  createTarget(input: HermesTargetCreateInput): HermesTarget {
    const target = normalizeCreateInput(input)
    const config = this.readConfig()
    if (config.targets.some((item) => item.id === target.id)) {
      throw new Error(`Hermes Target 已存在: ${target.id}`)
    }
    config.targets.push(target)
    this.writeConfig(config)
    console.log(`[Hermes Target] 已创建连接: ${target.name} (${target.mode})`)
    return target
  }

  /** 更新 Target（仅更新提供项；mode 变化时重归一化连接字段） */
  updateTarget(id: string, input: HermesTargetUpdateInput): HermesTarget {
    const config = this.readConfig()
    const index = config.targets.findIndex((item) => item.id === id)
    if (index < 0) {
      throw new Error(`Hermes Target 不存在: ${id}`)
    }
    const current = config.targets[index]!
    const name = input.name?.trim() || current.name
    const mode = input.mode ?? current.mode
    if (!name) {
      throw new Error('Hermes 连接名称不能为空')
    }

    let remoteUrl = current.remoteUrl
    let ssh = current.ssh
    if (mode === 'direct') {
      remoteUrl = validateAndNormalizeDirectUrl(input.remoteUrl ?? current.remoteUrl ?? '')
      ssh = undefined
    } else if (mode === 'ssh-tunnel') {
      ssh = validateAndNormalizeSshConfig(input.ssh ?? current.ssh)
      remoteUrl = undefined
    }

    const updated: HermesTarget = {
      ...current,
      name,
      mode,
      remoteUrl,
      ssh,
      auth: input.auth ?? current.auth,
      defaultProfile: input.defaultProfile?.trim() || current.defaultProfile || undefined,
      lastCapabilitySnapshot: input.lastCapabilitySnapshot ?? current.lastCapabilitySnapshot,
      updatedAt: Date.now(),
    }
    config.targets[index] = updated
    this.writeConfig(config)
    console.log(`[Hermes Target] 已更新连接: ${updated.name}`)
    return updated
  }

  /** 删除 Target；返回被删除的 Target（调用方据此清理关联凭据与 Cookie partition） */
  deleteTarget(id: string): HermesTarget | null {
    const config = this.readConfig()
    const index = config.targets.findIndex((item) => item.id === id)
    if (index < 0) {
      return null
    }
    const [removed] = config.targets.splice(index, 1)
    this.writeConfig(config)
    console.log(`[Hermes Target] 已删除连接: ${removed?.name}`)
    return removed ?? null
  }
}

/** 单例实例（主进程全局复用） */
export const hermesTargetStore = new HermesTargetStore()
