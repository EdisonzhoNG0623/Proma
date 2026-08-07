/**
 * Hermes IPC 服务层
 *
 * 封装 Target Store / Credential Store / 能力探测 / 认证 provider 探测，
 * 供主进程 IPC handlers 调用（薄 handler + 服务层模式，参考 channel-manager）。
 *
 * 安全约束：
 * - 密码 / API key 只进 CredentialStore（safeStorage），不进 Renderer；
 * - 探测时构建的 transport 用完即 dispose；
 * - 删除 target 时同步清理关联凭据引用。
 */

import type {
  HermesCapabilities,
  HermesConnectionTestResult,
  HermesDeleteTargetResult,
  HermesSetCredentialInput,
  HermesSetCredentialResult,
  HermesSetDashboardPasswordInput,
  HermesTarget,
  HermesTargetCreateInput,
  HermesTargetUpdateInput,
  HermesAuthProviderInfo,
} from '@proma/shared'
import { hermesTargetStore } from './hermes-target-store'
import { hermesCredentialStore, type HermesCredentialKind } from './hermes-credential-store'
import { buildHermesTransport, parseDashboardPasswordSecret } from './hermes-connection'
import { probeHermesCapabilities } from './hermes-capability-probe'
import { parseAuthProviders } from './hermes-auth'
import { HermesError, redactSecrets } from './hermes-errors'
import { HermesAuthService, buildTicketWsUrl, canSubmitPasswordTo } from './hermes-auth'
import { HermesDashboardAdapter, type HermesRemoteProject, type HermesRemoteSessionSummary, type HermesHistoryMessage } from './hermes-dashboard-adapter'
import { HermesDashboardWsClient } from './hermes-dashboard-ws-client'
import { appendSDKMessages } from '../agent-session-manager'
import type { SDKMessage } from '@proma/shared'
import type { HermesTransport } from './transport/hermes-transport'

/**
 * Hermes IPC 服务
 *
 * 默认使用全局 store 单例；测试可注入临时目录的 store 实例以隔离数据。
 */

/** 将远端历史消息转为 Proma SDKMessage（user/assistant 文本） */
export function historyToSDKMessage(
  message: HermesHistoryMessage,
  promaSessionId: string,
): SDKMessage {
  if (message.role === 'user') {
    return {
      type: 'user',
      message: {
        content: [{ type: 'text', text: message.text }],
      },
      parent_tool_use_id: null,
      session_id: promaSessionId,
    } as SDKMessage
  }
  // assistant / system / tool 统一按 assistant 文本展示（首版简化）
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: message.text }],
    },
    parent_tool_use_id: null,
    session_id: promaSessionId,
  } as SDKMessage
}

export class HermesIpcService {
  private readonly targetStore: typeof hermesTargetStore
  private readonly credentialStore: typeof hermesCredentialStore

  constructor(
    stores: {
      targetStore?: typeof hermesTargetStore
      credentialStore?: typeof hermesCredentialStore
    } = {},
  ) {
    this.targetStore = stores.targetStore ?? hermesTargetStore
    this.credentialStore = stores.credentialStore ?? hermesCredentialStore
  }

  listTargets(): HermesTarget[] {
    return this.targetStore.listTargets()
  }

  getTarget(id: string): HermesTarget | null {
    return this.targetStore.getTarget(id)
  }

  createTarget(input: HermesTargetCreateInput): HermesTarget {
    return this.targetStore.createTarget(input)
  }

  updateTarget(id: string, input: HermesTargetUpdateInput): HermesTarget {
    return this.targetStore.updateTarget(id, input)
  }

  /** 删除 target 并清理关联凭据（dashboard / api server / ssh） */
  deleteTarget(id: string): HermesDeleteTargetResult {
    const removed = this.targetStore.deleteTarget(id)
    if (!removed) {
      return { ok: false, targetId: id, removedCredentialRefs: [] }
    }
    const refs: string[] = []
    if (removed.auth.dashboardCredentialRef) refs.push(removed.auth.dashboardCredentialRef)
    if (removed.auth.apiServerKeyRef) refs.push(removed.auth.apiServerKeyRef)
    if (removed.ssh?.credentialRef) refs.push(removed.ssh.credentialRef)
    for (const ref of refs) {
      this.credentialStore.deleteCredential(ref)
    }
    return { ok: true, targetId: id, removedCredentialRefs: refs }
  }

  /** 保存任意类型凭据 */
  setCredential(kind: HermesCredentialKind, input: HermesSetCredentialInput): HermesSetCredentialResult {
    const ref = this.credentialStore.setCredential(kind, input.secret, input.ref)
    return { ref }
  }

  /** 保存 Dashboard 账号密码（JSON 编码）并更新 target 引用 */
  setDashboardPassword(input: HermesSetDashboardPasswordInput): HermesSetCredentialResult {
    const secret = JSON.stringify({ username: input.username, password: input.password })
    const ref = this.credentialStore.setCredential('dashboard-password', secret, input.ref)
    if (input.targetId) {
      const target = this.targetStore.getTarget(input.targetId)
      if (target) {
        this.targetStore.updateTarget(input.targetId, {
          auth: {
            ...target.auth,
            dashboardCredentialRef: ref,
            ...(input.provider ? { dashboardProvider: input.provider } : {}),
          },
        })
      }
    }
    return { ref }
  }

  /** 保存 API Server key 并更新 target 引用 */
  setApiServerKey(input: HermesSetCredentialInput): HermesSetCredentialResult {
    const ref = this.credentialStore.setCredential('api-server-key', input.secret, input.ref)
    if (input.targetId) {
      const target = this.targetStore.getTarget(input.targetId)
      if (target) {
        this.targetStore.updateTarget(input.targetId, {
          auth: { ...target.auth, apiServerKeyRef: ref },
        })
      }
    }
    return { ref }
  }

  /** 保存 SSH 密码并更新 target 引用 */
  setSshPassword(input: HermesSetCredentialInput): HermesSetCredentialResult {
    const ref = this.credentialStore.setCredential('ssh-password', input.secret, input.ref)
    if (input.targetId) {
      const target = this.targetStore.getTarget(input.targetId)
      if (target?.ssh) {
        this.targetStore.updateTarget(input.targetId, {
          ssh: { ...target.ssh, credentialRef: ref },
        })
      }
    }
    return { ref }
  }

  deleteCredential(ref: string): boolean {
    return this.credentialStore.deleteCredential(ref)
  }

  /** 探测 target 能力并缓存快照 */
  async probeTarget(targetId: string): Promise<HermesCapabilities> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const transport = await buildHermesTransport(target)
    try {
      const snapshot = await probeHermesCapabilities({
        dashboardTransport: transport,
        apiServerTransport: transport,
      })
      this.targetStore.updateTarget(targetId, { lastCapabilitySnapshot: snapshot })
      return snapshot
    } finally {
      transport.dispose()
    }
  }

  /** 连接测试（向导：可达性 + 认证形态 + 密码支持） */
  async testConnection(targetId: string): Promise<HermesConnectionTestResult> {
    try {
      const snapshot = await this.probeTarget(targetId)
      return {
        ok: snapshot.serviceClass !== 'unreachable' && snapshot.serviceClass !== 'protocol-incompatible',
        serviceClass: snapshot.serviceClass,
        authRequired: snapshot.dashboard?.authRequired ?? false,
        supportsPassword: snapshot.dashboard?.supportsPassword ?? false,
        version: snapshot.version,
        error: null,
      }
    } catch (error) {
      return {
        ok: false,
        serviceClass: null,
        authRequired: false,
        supportsPassword: false,
        version: null,
        error: error instanceof Error ? redactSecrets(error.message) : String(error),
      }
    }
  }

  /** 探测 target 的登录 provider 列表（GET /api/auth/providers，公开接口） */
  async getAuthProviders(targetId: string): Promise<HermesAuthProviderInfo[]> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const transport = await buildHermesTransport(target)
    try {
      const response = await transport.requestJson('/api/auth/providers', { timeoutMs: 6_000 })
      if (response.status !== 200) {
        return []
      }
      return parseAuthProviders(response.body)
    } catch (error) {
      // 探测失败视为无 provider
      console.warn('[Hermes] 探测 auth providers 失败:', error instanceof Error ? error.message : String(error))
      return []
    } finally {
      transport.dispose()
    }
  }

  /**
   * 打开临时 Dashboard WS 连接（用于项目/会话视图 RPC）。
   *
   * 认证策略：优先复用已持久化的 Cookie 会话（避免频繁密码登录触发限流）；
   * 401 时回退密码登录并更新 Cookie。
   */
  private async openDashboardAdapter(target: HermesTarget): Promise<{
    adapter: HermesDashboardAdapter
    transport: HermesTransport
    close: () => void
  }> {
    const transport = await buildHermesTransport(target)
    const cookieRef = `hermes-cookie-${target.id}`
    try {
      const auth = new HermesAuthService(transport)
      const mode = target.auth.dashboardMode ?? 'password-cookie'

      // 1. 优先复用持久化 Cookie
      const persistedCookie = this.credentialStore.getCredential(cookieRef)
      if (mode === 'password-cookie' && persistedCookie) {
        try {
          const jar = JSON.parse(persistedCookie) as Record<string, string>
          for (const [name, value] of Object.entries(jar)) {
            auth.cookieJarFor(target.id).set(name, value)
          }
        } catch {
          // Cookie 解析失败则忽略，走登录流程
        }
      }

      // 2. 尝试用现有 Cookie 直接 mint ticket；失败（401）再密码登录
      let ticket: string
      try {
        ticket = await auth.mintWsTicket(target.id)
      } catch (error) {
        const isAuthError = error instanceof HermesError && error.code === 'unauthorized'
        if (!isAuthError || mode !== 'password-cookie') {
          throw error
        }
        // 3. 密码登录并持久化 Cookie
        const secret = target.auth.dashboardCredentialRef
          ? this.credentialStore.getCredential(target.auth.dashboardCredentialRef)
          : null
        if (!secret) {
          throw new Error('缺少 Hermes 账号密码凭据，请在 Hermes 设置中登录')
        }
        const credential = parseDashboardPasswordSecret(secret)
        if (!canSubmitPasswordTo(transport.baseUrl)) {
          throw new Error('http 非 loopback 地址不允许提交 Hermes 密码（请使用 HTTPS 或 SSH Tunnel）')
        }
        await auth.passwordLogin(target.id, {
          provider: target.auth.dashboardProvider ?? 'basic',
          username: credential.username,
          password: credential.password,
        })
        // 持久化 Cookie（含 refresh cookie，供后续复用）
        const jar = Object.fromEntries(auth.cookieJarFor(target.id).entries())
        if (Object.keys(jar).length > 0) {
          try {
            this.credentialStore.setCredential('dashboard-cookie', JSON.stringify(jar), cookieRef)
          } catch (cookieError) {
            console.warn('[Hermes] 持久化 Dashboard Cookie 失败:', cookieError instanceof Error ? cookieError.message : String(cookieError))
          }
        }
        ticket = await auth.mintWsTicket(target.id)
      }

      const wsUrl = buildTicketWsUrl(transport.baseUrl, ticket)
      const client = new HermesDashboardWsClient((url) => transport.connectWebSocket(url))
      await client.connect(wsUrl)
      const adapter = new HermesDashboardAdapter(client)
      return {
        adapter,
        transport,
        close: () => {
          client.close()
          transport.dispose()
        },
      }
    } catch (error) {
      transport.dispose()
      throw error
    }
  }

  /** 获取远端项目树（projects.tree） */
  async listRemoteProjects(targetId: string): Promise<HermesRemoteProject[]> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const session = await this.openDashboardAdapter(target)
    try {
      const tree = await session.adapter.listProjects()
      return tree.projects
    } finally {
      session.close()
    }
  }

  /** 获取某项目的完整会话分组（projects.project_sessions） */
  async listRemoteProjectSessions(targetId: string, projectId: string): Promise<HermesRemoteProject | null> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const session = await this.openDashboardAdapter(target)
    try {
      return await session.adapter.listProjectSessions(projectId)
    } finally {
      session.close()
    }
  }

  /** 获取远端会话列表（session.list） */
  async listRemoteSessions(targetId: string, limit = 100): Promise<HermesRemoteSessionSummary[]> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const session = await this.openDashboardAdapter(target)
    try {
      return await session.adapter.listSessions(limit)
    } finally {
      session.close()
    }
  }

  /**
   * 拉取远端会话历史并写入 Proma 会话（打开远端会话后展示历史消息）。
   *
   * 流程：resume 远端会话 → session.history → 转 SDKMessage → appendSDKMessages。
   */
  async hydrateRemoteSessionHistory(
    promaSessionId: string,
    targetId: string,
    remoteSessionId: string,
    profile?: string,
  ): Promise<number> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const session = await this.openDashboardAdapter(target)
    try {
      // resume 远端会话拿 runtime session id
      const resumed = await session.adapter.resumeSession(remoteSessionId, {
        profile,
        cols: 96,
      }).catch(() => null)
      if (!resumed) {
        return 0
      }
      const history = await session.adapter.getSessionHistory(resumed.sessionId)
      if (history.length === 0) {
        return 0
      }
      const sdkMessages: SDKMessage[] = history.map((message) =>
        historyToSDKMessage(message, promaSessionId),
      )
      appendSDKMessages(promaSessionId, sdkMessages)
      return history.length
    } finally {
      session.close()
    }
  }
}

/** 单例 */
export const hermesIpcService = new HermesIpcService()
