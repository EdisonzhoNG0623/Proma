import type { RemoteHostTarget, RemoteHostHello } from '@proma/shared'
import { remoteHostCredentialStore, type RemoteHostCredentialSlot } from './remote-host-credential-store'
import {
  RemoteHostSshConnection,
  type RemoteHostSshAuth,
} from './remote-host-ssh-connection'

export interface RemoteHostSshConnectionLease {
  connection: RemoteHostSshConnection
  localPort: number
  release(): void
}

interface Entry {
  refs: number
  promise: Promise<RemoteHostSshConnection>
  idleTimer: ReturnType<typeof setTimeout> | null
  localPort: number
}

export class RemoteHostEndpointManager {
  private readonly entries = new Map<string, Entry>()
  private readonly idleTtlMs: number

  constructor(options: { idleTtlMs?: number } = {}) {
    this.idleTtlMs = options.idleTtlMs ?? 30_000
  }

  async acquire(target: RemoteHostTarget): Promise<RemoteHostSshConnectionLease> {
    let entry = this.entries.get(target.id)
    if (!entry) {
      const promise = this.connect(target)
      // Extract localPort once connected
      entry = {
        refs: 0,
        promise,
        idleTimer: null,
        localPort: 0,
      }
      this.entries.set(target.id, entry)
      void promise.then((conn) => {
        entry!.localPort = conn.localHostPort ?? 0
      }).catch(() => {
        if (this.entries.get(target.id) === entry) this.entries.delete(target.id)
      })
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    const connection = await entry.promise
    entry.refs += 1
    if (entry.localPort === 0) entry.localPort = connection.localHostPort ?? 0
    let released = false
    return {
      connection,
      localPort: entry.localPort,
      release: () => {
        if (released) return
        released = true
        entry!.refs = Math.max(0, entry!.refs - 1)
        if (entry!.refs !== 0 || this.entries.get(target.id) !== entry) return
        entry!.idleTimer = setTimeout(() => {
          if (entry!.refs !== 0 || this.entries.get(target.id) !== entry) return
          this.entries.delete(target.id)
          void entry!.promise.then((v) => v.close()).catch(() => undefined)
        }, this.idleTtlMs)
      },
    }
  }

  invalidate(targetId: string): void {
    const entry = this.entries.get(targetId)
    if (!entry) return
    this.entries.delete(targetId)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    void entry.promise.then((v) => v.close()).catch(() => undefined)
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer)
        try {
          await (await entry.promise).close()
        } catch {
          /* ignore */
        }
      }),
    )
  }

  private async connect(target: RemoteHostTarget): Promise<RemoteHostSshConnection> {
    const ssh = target.ssh
    const auth: RemoteHostSshAuth = {
      host: ssh.host,
      port: ssh.port,
      username: ssh.username,
    }

    // Try SSH key first, then password
    const sshKey = remoteHostCredentialStore.getOwnedCredential(target.id, 'ssh-private-key')
    if (sshKey) {
      auth.privateKey = sshKey
      auth.passphrase = remoteHostCredentialStore.getOwnedCredential(
        target.id,
        'ssh-private-key-passphrase',
      ) ?? undefined
    } else {
      auth.password = remoteHostCredentialStore.getOwnedCredential(target.id, 'ssh-password') ?? undefined
    }

    return RemoteHostSshConnection.connect(auth, {
      remoteHostPort: ssh.remoteHostPort,
    })
  }
}

export const remoteHostEndpointManager = new RemoteHostEndpointManager()
