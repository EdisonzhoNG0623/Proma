/**
 * Hermes Auth 认证编排
 *
 * 负责 Dashboard 认证的完整流程：
 * 1. 探测认证模式（token / password-cookie / native-pkce）
 * 2. 密码登录：`POST /auth/password-login`（provider/username/password）
 * 3. 维护按 target 隔离的 Cookie Jar（内存态；后续可切换 Electron session partition）
 * 4. WS ticket：`POST /api/auth/ws-ticket`，返回单次使用 ticket
 *
 * 安全约束（来自方案文档）：
 * - 密码只在登录请求期间存在于内存，成功/失败后立即清空；
 * - 密码不出现在 URL、日志、Renderer；
 * - 401/429/503 正确映射（不区分用户不存在与密码错误）；
 * - Direct HTTP 非 loopback 地址默认禁止提交密码。
 */

import { HermesError, hermesErrorFromHttpStatus } from './hermes-errors'
import type { HermesDashboardAuthMode } from '@proma/shared'
import type { HermesTransport } from './transport/hermes-transport'

/** Cookie Jar：按 targetId 隔离的 Cookie 存储（首版内存态） */
export type HermesCookieJar = Map<string, string>

/** 认证模式探测结果 */
export type HermesAuthFlow = 'token' | 'password-cookie' | 'native-pkce' | 'none'

/** Dashboard 认证提供方信息 */
export interface HermesAuthProviderInfo {
  name: string
  displayName: string
  supportsPassword: boolean
}

/** 密码登录请求体 */
export interface HermesPasswordLoginInput {
  provider: string
  username: string
  password: string
  /** 登录后跳转目标（默认 /） */
  next?: string
}

/** 密码登录结果 */
export interface HermesPasswordLoginResult {
  ok: boolean
  next: string
}

/** 判断 URL 是否为本地 loopback（用于密码提交安全检查） */
export function isLoopbackUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.startsWith('127.')
    )
  } catch {
    return false
  }
}

/**
 * 检查是否允许提交密码到该 URL。
 *
 * 规则：https 总是允许；http 仅允许 loopback（Direct loopback 或 SSH Tunnel 后）。
 */
export function canSubmitPasswordTo(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') {
      return true
    }
    if (parsed.protocol === 'http:') {
      return isLoopbackUrl(url)
    }
    return false
  } catch {
    return false
  }
}

/** 从 providers 响应中解析提供方列表（容忍缺失/畸形字段） */
export function parseAuthProviders(body: unknown): HermesAuthProviderInfo[] {
  if (!body || typeof body !== 'object') {
    return []
  }
  const list = (body as { providers?: unknown }).providers
  if (!Array.isArray(list)) {
    return []
  }
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const info = item as { name?: unknown; display_name?: unknown; supports_password?: unknown }
    if (typeof info.name !== 'string' || !info.name) return []
    return [
      {
        name: info.name,
        displayName: typeof info.display_name === 'string' ? info.display_name : info.name,
        supportsPassword: info.supports_password === true,
      },
    ]
  })
}

/** 解析密码登录响应（{"ok":true,"next":path} 或错误） */
export function parsePasswordLoginResponse(
  status: number,
  body: unknown,
): HermesPasswordLoginResult {
  if (status === 200 && body && typeof body === 'object') {
    const data = body as { ok?: unknown; next?: unknown }
    return {
      ok: data.ok === true,
      next: typeof data.next === 'string' ? data.next : '/',
    }
  }
  if (status === 200) {
    // 非 JSON 或结构不符：视为登录失败（服务器可能返回 HTML 登录页）
    throw new HermesError('远端登录响应格式异常', 'protocol-incompatible', status)
  }
  throw hermesErrorFromHttpStatus(status, 'Hermes 登录失败')
}

/** 解析 WS ticket 响应（{"ticket":"..."}） */
export function parseWsTicketResponse(body: unknown): string {
  if (!body || typeof body !== 'object') {
    throw new HermesError('远端返回无效的 WS ticket 响应', 'invalid-response')
  }
  const ticket = (body as { ticket?: unknown }).ticket
  if (typeof ticket !== 'string' || !ticket) {
    throw new HermesError('远端未返回 WS ticket', 'invalid-response')
  }
  return ticket
}

/** 构建 WS URL，保留 reverse-proxy path prefix。 */
function buildDashboardWsUrl(baseUrl: string, key?: 'ticket' | 'token', secret?: string): string {
  const parsed = new URL(baseUrl)
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  const prefix = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = `${prefix}/api/ws`.replace(/\/{2,}/g, '/')
  parsed.search = key && secret ? `${key}=${encodeURIComponent(secret)}` : ''
  return parsed.toString()
}

export function buildUnauthenticatedWsUrl(baseUrl: string): string {
  return buildDashboardWsUrl(baseUrl)
}

export function buildTicketWsUrl(baseUrl: string, ticket: string): string {
  return buildDashboardWsUrl(baseUrl, 'ticket', ticket)
}

export function buildTokenWsUrl(baseUrl: string, token: string): string {
  return buildDashboardWsUrl(baseUrl, 'token', token)
}

/** Dashboard token 只进入指定 header；password-cookie 不人工复制 Cookie。 */
export function buildDashboardRestAuthHeaders(
  mode: HermesDashboardAuthMode | undefined,
  secret?: string,
): Record<string, string> {
  if (!mode || mode === 'password-cookie') return {}
  if (mode === 'native-pkce') {
    throw new HermesError('Hermes native-pkce 认证暂不支持', 'protocol-incompatible')
  }
  if (!secret) throw new HermesError('Hermes Dashboard token 缺失', 'unauthorized')
  return { 'X-Hermes-Session-Token': secret }
}

/**
 * Hermes Auth 服务
 *
 * 通过注入 transport 执行 HTTP 请求；Cookie Jar 按 targetId 隔离。
 */
export class HermesAuthService {
  private readonly cookieJars = new Map<string, HermesCookieJar>()

  constructor(
    private readonly transport: HermesTransport,
    private readonly options: { browserCookies?: boolean } = {},
  ) {}

  /** 获取（或创建）指定 target 的 Cookie Jar */
  cookieJarFor(targetId: string): HermesCookieJar {
    let jar = this.cookieJars.get(targetId)
    if (!jar) {
      jar = new Map<string, string>()
      this.cookieJars.set(targetId, jar)
    }
    return jar
  }

  /** 将 Cookie Jar 序列化为 Cookie 头（多个 cookie 用 ; 连接） */
  serializeCookies(jar: HermesCookieJar): string | undefined {
    const parts: string[] = []
    for (const [name, value] of jar.entries()) {
      parts.push(`${name}=${value}`)
    }
    return parts.length > 0 ? parts.join('; ') : undefined
  }

  /** 从 Set-Cookie 头解析并写入 Jar */
  captureCookies(jar: HermesCookieJar, setCookieHeader: unknown): void {
    const rawValues = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : typeof setCookieHeader === 'string'
        ? [setCookieHeader]
        : []
    for (const raw of rawValues) {
      if (typeof raw !== 'string') continue
      const first = raw.split(';')[0]
      if (!first) continue
      const eqIndex = first.indexOf('=')
      if (eqIndex <= 0) continue
      const name = first.slice(0, eqIndex).trim()
      const value = first.slice(eqIndex + 1).trim()
      if (name) {
        jar.set(name, value)
      }
    }
  }

  /**
   * 密码登录。
   *
   * 成功后把 Set-Cookie 写入 target 专属 Jar；无论成败，密码在方法结束时
   * 即不再被引用（函数作用域内参数不可变；调用方负责清空输入对象）。
   *
   * @throws HermesError：401（账号或密码错误）、429（尝试过多）、503（provider 不可用）等
   */
  async passwordLogin(
    targetId: string,
    input: HermesPasswordLoginInput,
  ): Promise<HermesPasswordLoginResult> {
    const body = {
      provider: input.provider,
      username: input.username,
      password: input.password,
      next: input.next ?? '/',
    }
    // 请求体 JSON 序列化可能包含密码；日志必须脱敏（此处仅构造请求，不记录）
    const response = await this.transport.requestJson('/auth/password-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    // 捕获 Set-Cookie（transport 层 Response headers 由实现注入；此处约定通过
    // requestJson 返回的 body 之外，由 transport 实现将 headers 透出——见
    // HermesTransport 扩展：response.headers）
    if (!this.options.browserCookies) {
      this.captureCookies(this.cookieJarFor(targetId), response.headers?.['set-cookie'])
    }
    return parsePasswordLoginResponse(response.status, response.body)
  }

  /**
   * 获取 WS ticket（使用 target 的 Cookie 会话）。
   */
  async mintWsTicket(targetId: string): Promise<string> {
    const jar = this.cookieJarFor(targetId)
    const cookieHeader = this.options.browserCookies ? undefined : this.serializeCookies(jar)
    const response = await this.transport.requestJson('/api/auth/ws-ticket', {
      method: 'POST',
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    })
    if (!this.options.browserCookies) this.captureCookies(jar, response.headers?.['set-cookie'])
    if (response.status !== 200) {
      throw hermesErrorFromHttpStatus(response.status, '获取 WS ticket 失败')
    }
    return parseWsTicketResponse(response.body)
  }

  /** 清理指定 target 的 Cookie（登出/删除连接时调用） */
  clearCookies(targetId: string): void {
    this.cookieJars.delete(targetId)
  }
}
