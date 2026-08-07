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
import { respondHermesInteraction } from '../agent-service'
import {
  createAgentSession,
  updateAgentSessionMeta,
  listAgentSessions,
  deleteAgentSession,
} from '../agent-session-manager'

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

  // 同步本地项目到远端 Hermes（SFTP 增量上传）
  ipcMain.handle(
    HERMES_IPC_CHANNELS.SYNC_PROJECT_TO_REMOTE,
    async (_, targetId: string, workspaceId: string) => {
      return await hermesIpcService.syncProjectToRemote(
        requireString(targetId, 'targetId'),
        requireString(workspaceId, 'workspaceId'),
      )
    },
  )

  // 创建远端项目（SFTP mkdir ~/proma-projects/<name>）
  ipcMain.handle(HERMES_IPC_CHANNELS.CREATE_REMOTE_PROJECT, async (_, targetId: string, name: string) => {
    return await hermesIpcService.createRemoteProject(requireString(targetId, 'targetId'), requireString(name, 'name'))
  })

  // 列出远端项目文件
  ipcMain.handle(HERMES_IPC_CHANNELS.LIST_REMOTE_FILES, async (_, targetId: string, remotePath: string) => {
    return await hermesIpcService.listRemoteProjectFiles(requireString(targetId, 'targetId'), requireString(remotePath, 'remotePath'))
  })

  // 读取远端文件内容
  ipcMain.handle(HERMES_IPC_CHANNELS.READ_REMOTE_FILE, async (_, targetId: string, remotePath: string) => {
    return await hermesIpcService.readRemoteFile(requireString(targetId, 'targetId'), requireString(remotePath, 'remotePath'))
  })

  // 响应 Hermes 交互请求（approval/clarify/sudo/secret）
  ipcMain.handle(
    HERMES_IPC_CHANNELS.RESPOND_INTERACTION,
    async (_, input: { sessionId: string; type: 'approval' | 'clarify' | 'sudo' | 'secret'; requestId?: string; choice?: 'allow' | 'deny'; all?: boolean; answer?: string; password?: string; value?: string }) => {
      if (!input || typeof input !== 'object') throw new Error('input 必填')
      requireString(input.sessionId, 'sessionId')
      return await respondHermesInteraction(input)
    },
  )

  // 从远端会话创建并绑定 Proma Agent 会话（打开后恢复远端会话；或新建远端会话并绑定目录）
  ipcMain.handle(
    HERMES_IPC_CHANNELS.CREATE_REMOTE_SESSION,
    async (_, input: { targetId: string; remoteSessionId?: string; remoteCwd?: string; title?: string; workspaceId?: string }) => {
      if (!input || typeof input !== 'object') throw new Error('input 必填')
      requireString(input.targetId, 'targetId')

      // 去重：同一 target + 远端会话已绑定过 Proma 会话时复用，避免重复创建
      const existing = input.remoteSessionId
        ? listAgentSessions().find(
            (session) =>
              session.agentRuntime === 'hermes-remote' &&
              session.hermesTargetId === input.targetId &&
              session.hermesRemoteSessionId === input.remoteSessionId,
          )
        : undefined
      if (existing) {
        return existing
      }

      // 创建 Hermes Remote 会话（channelId 用占位 'hermes-remote'，runtime 为 hermes-remote）
      const session = createAgentSession(
        input.title || 'Hermes 远端会话',
        'hermes-remote',
        input.workspaceId,
        undefined,
        'hermes-remote',
      )
      updateAgentSessionMeta(session.id, {
        agentRuntime: 'hermes-remote',
        hermesTargetId: input.targetId,
        ...(input.remoteSessionId ? { hermesRemoteSessionId: input.remoteSessionId } : {}),
        ...(input.remoteCwd ? { hermesRemoteCwd: input.remoteCwd } : {}),
      })
      // 已有远端会话：同步拉取历史写入（打开前完成）；新建会话无历史跳过
      if (input.remoteSessionId) {
        await hermesIpcService
          .hydrateRemoteSessionHistory(session.id, input.targetId, input.remoteSessionId)
          .catch((error) => {
            console.error('[Hermes] 加载远端历史失败:', error instanceof Error ? error.message : String(error))
          })
      }
      return session
    },
  )

  // 清理重复的远端会话（同一 target + 远端会话保留最早创建的一个）
  ipcMain.handle(
    HERMES_IPC_CHANNELS.DEDUPE_REMOTE_SESSIONS,
    async (): Promise<number> => {
      const sessions = listAgentSessions()
      const seen = new Set<string>()
      const toDelete: string[] = []
      for (const session of sessions) {
        if (session.agentRuntime !== 'hermes-remote') continue
        if (!session.hermesTargetId || !session.hermesRemoteSessionId) continue
        const key = `${session.hermesTargetId}:${session.hermesRemoteSessionId}`
        if (seen.has(key)) {
          toDelete.push(session.id)
        } else {
          seen.add(key)
        }
      }
      for (const id of toDelete) {
        try {
          deleteAgentSession(id)
        } catch (error) {
          console.error(`[Hermes] 清理重复会话失败: ${id}`, error)
        }
      }
      return toDelete.length
    },
  )
}
