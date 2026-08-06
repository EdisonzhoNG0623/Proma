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
import { buildHermesTransport } from './hermes-connection'
import { probeHermesCapabilities } from './hermes-capability-probe'
import { parseAuthProviders } from './hermes-auth'
import { redactSecrets } from './hermes-errors'

/**
 * Hermes IPC 服务
 *
 * 默认使用全局 store 单例；测试可注入临时目录的 store 实例以隔离数据。
 */
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
}

/** 单例 */
export const hermesIpcService = new HermesIpcService()
