import { randomUUID } from 'node:crypto'
import type {
  HermesAuthConfig,
  HermesEndpointConfig,
  HermesTarget,
  HermesTargetCreateInput,
  HermesTargetEndpoints,
  HermesTargetsConfig,
  HermesTargetUpdateInput,
} from '@proma/shared'
import { readJsonWithBackup, writeJsonAtomic } from './hermes-atomic-json-store'

export const HERMES_TARGETS_CONFIG_VERSION = 2
export const DEFAULT_HERMES_DASHBOARD_PORT = 9119
export const DEFAULT_HERMES_API_SERVER_PORT = 8642
export const DEFAULT_SSH_PORT = 22

function defaultHermesTargetsPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getHermesTargetsPath } = require('../config-paths') as typeof import('../config-paths')
  return getHermesTargetsPath()
}

/** 校验 Direct 服务根 URL；保留 reverse-proxy path prefix。 */
export function validateAndNormalizeDirectUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) throw new Error('Hermes 远端 URL 不能为空')
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
  if (parsed.hash) throw new Error('Hermes 远端 URL 不允许包含 hash 片段')
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
  return parsed.toString()
}

function assertPort(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 65535) {
    throw new Error(`${label} 远端端口必须在 1-65535 之间`)
  }
  return resolved
}

/** 校验 SSH 主机与认证入口；远端端口字段保留用于 V1/调用兼容。 */
export function validateAndNormalizeSshConfig(
  ssh: HermesTargetCreateInput['ssh'],
): NonNullable<HermesTargetCreateInput['ssh']> {
  if (!ssh) throw new Error('SSH Tunnel 模式必须提供 SSH 配置')
  const host = ssh.host.trim()
  const username = ssh.username.trim()
  if (!host) throw new Error('SSH 主机不能为空')
  if (!username) throw new Error('SSH 用户名不能为空')
  if (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535) {
    throw new Error('SSH 端口必须在 1-65535 之间')
  }
  return {
    host,
    port: ssh.port,
    username,
    dashboardRemotePort: assertPort(ssh.dashboardRemotePort, DEFAULT_HERMES_DASHBOARD_PORT, 'Dashboard'),
    apiServerRemotePort: assertPort(ssh.apiServerRemotePort, DEFAULT_HERMES_API_SERVER_PORT, 'API Server'),
  }
}

function normalizeDirectEndpoint(endpoint: HermesEndpointConfig | undefined): HermesEndpointConfig | undefined {
  if (!endpoint) return undefined
  if (endpoint.remotePort !== undefined) throw new Error('Direct endpoint 不允许配置 remotePort')
  if (!endpoint.baseUrl) throw new Error('Direct endpoint 必须提供 baseUrl')
  return { baseUrl: validateAndNormalizeDirectUrl(endpoint.baseUrl) }
}

function normalizeSshEndpoint(
  endpoint: HermesEndpointConfig | undefined,
  fallback: number,
  label: string,
): HermesEndpointConfig | undefined {
  if (!endpoint) return undefined
  if (endpoint.baseUrl !== undefined) throw new Error('SSH endpoint 不允许配置 baseUrl')
  return { remotePort: assertPort(endpoint.remotePort, fallback, label) }
}

function normalizeEndpoints(
  mode: HermesTarget['mode'],
  endpoints: HermesTargetEndpoints | undefined,
  legacyRemoteUrl: string | undefined,
  ssh: HermesTarget['ssh'],
): HermesTargetEndpoints {
  if (mode === 'direct') {
    const source = endpoints ?? (legacyRemoteUrl ? { dashboard: { baseUrl: legacyRemoteUrl } } : undefined)
    const normalized: HermesTargetEndpoints = {
      dashboard: normalizeDirectEndpoint(source?.dashboard),
      apiServer: normalizeDirectEndpoint(source?.apiServer),
    }
    if (!normalized.dashboard && !normalized.apiServer) {
      throw new Error('Direct 模式必须提供至少一个 Hermes 服务 URL')
    }
    return normalized
  }

  const source = endpoints ?? {
    dashboard: { remotePort: ssh?.dashboardRemotePort ?? DEFAULT_HERMES_DASHBOARD_PORT },
    apiServer: { remotePort: ssh?.apiServerRemotePort ?? DEFAULT_HERMES_API_SERVER_PORT },
  }
  const normalized: HermesTargetEndpoints = {
    dashboard: normalizeSshEndpoint(source.dashboard, DEFAULT_HERMES_DASHBOARD_PORT, 'Dashboard'),
    apiServer: normalizeSshEndpoint(source.apiServer, DEFAULT_HERMES_API_SERVER_PORT, 'API Server'),
  }
  if (!normalized.dashboard && !normalized.apiServer) {
    throw new Error('SSH Tunnel 模式必须提供至少一个 Hermes 服务端口')
  }
  return normalized
}

function decodeConfig(value: unknown): HermesTargetsConfig {
  if (!value || typeof value !== 'object') throw new Error('hermes-targets.json 结构不合法')
  const data = value as { version?: unknown; targets?: unknown }
  if (!Array.isArray(data.targets)) throw new Error('hermes-targets.json 结构不合法（targets 必须为数组）')
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    targets: data.targets as HermesTarget[],
  }
}

function migrateAuth(target: HermesTarget): HermesAuthConfig {
  const auth = target.auth ?? {}
  if (
    !auth.dashboardMode
    && auth.dashboardCredentialRef
    && (auth.dashboardProvider || target.lastCapabilitySnapshot?.dashboard?.supportsPassword)
  ) {
    // Early Hermes Remote builds persisted a password credential/provider but
    // had no explicit auth mode. Preserve that working configuration when
    // reading V1 or already-written V2 files.
    return { ...auth, dashboardMode: 'password-cookie' }
  }
  return auth
}

function migrateTarget(target: HermesTarget, configVersion: number): HermesTarget {
  if (configVersion >= 2 && target.endpoints) {
    const ssh = target.ssh ? validateAndNormalizeSshConfig(target.ssh) : undefined
    return {
      ...target,
      endpoints: normalizeEndpoints(target.mode, target.endpoints, undefined, ssh),
      remoteUrl: undefined,
      ssh,
      auth: migrateAuth(target),
    }
  }

  const ssh = target.ssh ? validateAndNormalizeSshConfig(target.ssh) : undefined
  const endpoints = target.mode === 'direct'
    ? target.lastCapabilitySnapshot?.serviceClass === 'api-only'
      ? { apiServer: { baseUrl: validateAndNormalizeDirectUrl(target.remoteUrl ?? '') } }
      : { dashboard: { baseUrl: validateAndNormalizeDirectUrl(target.remoteUrl ?? '') } }
    : normalizeEndpoints('ssh-tunnel', undefined, undefined, ssh)

  return {
    ...target,
    endpoints,
    remoteUrl: undefined,
    ssh,
    auth: migrateAuth(target),
    lastCapabilitySnapshot: undefined,
  }
}

export function normalizeCreateInput(
  input: HermesTargetCreateInput,
  now: number = Date.now(),
): HermesTarget {
  const name = input.name.trim()
  if (!name) throw new Error('Hermes 连接名称不能为空')
  const ssh = input.ssh ? validateAndNormalizeSshConfig(input.ssh) : undefined
  if (input.mode === 'ssh-tunnel' && !ssh) throw new Error('SSH Tunnel 模式必须提供 SSH 配置')
  const endpoints = normalizeEndpoints(input.mode, input.endpoints, input.remoteUrl, ssh)
  return {
    id: randomUUID(),
    name,
    mode: input.mode,
    endpoints,
    remoteUrl: undefined,
    ssh,
    auth: input.auth ?? {},
    defaultProfile: input.defaultProfile?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  }
}

export class HermesTargetStore {
  constructor(private readonly filePath: string = defaultHermesTargetsPath()) {}

  private readConfig(): HermesTargetsConfig {
    const decoded = readJsonWithBackup(this.filePath, decodeConfig)
    if (!decoded) return { version: HERMES_TARGETS_CONFIG_VERSION, targets: [] }
    const migratedTargets = decoded.targets.map((target) => migrateTarget(target, decoded.version))
    const migrated = decoded.version !== HERMES_TARGETS_CONFIG_VERSION
      || decoded.targets.some((target, index) => (
        !target.endpoints
        || target.remoteUrl !== undefined
        || JSON.stringify(target.auth ?? {}) !== JSON.stringify(migratedTargets[index]?.auth ?? {})
      ))
    const canonical = { version: HERMES_TARGETS_CONFIG_VERSION, targets: migratedTargets }
    if (migrated) writeJsonAtomic(this.filePath, canonical)
    return canonical
  }

  private writeConfig(config: HermesTargetsConfig): void {
    writeJsonAtomic(this.filePath, {
      version: HERMES_TARGETS_CONFIG_VERSION,
      targets: config.targets,
    })
  }

  listTargets(): HermesTarget[] {
    return [...this.readConfig().targets].sort((a, b) => a.createdAt - b.createdAt)
  }

  getTarget(id: string): HermesTarget | null {
    return this.readConfig().targets.find((target) => target.id === id) ?? null
  }

  createTarget(input: HermesTargetCreateInput): HermesTarget {
    const target = normalizeCreateInput(input)
    const config = this.readConfig()
    config.targets.push(target)
    this.writeConfig(config)
    console.log(`[Hermes Target] 已创建连接: ${target.name} (${target.mode})`)
    return target
  }

  updateTarget(id: string, input: HermesTargetUpdateInput): HermesTarget {
    const config = this.readConfig()
    const index = config.targets.findIndex((item) => item.id === id)
    if (index < 0) throw new Error(`Hermes Target 不存在: ${id}`)
    const current = config.targets[index]!
    const mode = input.mode ?? current.mode
    const name = input.name?.trim() || current.name
    if (!name) throw new Error('Hermes 连接名称不能为空')

    let ssh = input.ssh
      ? validateAndNormalizeSshConfig(input.ssh)
      : current.ssh
    if (mode === 'ssh-tunnel' && !ssh) {
      throw new Error('SSH Tunnel 模式必须提供 SSH 配置')
    }
    if (mode === 'direct' && input.ssh === undefined) {
      // Direct 可继续复用既有可选 SSH 文件访问配置。
      ssh = current.ssh
    }

    const endpoints = normalizeEndpoints(
      mode,
      input.endpoints ?? (input.remoteUrl
        ? { dashboard: { baseUrl: input.remoteUrl } }
        : mode === current.mode
          ? current.endpoints
          : undefined),
      undefined,
      ssh,
    )
    if (mode === 'ssh-tunnel' && ssh) {
      ssh = {
        ...ssh,
        dashboardRemotePort: endpoints.dashboard?.remotePort,
        apiServerRemotePort: endpoints.apiServer?.remotePort,
      }
    }
    const endpointChanged = mode !== current.mode || JSON.stringify(endpoints) !== JSON.stringify(current.endpoints)
    const updated: HermesTarget = {
      ...current,
      name,
      mode,
      endpoints,
      remoteUrl: undefined,
      ssh,
      auth: input.auth ? { ...current.auth, ...input.auth } : current.auth,
      defaultProfile: input.defaultProfile?.trim() || current.defaultProfile || undefined,
      lastCapabilitySnapshot: endpointChanged
        ? undefined
        : input.lastCapabilitySnapshot ?? current.lastCapabilitySnapshot,
      updatedAt: Date.now(),
    }
    config.targets[index] = updated
    this.writeConfig(config)
    console.log(`[Hermes Target] 已更新连接: ${updated.name}`)
    return updated
  }

  deleteTarget(id: string): HermesTarget | null {
    const config = this.readConfig()
    const index = config.targets.findIndex((item) => item.id === id)
    if (index < 0) return null
    const [removed] = config.targets.splice(index, 1)
    this.writeConfig(config)
    console.log(`[Hermes Target] 已删除连接: ${removed?.name}`)
    return removed ?? null
  }
}

export const hermesTargetStore = new HermesTargetStore()
