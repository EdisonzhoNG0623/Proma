/**
 * Hermes IPC handlers
 *
 * 独立注册 Hermes Remote 相关 IPC 处理器（主进程侧），
 * 由 main/ipc.ts 的 registerIpcHandlers 统一调用。
 *
 * 安全约束：密码 / API key 仅经 IPC 传入主进程 CredentialStore，
 * 永不通过 IPC 返回明文（返回值只有 ref）。
 */

import { ipcMain } from 'electron'
import { HERMES_IPC_CHANNELS } from '@proma/shared'
import type {
  HermesCapabilities,
  HermesTarget,
  HermesTargetCreateInput,
  HermesTargetUpdateInput,
  HermesSetDashboardPasswordInput,
} from '@proma/shared'
import { hermesIpcService } from './hermes-ipc-service'

/** 校验字符串参数 */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} 必填`)
  }
  return value
}

/**
 * 注册 Hermes IPC 处理器。
 */
export function registerHermesIpcHandlers(): void {
  // ---- Target CRUD ----
  ipcMain.handle(HERMES_IPC_CHANNELS.LIST_TARGETS, (): HermesTarget[] => {
    return hermesIpcService.listTargets()
  })

  ipcMain.handle(HERMES_IPC_CHANNELS.GET_TARGET, (_, id: string): HermesTarget | null => {
    return hermesIpcService.getTarget(requireString(id, 'id'))
  })

  ipcMain.handle(
    HERMES_IPC_CHANNELS.CREATE_TARGET,
    (_, input: HermesTargetCreateInput): HermesTarget => {
      if (!input || typeof input !== 'object') throw new Error('input 必填')
      return hermesIpcService.createTarget(input)
    },
  )

  ipcMain.handle(
    HERMES_IPC_CHANNELS.UPDATE_TARGET,
    (_, id: string, input: HermesTargetUpdateInput): HermesTarget => {
      if (!input || typeof input !== 'object') throw new Error('input 必填')
      return hermesIpcService.updateTarget(requireString(id, 'id'), input)
    },
  )

  ipcMain.handle(HERMES_IPC_CHANNELS.DELETE_TARGET, (_, id: string) => {
    return hermesIpcService.deleteTarget(requireString(id, 'id'))
  })

  // ---- 能力探测 / 连接测试 ----
  ipcMain.handle(
    HERMES_IPC_CHANNELS.PROBE_TARGET,
    async (_, id: string): Promise<HermesCapabilities> => {
      return await hermesIpcService.probeTarget(requireString(id, 'id'))
    },
  )

  ipcMain.handle(HERMES_IPC_CHANNELS.TEST_CONNECTION, async (_, id: string) => {
    return await hermesIpcService.testConnection(requireString(id, 'id'))
  })

  ipcMain.handle(HERMES_IPC_CHANNELS.GET_AUTH_PROVIDERS, async (_, id: string) => {
    return await hermesIpcService.getAuthProviders(requireString(id, 'id'))
  })

  // ---- 凭据管理（只进不出）----
  ipcMain.handle(
    HERMES_IPC_CHANNELS.SET_DASHBOARD_PASSWORD,
    (_, input: HermesSetDashboardPasswordInput) => {
      if (!input || typeof input !== 'object') throw new Error('input 必填')
      requireString(input.password, 'password')
      requireString(input.username, 'username')
      return hermesIpcService.setDashboardPassword(input)
    },
  )

  ipcMain.handle(HERMES_IPC_CHANNELS.SET_API_SERVER_KEY, (_, input: { targetId?: string; ref?: string; secret: string }) => {
    if (!input || typeof input !== 'object') throw new Error('input 必填')
    requireString(input.secret, 'secret')
    return hermesIpcService.setApiServerKey({ targetId: input.targetId, ref: input.ref, secret: input.secret })
  })

  ipcMain.handle(HERMES_IPC_CHANNELS.SET_SSH_PASSWORD, (_, input: { targetId?: string; ref?: string; secret: string }) => {
    if (!input || typeof input !== 'object') throw new Error('input 必填')
    requireString(input.secret, 'secret')
    return hermesIpcService.setSshPassword({ targetId: input.targetId, ref: input.ref, secret: input.secret })
  })

  ipcMain.handle(HERMES_IPC_CHANNELS.DELETE_CREDENTIAL, (_, ref: string): boolean => {
    return hermesIpcService.deleteCredential(requireString(ref, 'ref'))
  })

  // ---- 远端项目/会话视图 ----
  ipcMain.handle(HERMES_IPC_CHANNELS.LIST_REMOTE_PROJECTS, async (_, targetId: string) => {
    return await hermesIpcService.listRemoteProjects(requireString(targetId, 'targetId'))
  })

  ipcMain.handle(HERMES_IPC_CHANNELS.LIST_REMOTE_PROJECT_SESSIONS, async (_, targetId: string, projectId: string) => {
    return await hermesIpcService.listRemoteProjectSessions(
      requireString(targetId, 'targetId'),
      requireString(projectId, 'projectId'),
    )
  })

  ipcMain.handle(HERMES_IPC_CHANNELS.LIST_REMOTE_SESSIONS, async (_, targetId: string, limit?: number) => {
    return await hermesIpcService.listRemoteSessions(requireString(targetId, 'targetId'), limit ?? 100)
  })
}
