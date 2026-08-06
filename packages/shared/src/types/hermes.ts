/**
 * Hermes Remote 相关类型定义
 *
 * 用于 Proma Desktop 作为 Hermes 客户端连接远端 Hermes Agent。
 * Hermes 是外部 Runtime（External Runtime），不伪装成 Proma Local，
 * 也不作为 Proma 的远程节点；此处仅定义连接目标、认证与能力契约。
 */

/**
 * 连接模式：直接 URL 或 SSH Tunnel
 *
 * Direct 直连远端暴露的 HTTP(S) 端口；SSH Tunnel 通过系统 OpenSSH
 * 建立本地转发，访问远端仅监听 loopback 的服务。
 */
export type HermesConnectionMode = 'direct' | 'ssh-tunnel'

/**
 * Dashboard 认证模式
 *
 * - token：`X-Hermes-Session-Token` / WS `?token=`
 * - password-cookie：`/auth/password-login` 换取 Cookie Session + WS ticket
 * - native-pkce：Hermes native PKCE OAuth + WS ticket
 */
export type HermesDashboardAuthMode = 'token' | 'password-cookie' | 'native-pkce'

/**
 * Hermes 服务能力探测状态
 *
 * Dashboard 与 API Server 的可用性组合：
 * - dashboard-only：仅 Dashboard 可用
 * - api-only：仅 API Server 可用
 * - both：两者都可用
 * - protocol-incompatible：服务存在但协议不兼容
 */
export type HermesServiceClass =
  | 'dashboard-only'
  | 'api-only'
  | 'both'
  | 'protocol-incompatible'
  | 'unreachable'

/**
 * 远端 target 连接状态
 */
export type HermesTargetStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth-required'
  | 'error'

/**
 * SSH Tunnel 配置
 *
 * SSH 凭据属于传输层凭据（key / agent / password），与 Hermes 账号密码分开。
 */
export interface HermesSshTunnelConfig {
  /** SSH 主机（IP 或域名） */
  host: string
  /** SSH 端口，默认 22 */
  port: number
  /** SSH 用户名 */
  username: string
  /** SSH 凭据引用（OS Credential Store 中的引用 ID；key/agent/password 均可指向） */
  credentialRef?: string
  /** 远端 Dashboard 端口，默认 9119 */
  dashboardRemotePort?: number
  /** 远端 API Server 端口，默认 8642 */
  apiServerRemotePort?: number
  /** 本地动态端口是否已由 Tunnel 管理器分配（运行时字段，不持久化到用户编辑表单） */
  localDashboardPort?: number
  /** 本地动态端口是否已由 Tunnel 管理器分配（运行时字段） */
  localApiServerPort?: number
}

/**
 * 认证配置
 *
 * 各凭据分开存储：
 * - dashboardCredentialRef：Dashboard token / 用户名密码 / OAuth 会话凭据引用
 * - apiServerKeyRef：API Server Bearer key 引用
 * 凭据一律不进 Renderer、日志或项目配置，只保存 OS Credential Store 引用。
 */
export interface HermesAuthConfig {
  /** Dashboard 认证模式；未设置表示沿用远端默认 */
  dashboardMode?: HermesDashboardAuthMode
  /** 密码模式下的 provider 名（如 basic / LDAP 插件名） */
  dashboardProvider?: string
  /** Dashboard 凭据引用（token / password-cookie / oauth session 对应凭据） */
  dashboardCredentialRef?: string
  /** API Server Bearer key 引用 */
  apiServerKeyRef?: string
}

/**
 * Hermes 能力快照（探测结果缓存）
 *
 * 探测来源：
 * - Dashboard：`GET /api/status`（auth_required、version、auth_flows）
 * - API Server：`GET /v1/capabilities`
 */
export interface HermesCapabilities {
  /** 探测时间戳 */
  probedAt: number
  /** Hermes 版本号（可能为 null） */
  version: string | null
  /** 服务分类 */
  serviceClass: HermesServiceClass
  /** Dashboard 能力 */
  dashboard?: {
    /** 是否开启认证 */
    authRequired: boolean
    /** auth_flows 声明（如 token / cookie / oauth） */
    authFlows: string[]
    /** 是否有支持密码登录的 provider（supports_password） */
    supportsPassword: boolean
  }
  /** API Server 能力 */
  apiServer?: {
    /** capabilities 端点返回的协议能力列表 */
    endpoints: string[]
  }
}

/**
 * Hermes 连接目标（Target）
 *
 * 一个 Target 对应一台远端 Hermes 主机 + 一组连接与认证配置。
 * 存储在 ~/.proma/hermes-targets.json（v1 起）。
 */
export interface HermesTarget {
  /** 唯一标识 */
  id: string
  /** 用户自定义名称 */
  name: string
  /** 连接模式 */
  mode: HermesConnectionMode
  /** Direct 模式远端 URL（http/https） */
  remoteUrl?: string
  /** SSH Tunnel 模式配置 */
  ssh?: HermesSshTunnelConfig
  /** 认证配置 */
  auth: HermesAuthConfig
  /** 远端默认 profile 名 */
  defaultProfile?: string
  /** 最近一次能力快照（缓存用于连接列表展示） */
  lastCapabilitySnapshot?: HermesCapabilities
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

/**
 * 创建 Target 的输入（不含 id/createdAt/updatedAt）
 */
export interface HermesTargetCreateInput {
  name: string
  mode: HermesConnectionMode
  remoteUrl?: string
  ssh?: HermesSshTunnelConfig
  auth?: HermesAuthConfig
  defaultProfile?: string
}

/**
 * 更新 Target 的输入（可选字段，仅更新提供项）
 */
export interface HermesTargetUpdateInput {
  name?: string
  mode?: HermesConnectionMode
  remoteUrl?: string
  ssh?: HermesSshTunnelConfig
  auth?: HermesAuthConfig
  defaultProfile?: string
  lastCapabilitySnapshot?: HermesCapabilities
}

/**
 * Target 配置文件格式
 */
export interface HermesTargetsConfig {
  /** 配置版本号 */
  version: number
  /** target 列表 */
  targets: HermesTarget[]
}

/**
 * Target 连接状态快照（用于 UI 展示与诊断）
 */
export interface HermesTargetStatusSnapshot {
  /** target 标识 */
  targetId: string
  /** 连接状态 */
  status: HermesTargetStatus
  /** 最近一次错误消息（不含凭据） */
  lastError: string | null
  /** 服务分类（探测结果） */
  serviceClass: HermesServiceClass | null
  /** 延迟 ms（最近一次探测） */
  latencyMs: number | null
}

/**
 * Hermes 相关 IPC 通道常量
 */
export const HERMES_IPC_CHANNELS = {
  /** 获取所有 target */
  LIST_TARGETS: 'hermes:list-targets',
  /** 获取单个 target */
  GET_TARGET: 'hermes:get-target',
  /** 创建 target */
  CREATE_TARGET: 'hermes:create-target',
  /** 更新 target */
  UPDATE_TARGET: 'hermes:update-target',
  /** 删除 target（同时清理关联凭据与 Cookie partition） */
  DELETE_TARGET: 'hermes:delete-target',
  /** 探测 target 能力 */
  PROBE_TARGET: 'hermes:probe-target',
  /** 测试连接（向导步骤：验证可达性与认证） */
  TEST_CONNECTION: 'hermes:test-connection',
} as const

/**
 * Hermes IPC 通道名称类型
 */
export type HermesIpcChannel =
  (typeof HERMES_IPC_CHANNELS)[keyof typeof HERMES_IPC_CHANNELS]
