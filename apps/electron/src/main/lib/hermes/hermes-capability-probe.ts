/**
 * Hermes 服务分类与能力探测
 *
 * 探测远端 Hermes 的两个服务面：
 * - Dashboard：`GET /api/status`（可选 `/api/auth/providers` 探测密码登录能力）
 * - API Server：`GET /v1/capabilities`
 *
 * 探测结果分类：
 * - dashboard-only / api-only / both / protocol-incompatible / unreachable
 *
 * 探测不修改远端任何状态，仅只读 GET。
 */

import type { HermesCapabilities, HermesServiceClass } from '@proma/shared'
import type { HermesTransport } from './transport/hermes-transport'
import { HermesError } from './hermes-errors'

/** Dashboard /api/status 响应形态 */
export interface DashboardStatusResponse {
  version?: unknown
  auth_required?: unknown
  auth_flows?: unknown
}

/** API Server /v1/capabilities 响应形态 */
export interface ApiServerCapabilitiesResponse {
  capabilities?: unknown
  endpoints?: unknown
}

/** Dashboard 探测结果 */
export interface DashboardProbeResult {
  /** 服务可达且协议兼容 */
  available: boolean
  /** 是否开启认证 */
  authRequired: boolean
  /** auth_flows 声明 */
  authFlows: string[]
  /** 是否有支持密码登录的 provider */
  supportsPassword: boolean
  /** Hermes 版本 */
  version: string | null
  /** 协议不兼容（服务存在但响应非 JSON） */
  protocolIncompatible: boolean
}

/** API Server 探测结果 */
export interface ApiServerProbeResult {
  available: boolean
  /** 是否存在但需认证（401） */
  authRequired: boolean
  /** capabilities 端点列表 */
  endpoints: string[]
  protocolIncompatible: boolean
}

/** 探测目标（两个传输可能指向不同端口） */
export interface HermesProbeTargets {
  dashboardTransport: HermesTransport
  apiServerTransport: HermesTransport
}

/** 分类决策（纯函数，便于测试） */
export function classifyHermesService(
  dashboard: DashboardProbeResult,
  apiServer: ApiServerProbeResult,
): HermesServiceClass {
  if (dashboard.protocolIncompatible || apiServer.protocolIncompatible) {
    return 'protocol-incompatible'
  }
  if (dashboard.available && apiServer.available) {
    return 'both'
  }
  if (dashboard.available) {
    return 'dashboard-only'
  }
  if (apiServer.available) {
    return 'api-only'
  }
  return 'unreachable'
}

/** 归一化 auth_flows 字段（容忍缺失/非数组） */
function normalizeAuthFlows(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  return []
}

/** 探测 Dashboard 是否支持密码登录（GET /api/auth/providers，best-effort） */
async function probePasswordSupport(transport: HermesTransport): Promise<boolean> {
  try {
    const providers = await transport.requestJson('/api/auth/providers', {
      timeoutMs: 6_000,
    })
    if (providers.status === 200 && providers.body && typeof providers.body === 'object') {
      const list = (providers.body as { providers?: unknown }).providers
      if (Array.isArray(list)) {
        return list.some(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { supports_password?: unknown }).supports_password === true,
        )
      }
    }
  } catch {
    // providers 探测失败不影响 dashboard 分类
  }
  return false
}

/**
 * 探测 Dashboard。
 *
 * - 200 + JSON → available；
 * - 401 → 服务存在但需认证（再探测 /api/auth/providers 拿 supportsPassword）；
 * - 404 / 网络错误 → unavailable；
 * - 非 JSON → protocolIncompatible。
 */
export async function probeDashboard(
  transport: HermesTransport,
): Promise<DashboardProbeResult> {
  let status: number
  let body: unknown
  try {
    const response = await transport.requestJson('/api/status', { timeoutMs: 6_000 })
    status = response.status
    body = response.body
  } catch (error) {
    // 网络/TLS/超时：不可达
    if (error instanceof HermesError && error.code === 'protocol-incompatible') {
      return {
        available: false,
        authRequired: false,
        authFlows: [],
        supportsPassword: false,
        version: null,
        protocolIncompatible: true,
      }
    }
    return {
      available: false,
      authRequired: false,
      authFlows: [],
      supportsPassword: false,
      version: null,
      protocolIncompatible: false,
    }
  }

  // 非 JSON 响应已在 transport 层抛 protocol-incompatible
  if (status === 401) {
    // 认证开启：探测密码 provider 支持
    return {
      available: true,
      authRequired: true,
      authFlows: [],
      supportsPassword: await probePasswordSupport(transport),
      version: null,
      protocolIncompatible: false,
    }
  }

  if (status !== 200 || body === null || typeof body !== 'object') {
    return {
      available: false,
      authRequired: false,
      authFlows: [],
      supportsPassword: false,
      version: null,
      protocolIncompatible: false,
    }
  }

  const data = body as DashboardStatusResponse
  const authRequired = data.auth_required === true
  return {
    available: true,
    authRequired,
    authFlows: normalizeAuthFlows(data.auth_flows),
    // auth_required 开启时同样探测密码 provider（200 + auth_required 场景）
    supportsPassword: authRequired ? await probePasswordSupport(transport) : false,
    version: typeof data.version === 'string' ? data.version : null,
    protocolIncompatible: false,
  }
}

/**
 * 探测 API Server。
 */
export async function probeApiServer(
  transport: HermesTransport,
): Promise<ApiServerProbeResult> {
  let status: number
  let body: unknown
  try {
    const response = await transport.requestJson('/v1/capabilities', { timeoutMs: 6_000 })
    status = response.status
    body = response.body
  } catch (error) {
    if (error instanceof HermesError && error.code === 'protocol-incompatible') {
      return {
        available: false,
        authRequired: false,
        endpoints: [],
        protocolIncompatible: true,
      }
    }
    return {
      available: false,
      authRequired: false,
      endpoints: [],
      protocolIncompatible: false,
    }
  }

  if (status === 401) {
    return {
      available: true,
      authRequired: true,
      endpoints: [],
      protocolIncompatible: false,
    }
  }

  if (status !== 200 || body === null || typeof body !== 'object') {
    return {
      available: false,
      authRequired: false,
      endpoints: [],
      protocolIncompatible: false,
    }
  }

  const data = body as ApiServerCapabilitiesResponse
  const endpoints = Array.isArray(data.endpoints)
    ? data.endpoints.filter((item): item is string => typeof item === 'string')
    : Array.isArray(data.capabilities)
      ? data.capabilities.filter((item): item is string => typeof item === 'string')
      : []
  return {
    available: true,
    authRequired: false,
    endpoints,
    protocolIncompatible: false,
  }
}

/**
 * 完整探测并生成能力快照。
 */
export async function probeHermesCapabilities(
  targets: HermesProbeTargets,
  now: number = Date.now(),
): Promise<HermesCapabilities> {
  const [dashboard, apiServer] = await Promise.all([
    probeDashboard(targets.dashboardTransport),
    probeApiServer(targets.apiServerTransport),
  ])
  return {
    probedAt: now,
    version: dashboard.version ?? null,
    serviceClass: classifyHermesService(dashboard, apiServer),
    dashboard: dashboard.available
      ? {
          authRequired: dashboard.authRequired,
          authFlows: dashboard.authFlows,
          supportsPassword: dashboard.supportsPassword,
        }
      : undefined,
    apiServer: apiServer.available
      ? {
          endpoints: apiServer.endpoints,
        }
      : undefined,
  }
}
