/**
 * Hermes IPC handlers
 *
 * 独立注册 Hermes Remote 相关 IPC 处理器（主进程侧），
 * 由 main/ipc.ts 的 registerIpcHandlers 统一调用。
 *
 * 安全约束：密码 / API key 仅经 IPC 传入主进程 CredentialStore，
 * 永不通过 IPC 返回明文（返回值只有 ref）。
 */

import { ipcMain, shell } from 'electron'
import { HERMES_IPC_CHANNELS } from '@proma/shared'
import type {
  HermesCapabilities,
  HermesPublicTarget,
  HermesTargetCreateInput,
  HermesTargetUpdateInput,
  HermesSetDashboardPasswordInput,
} from '@proma/shared'
import { hermesIpcService } from './hermes-ipc-service'
import { respondHermesInteraction, fetchHermesAttachment, fetchHermesMedia } from '../agent-service'
import {
  createAgentSession,
  updateAgentSessionMeta,
  listAgentSessions,
  deleteAgentSession,
} from '../agent-session-manager'

/** 校验字符串参数 */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必填`)
  if (value.length > 4096 || value.includes('\0')) throw new Error(`${name} 超过长度限制或包含 NUL`)
  return value
}

/**
 * 注册 Hermes IPC 处理器。
 */
export function registerHermesIpcHandlers(): void {
  // ---- Target CRUD ----
  ipcMain.handle(HERMES_IPC_CHANNELS.LIST_TARGETS, (): HermesPublicTarget[] => {
    return hermesIpcService.listTargets()
  })

  ipcMain.handle(HERMES_IPC_CHANNELS.GET_TARGET, (_, id: string): HermesPublicTarget | null => {
    return hermesIpcService.getTarget(requireString(id, 'id'))
  })

  ipcMain.handle(
    HERMES_IPC_CHANNELS.CREATE_TARGET,
    (_, input: HermesTargetCreateInput): HermesPublicTarget => {
      if (!input || typeof input !== 'object') throw new Error('input 必填')
      return hermesIpcService.createTarget(input)
    },
  )

  ipcMain.handle(
    HERMES_IPC_CHANNELS.UPDATE_TARGET,
    async (_, id: string, input: HermesTargetUpdateInput): Promise<HermesPublicTarget> => {
      if (!input || typeof input !== 'object') throw new Error('input 必填')
      return await hermesIpcService.updateTarget(requireString(id, 'id'), input)
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

  ipcMain.handle(HERMES_IPC_CHANNELS.SET_API_SERVER_KEY, (_, input: { targetId: string; secret: string }) => {
    if (!input || typeof input !== 'object') throw new Error('input 必填')
    return hermesIpcService.setApiServerKey({
      targetId: requireString(input.targetId, 'targetId'),
      secret: requireString(input.secret, 'secret'),
    })
  })

  ipcMain.handle(HERMES_IPC_CHANNELS.CONFIRM_SSH_HOST_KEY, (_, targetId: unknown, challenge: unknown): boolean => {
    return hermesIpcService.confirmSshHostKey(
      requireString(targetId, 'targetId'),
      requireString(challenge, 'challenge'),
    )
  })

  ipcMain.handle(HERMES_IPC_CHANNELS.SET_SSH_PASSWORD, (_, input: { targetId: string; secret: string }) => {
    if (!input || typeof input !== 'object') throw new Error('input 必填')
    return hermesIpcService.setSshPassword({
      targetId: requireString(input.targetId, 'targetId'),
      secret: requireString(input.secret, 'secret'),
    })
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

  // 创建远端项目（SFTP mkdir /opt/ai/projects/<name>）
  ipcMain.handle(HERMES_IPC_CHANNELS.CREATE_REMOTE_PROJECT, async (_, targetId: string, name: string) => {
    return await hermesIpcService.createRemoteProject(requireString(targetId, 'targetId'), requireString(name, 'name'))
  })

  // 列出远端项目文件
  ipcMain.handle(HERMES_IPC_CHANNELS.LIST_REMOTE_FILES, async (_, targetId: string, rootPath: string, remotePath: string) => {
    return await hermesIpcService.listRemoteProjectFiles(
      requireString(targetId, 'targetId'),
      requireString(rootPath, 'rootPath'),
      requireString(remotePath, 'remotePath'),
    )
  })

  // 读取远端 UTF-8 文本；main 端强制 5 MiB cap。
  ipcMain.handle(HERMES_IPC_CHANNELS.READ_REMOTE_FILE, async (_, targetId: string, rootPath: string, remotePath: string) => {
    return await hermesIpcService.readRemoteFile(
      requireString(targetId, 'targetId'),
      requireString(rootPath, 'rootPath'),
      requireString(remotePath, 'remotePath'),
      5 * 1024 * 1024,
    )
  })

  // 拉取 Hermes 网关媒体文件（Hermes → Proma 收图）
  ipcMain.handle(
    HERMES_IPC_CHANNELS.FETCH_MEDIA,
    async (_, targetId: unknown, mediaPath: unknown): Promise<{ dataUrl?: string } | null> => {
      if (typeof targetId !== 'string' || typeof mediaPath !== 'string' || !mediaPath.trim()) {
        return null
      }
      return fetchHermesMedia(targetId, mediaPath)
    },
  )

  ipcMain.handle(
    HERMES_IPC_CHANNELS.FETCH_ATTACHMENT,
    async (_, sessionId: unknown, fileRef: unknown): Promise<{ localPath: string; name: string; mimeType: string; size: number } | null> => {
      if (typeof sessionId !== 'string' || !sessionId.trim() || typeof fileRef !== 'string' || !fileRef.trim()) {
        return null
      }
      return fetchHermesAttachment(sessionId, fileRef)
    },
  )

  ipcMain.handle(
    HERMES_IPC_CHANNELS.OPEN_ATTACHMENT,
    async (_, sessionId: unknown, fileRef: unknown): Promise<boolean> => {
      if (typeof sessionId !== 'string' || !sessionId.trim() || typeof fileRef !== 'string' || !fileRef.trim()) {
        return false
      }
      // 路径不接受 Renderer 直传：必须由绑定 session + @file 经安全物化生成。
      const attachment = await fetchHermesAttachment(sessionId, fileRef)
      if (!attachment) return false
      const errorMessage = await shell.openPath(attachment.localPath)
      if (errorMessage) throw new Error(`本地程序打开附件失败: ${errorMessage}`)
      return true
    },
  )

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
    async (_, input: { targetId: string; protocol?: 'dashboard' | 'api-server'; profile?: string; remoteSessionId?: string; remoteCwd?: string; title?: string; workspaceId?: string }) => {
      if (!input || typeof input !== 'object') throw new Error('input 必填')
      requireString(input.targetId, 'targetId')
      const protocol = input.protocol ?? 'dashboard'
      if (protocol !== 'dashboard' && protocol !== 'api-server') throw new Error('protocol 无效')

      // 去重：完整远端身份 target + protocol + profile + stored session。
      const existing = input.remoteSessionId
        ? listAgentSessions().find(
            (session) =>
              session.agentRuntime === 'hermes-remote' &&
              session.hermesTargetId === input.targetId &&
              (session.hermesProtocol ?? 'dashboard') === protocol &&
              (session.hermesProfile ?? '') === (input.profile ?? '') &&
              session.hermesRemoteSessionId === input.remoteSessionId,
          )
        : undefined
      if (existing) {
        // Renderer 通过 GET_SDK_MESSAGES 读取 canonical remote snapshot；本地 JSONL/live
        // timeline 不缓存远端历史，因此这里无需注入或去重消息。
        return existing
      }

      // 创建 Hermes Remote 会话（channelId 用占位 'hermes-remote'，runtime 为 hermes-remote）
      const session = createAgentSession(
        input.title || 'Hermes 远端会话',
        'hermes-remote',
        input.workspaceId,
        undefined,
        input.workspaceId ? 'project' : undefined,
      )
      updateAgentSessionMeta(session.id, {
        agentRuntime: 'hermes-remote',
        hermesTargetId: input.targetId,
        hermesProtocol: protocol,
        ...(input.profile ? { hermesProfile: input.profile } : {}),
        ...(input.remoteSessionId ? { hermesRemoteSessionId: input.remoteSessionId } : {}),
        ...(input.remoteCwd ? { hermesRemoteCwd: input.remoteCwd } : {}),
      })
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
        const key = `${session.hermesTargetId}:${session.hermesProtocol ?? 'dashboard'}:${session.hermesProfile ?? ''}:${session.hermesRemoteSessionId}`
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
