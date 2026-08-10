/**
 * Remote Host Runtime Facade
 *
 * Proma Desktop ← Remote Host 的适配层。
 * 将 Remote Host 的 snapshot/turn/event 投影为 SDKMessage 流，
 * 与 Hermes Runtime Facade 并行存在，共享 EventBus/IPC 投影层。
 */

import type { SDKMessage } from '@proma/shared'
import type {
  RemoteSnapshotResponse,
  RemoteTurnRequest,
  RemoteTurnStatus,
  RemoteInteractionRequest,
  RemoteInteractionResponse,
  RemoteSnapshotItem,
} from '@proma/shared'
import { remoteHostEndpointManager } from './remote-host-endpoint-manager'
import { RemoteHostClient, createRemoteHostClient } from './remote-host-client'
import { remoteHostTargetStore } from './remote-host-target-store'
import { EventEmitter } from 'node:events'

export interface RemoteHostQueryInput {
  sessionId: string
  prompt: string
  targetId: string
  hostSessionId: string
  clientTurnId: string
  attachments?: Array<{ blobId: string; kind: 'image' | 'file'; name: string; mimeType: string; size: number; sha256: string }>
}

function snapshotItemToSDKMessage(item: RemoteSnapshotItem, sessionId: string): SDKMessage | null {
  switch (item.kind) {
    case 'user':
      return {
        type: 'user',
        message: { role: 'user', content: item.text },
        session_id: sessionId,
      } as unknown as SDKMessage
    case 'assistant':
      return {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: item.text }] },
        session_id: sessionId,
      } as unknown as SDKMessage
    default:
      return null
  }
}

export class RemoteHostRuntimeFacade extends EventEmitter {
  private activeSessions = new Set<string>()

  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  async *query(input: RemoteHostQueryInput): AsyncIterable<SDKMessage> {
    const { sessionId, prompt, targetId, hostSessionId, clientTurnId, attachments } = input
    this.activeSessions.add(sessionId)

    try {
      const target = remoteHostTargetStore.getTarget(targetId)
      if (!target) throw new Error('Remote Host Target 不存在')

      const lease = await remoteHostEndpointManager.acquire(target)
      try {
        const client = createRemoteHostClient({ targetId, localPort: lease.localPort })
        client.loadCredential()

        // 1. Get current snapshot to yield history
        const snapshot = await client.getSnapshot(hostSessionId)
        for (const item of snapshot.snapshot.items) {
          const msg = snapshotItemToSDKMessage(item, sessionId)
          if (msg) yield msg
        }

        // 2. Submit the turn
        const text = prompt
        const requestDigest = await this.computeDigest(text + clientTurnId)
        const turnRequest: RemoteTurnRequest = {
          clientTurnId,
          requestDigest,
          text,
          attachments: attachments ?? [],
        }

        const turnStatus = await client.submitTurn(hostSessionId, turnRequest)

        // 3. Poll for completion (simplified V1 - real streaming uses WebSocket)
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `[Remote Host turn ${turnStatus.state}]` }],
          },
          session_id: sessionId,
        } as unknown as SDKMessage
      } finally {
        lease.release()
      }
    } finally {
      this.activeSessions.delete(sessionId)
    }
  }

  private async computeDigest(input: string): Promise<string> {
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(input).digest('hex')
  }
}

export const remoteHostFacade = new RemoteHostRuntimeFacade()
