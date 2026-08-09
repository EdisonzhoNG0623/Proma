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
  HermesPublicTarget,
  HermesTargetCreateInput,
  HermesTargetUpdateInput,
  HermesAuthProviderInfo,
} from '@proma/shared'
import { hermesTargetStore } from './hermes-target-store'
import { hermesCredentialStore } from './hermes-credential-store'
import { HermesCredentialBroker, hermesCredentialBroker, type HermesCredentialState } from './hermes-credential-broker'
import { HermesCookieSessionManager, hermesCookieSessionManager } from './hermes-cookie-session'
import { buildHermesTransport, parseDashboardPasswordSecret } from './hermes-connection'
import { HermesEndpointManager, hermesEndpointManager } from './hermes-endpoint-manager'
import { HermesDashboardConnectionBroker, hermesDashboardConnectionBroker } from './hermes-dashboard-connection-broker'
import { HermesSshConnectionBroker, hermesSshConnectionBroker } from './hermes-ssh-connection-broker'
import { probeHermesCapabilities } from './hermes-capability-probe'
import { buildDashboardRestAuthHeaders, parseAuthProviders } from './hermes-auth'
import { HermesError, redactSecrets } from './hermes-errors'
import type { HermesRemoteProject, HermesRemoteSessionSummary, HermesHistoryMessage } from './hermes-dashboard-adapter'
import { HermesRemoteSftp } from './hermes-remote-sftp'
import { hermesKnownHostStore } from './hermes-known-host-store'
import { HermesSshHostKeyChallengeError } from './transport/hermes-ssh-connection'
import { agentEventBus } from '../agent-service'
import type { SDKMessage } from '@proma/shared'
import type { HermesRemoteFileEntry } from './hermes-remote-sftp'

/**
 * Hermes IPC 服务
 *
 * 默认使用全局 store 单例；测试可注入临时目录的 store 实例以隔离数据。
 */

/** 提取 SDKMessage 去重 key（user/assistant 文本；其他消息按类型+文本兜底） */
export function messageTextKey(msg: SDKMessage): string {
  const type = msg.type
  const content = (msg as { message?: { content?: unknown } }).message?.content
  let text = ''
  if (Array.isArray(content)) {
    text = content
      .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null && 'text' in b)
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('\n')
  }
  return `${type}:${text.slice(0, 500)}`
}

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

function historyRowText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (typeof block === 'string') return [block]
    if (!block || typeof block !== 'object') return []
    const value = block as { text?: unknown; content?: unknown }
    if (typeof value.text === 'string') return [value.text]
    if (typeof value.content === 'string') return [value.content]
    return []
  }).join('\n')
}

function historyRowToSDKMessage(
  row: unknown,
  identity: { targetId: string; remoteSessionId: string; promaSessionId: string; offset: number },
): SDKMessage | null {
  if (!row || typeof row !== 'object') return null
  const value = row as Record<string, unknown>
  const role = value.role
  // Hermes REST history is an execution transcript: system prompts and tool-result
  // rows can contain entire Skills/files and must not be flattened into chat bubbles.
  // Until the dedicated canonical Renderer exists, expose only human-visible turns.
  if (role !== 'user' && role !== 'assistant') return null
  const text = historyRowText(value.content ?? value.text)
  if (!text.trim()) return null
  const rowId = value.id ?? value.message_id ?? value.ordinal ?? identity.offset
  const uuid = `hermes:${identity.targetId}:dashboard:${identity.remoteSessionId}:${String(rowId)}`
  return {
    type: role === 'user' ? 'user' : 'assistant',
    uuid,
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: identity.promaSessionId,
    _createdAt: typeof value.created_at === 'number' ? value.created_at : undefined,
  } as SDKMessage
}

export class HermesIpcService {
  private readonly targetStore: typeof hermesTargetStore
  private readonly credentialStore: typeof hermesCredentialStore
  private readonly credentialBroker: HermesCredentialBroker
  private readonly cookieSessions: HermesCookieSessionManager
  private readonly endpointManager: HermesEndpointManager
  private readonly dashboardBroker: HermesDashboardConnectionBroker
  private readonly sshBroker: HermesSshConnectionBroker

  constructor(
    stores: {
      targetStore?: typeof hermesTargetStore
      credentialStore?: typeof hermesCredentialStore
      credentialBroker?: HermesCredentialBroker
      cookieSessions?: HermesCookieSessionManager
      endpointManager?: HermesEndpointManager
      dashboardBroker?: HermesDashboardConnectionBroker
      sshBroker?: HermesSshConnectionBroker
    } = {},
  ) {
    this.targetStore = stores.targetStore ?? hermesTargetStore
    this.credentialStore = stores.credentialStore ?? hermesCredentialStore
    this.credentialBroker = stores.credentialBroker
      ?? (stores.credentialStore ? new HermesCredentialBroker(stores.credentialStore) : hermesCredentialBroker)
    this.cookieSessions = stores.cookieSessions ?? hermesCookieSessionManager
    this.endpointManager = stores.endpointManager ?? hermesEndpointManager
    this.dashboardBroker = stores.dashboardBroker ?? hermesDashboardConnectionBroker
    this.sshBroker = stores.sshBroker ?? hermesSshConnectionBroker
  }

  private claimLegacyRefs(target: HermesTarget): void {
    const dashboardRef = target.auth.dashboardCredentialRef
    if (dashboardRef) {
      const slot = target.auth.dashboardMode === 'token' ? 'dashboard-token' : 'dashboard-password'
      this.credentialBroker.claimLegacyRef(target.id, slot, dashboardRef)
    }
    if (target.auth.apiServerKeyRef) {
      this.credentialBroker.claimLegacyRef(target.id, 'api-server-key', target.auth.apiServerKeyRef)
    }
    if (target.ssh?.credentialRef) {
      const meta = this.credentialStore.listCredentials().find((item) => item.ref === target.ssh?.credentialRef)
      const slot = meta?.kind === 'ssh-key' || meta?.kind === 'ssh-private-key' ? 'ssh-private-key' : 'ssh-password'
      this.credentialBroker.claimLegacyRef(target.id, slot, target.ssh.credentialRef)
    }
  }

  private publicTarget(target: HermesTarget): HermesPublicTarget {
    this.claimLegacyRefs(target)
    const { dashboardCredentialRef: _dashboardRef, apiServerKeyRef: _apiRef, ...auth } = target.auth
    const ssh = target.ssh
      ? (({ credentialRef: _credentialRef, localDashboardPort: _dashboardPort, localApiServerPort: _apiPort, ...safe }) => safe)(target.ssh)
      : undefined
    return {
      ...target,
      auth,
      ssh,
      credentialState: this.credentialBroker.credentialState(target.id) as HermesCredentialState,
    }
  }

  listTargets(): HermesPublicTarget[] {
    return this.targetStore.listTargets().map((target) => this.publicTarget(target))
  }

  getTarget(id: string): HermesPublicTarget | null {
    const target = this.targetStore.getTarget(id)
    return target ? this.publicTarget(target) : null
  }

  createTarget(input: HermesTargetCreateInput): HermesPublicTarget {
    return this.publicTarget(this.targetStore.createTarget(input))
  }

  async updateTarget(id: string, input: HermesTargetUpdateInput): Promise<HermesPublicTarget> {
    const before = this.targetStore.getTarget(id)
    if (!before) throw new Error(`Hermes Target 不存在: ${id}`)
    const updated = this.targetStore.updateTarget(id, input)
    const originChanged = before.endpoints?.dashboard?.baseUrl !== updated.endpoints?.dashboard?.baseUrl
    const authChanged = before.auth.dashboardMode !== updated.auth.dashboardMode
    if (originChanged || authChanged) await this.cookieSessions.clear(id)
    this.dashboardBroker.invalidate(id)
    this.endpointManager.invalidate(id)
    this.sshBroker.invalidate(id)
    return this.publicTarget(updated)
  }

  /** 删除 target 并清理该 target ownership 下全部凭据。 */
  async deleteTarget(id: string): Promise<HermesDeleteTargetResult> {
    const existing = this.targetStore.getTarget(id)
    if (!existing) return { ok: false, targetId: id, removedCredentialCount: 0 }
    this.claimLegacyRefs(existing)
    const removedCredentialCount = this.credentialBroker.clearTarget(id)
    await this.cookieSessions.clear(id)
    this.dashboardBroker.invalidate(id)
    this.endpointManager.invalidate(id)
    this.sshBroker.invalidate(id)
    this.targetStore.deleteTarget(id)
    return { ok: true, targetId: id, removedCredentialCount }
  }

  setDashboardPassword(input: HermesSetDashboardPasswordInput): HermesSetCredentialResult {
    if (!this.targetStore.getTarget(input.targetId)) throw new Error('Hermes target 不存在')
    const secret = JSON.stringify({ username: input.username, password: input.password })
    this.credentialBroker.setSecret(input.targetId, 'dashboard-password', secret)
    this.dashboardBroker.invalidate(input.targetId)
    this.endpointManager.invalidate(input.targetId)
    const target = this.targetStore.getTarget(input.targetId)!
    this.targetStore.updateTarget(input.targetId, {
      auth: {
        dashboardMode: target.auth.dashboardMode ?? 'password-cookie',
        dashboardProvider: input.provider ?? target.auth.dashboardProvider,
      },
    })
    return { configured: true }
  }

  setApiServerKey(input: HermesSetCredentialInput): HermesSetCredentialResult {
    if (!this.targetStore.getTarget(input.targetId)) throw new Error('Hermes target 不存在')
    this.credentialBroker.setSecret(input.targetId, 'api-server-key', input.secret)
    this.dashboardBroker.invalidate(input.targetId)
    this.endpointManager.invalidate(input.targetId)
    return { configured: true }
  }

  setSshPassword(input: HermesSetCredentialInput): HermesSetCredentialResult {
    const target = this.targetStore.getTarget(input.targetId)
    if (!target?.ssh) throw new Error('Hermes SSH target 不存在')
    this.credentialBroker.setSecret(input.targetId, 'ssh-password', input.secret)
    this.dashboardBroker.invalidate(input.targetId)
    this.endpointManager.invalidate(input.targetId)
    this.sshBroker.invalidate(input.targetId)
    return { configured: true }
  }

  /** 探测 target 能力并缓存快照 */
  async probeTarget(targetId: string): Promise<HermesCapabilities> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const lease = await this.endpointManager.acquire(target)
    try {
      const snapshot = await probeHermesCapabilities({
        dashboardTransport: lease.dashboard,
        apiServerTransport: lease.apiServer,
      })
      this.targetStore.updateTarget(targetId, { lastCapabilitySnapshot: snapshot })
      return snapshot
    } finally {
      lease.release()
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
        ...(error instanceof HermesSshHostKeyChallengeError
          ? { sshHostKeyChallenge: { challenge: error.challenge, fingerprint: error.fingerprint } }
          : {}),
      }
    }
  }

  confirmSshHostKey(targetId: string, challenge: string): boolean {
    const target = this.targetStore.getTarget(targetId)
    if (!target?.ssh) throw new Error('Hermes SSH target 不存在')
    hermesKnownHostStore.confirm(challenge, { host: target.ssh.host, port: target.ssh.port })
    this.sshBroker.invalidate(targetId)
    this.endpointManager.invalidate(targetId)
    return true
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

  /** 获取远端项目树（projects.tree） */
  async listRemoteProjects(targetId: string): Promise<HermesRemoteProject[]> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const lease = await this.dashboardBroker.acquire(target)
    try {
      const tree = await lease.withAdapter((adapter) => adapter.listProjects())
      return tree.projects
    } finally {
      lease.release()
    }
  }

  /** 获取某项目的完整会话分组（projects.project_sessions） */
  async listRemoteProjectSessions(targetId: string, projectId: string): Promise<HermesRemoteProject | null> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const lease = await this.dashboardBroker.acquire(target)
    try {
      return await lease.withAdapter((adapter) => adapter.listProjectSessions(projectId))
    } finally {
      lease.release()
    }
  }

  /** 获取远端会话列表（session.list） */
  async listRemoteSessions(targetId: string, limit = 100): Promise<HermesRemoteSessionSummary[]> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const lease = await this.dashboardBroker.acquire(target)
    try {
      return await lease.withAdapter((adapter) => adapter.listSessions(Math.min(Math.max(limit, 1), 500)))
    } finally {
      lease.release()
    }
  }

  /**
   * 从 Dashboard REST snapshot 读取远端历史。远端是唯一真源：
   * 不写 Agent JSONL、不按文本去重；每次打开都可由 snapshot 重建。
   */
  async getRemoteSessionHistory(
    promaSessionId: string,
    targetId: string,
    remoteSessionId: string,
    profile?: string,
  ): Promise<SDKMessage[]> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) throw new Error('Hermes target 未配置')
    this.claimLegacyRefs(target)
    const brokerLease = await this.dashboardBroker.acquire(target)
    const endpointLease = await this.endpointManager.acquire(target)
    try {
      const transport = endpointLease.dashboard
      if (!transport) throw new Error('Hermes target 未配置 Dashboard endpoint')
      const token = target.auth.dashboardMode === 'token'
        ? this.credentialBroker.getSecret(target.id, 'dashboard-token') ?? undefined
        : undefined
      const headers = buildDashboardRestAuthHeaders(target.auth.dashboardMode, token)
      const query = profile ? `?profile=${encodeURIComponent(profile)}` : ''
      const detail = await transport.requestJson(`/api/sessions/${encodeURIComponent(remoteSessionId)}${query}`, { headers, timeoutMs: 10_000 })
      if (detail.status === 404) return []
      if (detail.status !== 200 || !detail.body || typeof detail.body !== 'object') {
        throw new Error(`读取 Hermes session snapshot 失败（HTTP ${detail.status}）`)
      }
      const messageCount = Number((detail.body as { message_count?: unknown }).message_count ?? 0)
      const limit = 300
      const offset = Math.max(0, Number.isFinite(messageCount) ? messageCount - limit : 0)
      const separator = query ? '&' : '?'
      const response = await transport.requestJson(
        `/api/sessions/${encodeURIComponent(remoteSessionId)}/messages${query}${separator}limit=${limit}&offset=${offset}`,
        { headers, timeoutMs: 15_000 },
      )
      if (response.status !== 200 || !response.body || typeof response.body !== 'object') {
        throw new Error(`读取 Hermes messages snapshot 失败（HTTP ${response.status}）`)
      }
      const rows = (response.body as { messages?: unknown }).messages
      if (!Array.isArray(rows)) return []
      return rows.flatMap((row, index) => {
        const sdk = historyRowToSDKMessage(row, { targetId, remoteSessionId, promaSessionId, offset: offset + index })
        return sdk ? [sdk] : []
      })
    } finally {
      endpointLease.release()
      brokerLease.release()
    }
  }

  /** 将远端 snapshot 推入已打开会话的 live timeline。 */
  async hydrateRemoteSessionHistory(
    promaSessionId: string,
    targetId: string,
    remoteSessionId: string,
    profile?: string,
  ): Promise<number> {
    const snapshot = await this.getRemoteSessionHistory(promaSessionId, targetId, remoteSessionId, profile)
    for (const message of snapshot) agentEventBus.emit(promaSessionId, { kind: 'sdk_message', message })
    return snapshot.length
  }

  /**
   * 建立 SFTP 连接（SSH Tunnel target 的 SSH 配置）。
   * 调用方负责 close。
   */
  private async connectSftpForTarget(target: HermesTarget): Promise<{ sftp: HermesRemoteSftp; close(): void }> {
    if (!target.ssh) throw new Error('当前 Hermes target 无 SSH 配置')
    this.claimLegacyRefs(target)
    const lease = await this.sshBroker.acquire(target)
    const sftp = new HermesRemoteSftp(lease.connection)
    try {
      await sftp.connect()
      return { sftp, close: () => { sftp.close(); lease.release() } }
    } catch (error) {
      lease.release()
      throw error
    }
  }

  /** 远端项目根目录约定 */
  private remoteProjectsRoot(_target: HermesTarget): string {
    return '~/proma-projects'
  }

  /** 创建远端项目（在远端建目录 ~/proma-projects/<name>） */
  async createRemoteProject(targetId: string, name: string): Promise<string> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) {
      throw new Error('Hermes target 不存在')
    }
    const safeName = name.trim().replace(/[^\w.-]/g, '-')
    if (!safeName) {
      throw new Error('项目名称无效')
    }
    const connection = await this.connectSftpForTarget(target)
    try {
      return await connection.sftp.createProject(this.remoteProjectsRoot(target), safeName)
    } finally {
      connection.close()
    }
  }

  /** 列出远端项目文件（一级目录） */
  async listRemoteProjectFiles(targetId: string, rootPath: string, remotePath: string): Promise<HermesRemoteFileEntry[]> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) throw new Error('Hermes target 不存在')
    const connection = await this.connectSftpForTarget(target)
    try {
      return await connection.sftp.listDir(rootPath, remotePath)
    } finally {
      connection.close()
    }
  }

  /** 读取远端文件内容（文本） */
  async readRemoteFile(targetId: string, rootPath: string, remotePath: string, maxBytes?: number): Promise<string> {
    const target = this.targetStore.getTarget(targetId)
    if (!target) throw new Error('Hermes target 不存在')
    const connection = await this.connectSftpForTarget(target)
    try {
      return await connection.sftp.readFile(rootPath, remotePath, maxBytes)
    } finally {
      connection.close()
    }
  }
}

/** 单例 */
export const hermesIpcService = new HermesIpcService()
