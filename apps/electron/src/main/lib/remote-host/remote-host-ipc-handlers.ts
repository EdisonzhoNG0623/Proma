/**
 * Remote Host IPC Handlers
 *
 * 在主进程 ipc.ts 中注册这些 handler，处理 Renderer 发起的 Remote Host 操作。
 * 遵循薄 handler 模式：校验参数 → 调用 IPC Service → 返回结果。
 */

import { ipcMain } from 'electron'
import { REMOTE_HOST_IPC_CHANNELS } from '@proma/shared'
import { remoteHostIpcService } from './remote-host-ipc-service'
import { RemoteHostSshHostKeyChallengeError, RemoteHostSshHostKeyChangedError } from './remote-host-ssh-connection'
import { RemoteHostClientError } from './remote-host-client'

export { REMOTE_HOST_IPC_CHANNELS }

function formatError(err: unknown): { code: string; message: string; details?: unknown } {
  if (err instanceof RemoteHostSshHostKeyChallengeError) {
    return {
      code: 'host_key_challenge',
      message: err.message,
      details: { challenge: err.challenge, fingerprint: err.fingerprint },
    }
  }
  if (err instanceof RemoteHostSshHostKeyChangedError) {
    return {
      code: 'host_key_changed',
      message: err.message,
      details: { fingerprint: err.fingerprint },
    }
  }
  if (err instanceof RemoteHostClientError) {
    return {
      code: err.code,
      message: err.message,
      details: err.details,
    }
  }
  if (err instanceof Error) {
    return { code: 'internal', message: err.message }
  }
  return { code: 'internal', message: String(err) }
}

export function registerRemoteHostIpcHandlers(): void {
  // Target CRUD
  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.LIST_TARGETS, async () => {
    return remoteHostIpcService.listTargets()
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.GET_TARGET, async (_event, id: string) => {
    return remoteHostIpcService.getTarget(id)
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.CREATE_TARGET, async (_event, input: unknown) => {
    return remoteHostIpcService.createTarget(input as Parameters<typeof remoteHostIpcService.createTarget>[0])
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.UPDATE_TARGET, async (_event, id: string, input: unknown) => {
    return remoteHostIpcService.updateTarget(id, input as Parameters<typeof remoteHostIpcService.updateTarget>[1])
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.DELETE_TARGET, async (_event, id: string) => {
    return remoteHostIpcService.deleteTarget(id)
  })

  // Credentials
  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.SET_BEARER_TOKEN, async (_event, targetId: string, token: string) => {
    remoteHostIpcService.setBearerToken(targetId, token)
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.HAS_BEARER_TOKEN, async (_event, targetId: string) => {
    return remoteHostIpcService.hasBearerToken(targetId)
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.CLEAR_BEARER_TOKEN, async (_event, targetId: string) => {
    return remoteHostIpcService.clearBearerToken(targetId)
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.SET_SSH_PASSWORD, async (_event, targetId: string, password: string) => {
    remoteHostIpcService.setSshPassword(targetId, password)
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.SET_SSH_PRIVATE_KEY, async (_event, targetId: string, key: string, passphrase?: string) => {
    remoteHostIpcService.setSshPrivateKey(targetId, key, passphrase)
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.HAS_SSH_CREDENTIAL, async (_event, targetId: string) => {
    return remoteHostIpcService.hasSshCredential(targetId)
  })

  // Connection
  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.PROBE_TARGET, async (_event, targetId: string) => {
    try {
      return await remoteHostIpcService.probeTarget(targetId)
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.CONFIRM_HOST_KEY, async (_event, token: string, host: string, port: number) => {
    remoteHostIpcService.confirmHostKey(token, host, port)
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.CONNECT_TARGET, async (_event, targetId: string) => {
    try {
      return await remoteHostIpcService.connectTarget(targetId)
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.DISCONNECT_TARGET, async (_event, targetId: string) => {
    remoteHostIpcService.disconnectTarget(targetId)
  })

  // Projects
  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.LIST_PROJECTS, async (_event, targetId: string) => {
    try {
      return await remoteHostIpcService.listProjects(targetId)
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.CREATE_PROJECT, async (_event, targetId: string, input: unknown) => {
    try {
      return await remoteHostIpcService.createProject(targetId, input as Parameters<typeof remoteHostIpcService.createProject>[1])
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.GET_PROJECT_TREE, async (_event, targetId: string, projectId: string, path?: string) => {
    try {
      return await remoteHostIpcService.getProjectTree(targetId, projectId, path)
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.READ_FILE, async (_event, targetId: string, projectId: string, path: string) => {
    try {
      return await remoteHostIpcService.readFile(targetId, projectId, path)
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.SAVE_FILE, async (_event, targetId: string, projectId: string, input: unknown) => {
    try {
      return await remoteHostIpcService.saveFile(targetId, projectId, input as Parameters<typeof remoteHostIpcService.saveFile>[2])
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.GET_GIT_STATUS, async (_event, targetId: string, projectId: string) => {
    try {
      return await remoteHostIpcService.getGitStatus(targetId, projectId)
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.GET_GIT_DIFF, async (_event, targetId: string, projectId: string, input?: unknown) => {
    try {
      return await remoteHostIpcService.getGitDiff(targetId, projectId, input as Parameters<typeof remoteHostIpcService.getGitDiff>[2])
    } catch (err) {
      throw formatError(err)
    }
  })

  // Sessions
  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.LIST_SESSIONS, async (_event, targetId: string, params?: unknown) => {
    try {
      return await remoteHostIpcService.listSessions(targetId, params as Parameters<typeof remoteHostIpcService.listSessions>[1])
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.CREATE_SESSION, async (_event, targetId: string, input: unknown) => {
    try {
      return await remoteHostIpcService.createSession(targetId, input as Parameters<typeof remoteHostIpcService.createSession>[1])
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.GET_SESSION_SNAPSHOT, async (_event, targetId: string, sessionId: string) => {
    try {
      return await remoteHostIpcService.getSnapshot(targetId, sessionId)
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.SUBMIT_TURN, async (_event, targetId: string, sessionId: string, input: unknown) => {
    try {
      return await remoteHostIpcService.submitTurn(targetId, sessionId, input as Parameters<typeof remoteHostIpcService.submitTurn>[2])
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.INTERRUPT_SESSION, async (_event, targetId: string, sessionId: string) => {
    try {
      await remoteHostIpcService.interruptSession(targetId, sessionId)
    } catch (err) {
      throw formatError(err)
    }
  })

  ipcMain.handle(REMOTE_HOST_IPC_CHANNELS.RESPOND_TO_INTERACTION, async (_event, targetId: string, interactionId: string, input: unknown) => {
    try {
      return await remoteHostIpcService.respondToInteraction(targetId, interactionId, input as Parameters<typeof remoteHostIpcService.respondToInteraction>[2])
    } catch (err) {
      throw formatError(err)
    }
  })
}
