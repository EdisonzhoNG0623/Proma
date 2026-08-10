/**
 * Remote Host IPC 服务层
 *
 * 封装 Target Store / Credential Store / 能力探测 / 连接管理，
 * 供主进程 IPC handlers 调用。
 *
 * 安全约束：
 * - bearer token / SSH 凭据只进 CredentialStore（safeStorage），不进 Renderer；
 * - 删除 target 时同步清理关联凭据。
 */

import type {
  RemoteHostTarget,
  RemoteHostTargetCreateInput,
  RemoteHostTargetUpdateInput,
  RemoteHostHello,
  RemoteProjectListResponse,
  CreateRemoteProjectInput,
  CreateRemoteProjectResponse,
  RemoteProjectTreeResponse,
  RemoteTextFileResponse,
  SaveRemoteTextFileInput,
  SaveRemoteTextFileResponse,
  RemoteGitStatusResponse,
  RemoteGitDiffInput,
  RemoteGitDiffResponse,
  RemoteSessionListResponse,
  CreateRemoteSessionInput,
  CreateRemoteSessionResponse,
  RemoteSnapshotResponse,
  RemoteTurnRequest,
  RemoteTurnStatus,
  RemoteInteractionRequest,
  RespondToRemoteInteractionInput,
  RemoteInteractionResponse,
} from '@proma/shared'
import { remoteHostTargetStore } from './remote-host-target-store'
import { remoteHostCredentialStore } from './remote-host-credential-store'
import { remoteHostEndpointManager } from './remote-host-endpoint-manager'
import { RemoteHostClient, createRemoteHostClient, RemoteHostClientError } from './remote-host-client'
import { remoteHostKnownHostStore } from './remote-host-known-host-store'
import {
  RemoteHostSshHostKeyChallengeError,
  RemoteHostSshHostKeyChangedError,
} from './remote-host-ssh-connection'

export interface RemoteHostPublicTarget {
  id: string
  name: string
  ssh: { host: string; port: number; username: string; remoteHostPort: number }
  hasBearerCredential: boolean
  lastHello?: RemoteHostHello
  createdAt: number
  updatedAt: number
}

function toPublicTarget(target: RemoteHostTarget): RemoteHostPublicTarget {
  return {
    id: target.id,
    name: target.name,
    ssh: { ...target.ssh },
    hasBearerCredential: target.hasBearerCredential,
    lastHello: target.lastHello,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  }
}

export class RemoteHostIpcService {
  // ── Target CRUD ──

  listTargets(): RemoteHostPublicTarget[] {
    return remoteHostTargetStore.listTargets().map(toPublicTarget)
  }

  getTarget(id: string): RemoteHostPublicTarget | null {
    const target = remoteHostTargetStore.getTarget(id)
    return target ? toPublicTarget(target) : null
  }

  createTarget(input: RemoteHostTargetCreateInput): RemoteHostPublicTarget {
    return toPublicTarget(remoteHostTargetStore.createTarget(input))
  }

  updateTarget(id: string, input: RemoteHostTargetUpdateInput): RemoteHostPublicTarget {
    return toPublicTarget(remoteHostTargetStore.updateTarget(id, input))
  }

  deleteTarget(id: string): { removed: boolean; name?: string } {
    remoteHostCredentialStore.clearTargetCredentials(id)
    remoteHostEndpointManager.invalidate(id)
    const removed = remoteHostTargetStore.deleteTarget(id)
    return { removed: !!removed, name: removed?.name }
  }

  // ── Credentials ──

  setBearerToken(targetId: string, token: string): void {
    remoteHostCredentialStore.setOwnedCredential(targetId, 'bearer-token', token)
    remoteHostTargetStore.updateTarget(targetId, {})
  }

  hasBearerToken(targetId: string): boolean {
    return remoteHostCredentialStore.hasOwnedCredential(targetId, 'bearer-token')
  }

  clearBearerToken(targetId: string): boolean {
    return remoteHostCredentialStore.clearOwnedCredential(targetId, 'bearer-token')
  }

  setSshPassword(targetId: string, password: string): void {
    remoteHostCredentialStore.setOwnedCredential(targetId, 'ssh-password', password)
  }

  setSshPrivateKey(targetId: string, key: string, passphrase?: string): void {
    remoteHostCredentialStore.setOwnedCredential(targetId, 'ssh-private-key', key)
    if (passphrase) {
      remoteHostCredentialStore.setOwnedCredential(targetId, 'ssh-private-key-passphrase', passphrase)
    }
  }

  hasSshCredential(targetId: string): boolean {
    return (
      remoteHostCredentialStore.hasOwnedCredential(targetId, 'ssh-password') ||
      remoteHostCredentialStore.hasOwnedCredential(targetId, 'ssh-private-key')
    )
  }

  // ── Connection & Probe ──

  async probeTarget(targetId: string): Promise<{
    hello: RemoteHostHello
    target: RemoteHostPublicTarget
  }> {
    const target = remoteHostTargetStore.getTarget(targetId)
    if (!target) throw new Error('Target 不存在')
    const lease = await remoteHostEndpointManager.acquire(target)
    try {
      const client = createRemoteHostClient({
        targetId,
        localPort: lease.localPort,
      })
      client.loadCredential()
      const hello = await client.hello()
      const updated = remoteHostTargetStore.updateTarget(targetId, { lastHello: hello })
      return { hello, target: toPublicTarget(updated) }
    } catch (err) {
      if (err instanceof RemoteHostSshHostKeyChallengeError) {
        throw err
      }
      if (err instanceof RemoteHostSshHostKeyChangedError) {
        throw err
      }
      throw err
    } finally {
      lease.release()
    }
  }

  async confirmHostKey(token: string, host: string, port: number): Promise<void> {
    remoteHostKnownHostStore.confirm(token, { host, port })
  }

  async connectTarget(targetId: string): Promise<{ localPort: number }> {
    const target = remoteHostTargetStore.getTarget(targetId)
    if (!target) throw new Error('Target 不存在')
    const lease = await remoteHostEndpointManager.acquire(target)
    // Keep the lease active; caller should release via disconnect
    ;(lease as unknown as { _keepAlive: boolean })._keepAlive = true
    return { localPort: lease.localPort }
  }

  disconnectTarget(targetId: string): void {
    remoteHostEndpointManager.invalidate(targetId)
  }

  // ── Delegated API calls ──

  private async withClient<T>(
    targetId: string,
    fn: (client: RemoteHostClient) => Promise<T>,
  ): Promise<T> {
    const target = remoteHostTargetStore.getTarget(targetId)
    if (!target) throw new Error('Target 不存在')
    const lease = await remoteHostEndpointManager.acquire(target)
    try {
      const client = createRemoteHostClient({ targetId, localPort: lease.localPort })
      client.loadCredential()
      return await fn(client)
    } finally {
      lease.release()
    }
  }

  // ── Projects ──

  async listProjects(targetId: string): Promise<RemoteProjectListResponse> {
    return this.withClient(targetId, (c) => c.listProjects())
  }

  async createProject(targetId: string, input: CreateRemoteProjectInput): Promise<CreateRemoteProjectResponse> {
    return this.withClient(targetId, (c) => c.createProject(input))
  }

  async getProjectTree(targetId: string, projectId: string, path?: string): Promise<RemoteProjectTreeResponse> {
    return this.withClient(targetId, (c) => c.getProjectTree(projectId, path))
  }

  async readFile(targetId: string, projectId: string, path: string): Promise<RemoteTextFileResponse> {
    return this.withClient(targetId, (c) => c.readFile(projectId, path))
  }

  async saveFile(targetId: string, projectId: string, input: SaveRemoteTextFileInput): Promise<SaveRemoteTextFileResponse> {
    return this.withClient(targetId, (c) => c.saveFile(projectId, input))
  }

  async getGitStatus(targetId: string, projectId: string): Promise<RemoteGitStatusResponse> {
    return this.withClient(targetId, (c) => c.getGitStatus(projectId))
  }

  async getGitDiff(targetId: string, projectId: string, input?: RemoteGitDiffInput): Promise<RemoteGitDiffResponse> {
    return this.withClient(targetId, (c) => c.getGitDiff(projectId, input))
  }

  // ── Sessions ──

  async listSessions(
    targetId: string,
    params?: { projectId?: string; runtimeKind?: string },
  ): Promise<RemoteSessionListResponse> {
    return this.withClient(targetId, (c) => c.listSessions(params))
  }

  async createSession(
    targetId: string,
    input: CreateRemoteSessionInput,
  ): Promise<CreateRemoteSessionResponse> {
    return this.withClient(targetId, (c) => c.createSession(input))
  }

  async getSnapshot(targetId: string, sessionId: string): Promise<RemoteSnapshotResponse> {
    return this.withClient(targetId, (c) => c.getSnapshot(sessionId))
  }

  async submitTurn(
    targetId: string,
    sessionId: string,
    input: RemoteTurnRequest,
  ): Promise<RemoteTurnStatus> {
    return this.withClient(targetId, (c) => c.submitTurn(sessionId, input))
  }

  async interruptSession(targetId: string, sessionId: string): Promise<void> {
    return this.withClient(targetId, (c) => c.interruptSession(sessionId))
  }

  async respondToInteraction(
    targetId: string,
    interactionId: string,
    input: RespondToRemoteInteractionInput,
  ): Promise<RemoteInteractionResponse> {
    return this.withClient(targetId, (c) => c.respondToInteraction(interactionId, input))
  }
}

export const remoteHostIpcService = new RemoteHostIpcService()
