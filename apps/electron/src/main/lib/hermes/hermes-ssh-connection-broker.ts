import type { HermesTarget } from '@proma/shared'
import { HermesCredentialBroker, hermesCredentialBroker } from './hermes-credential-broker'
import { HermesSshConnection } from './transport/hermes-ssh-connection'

export interface HermesSshConnectionLease {
  connection: HermesSshConnection
  release(): void
}

interface Entry {
  refs: number
  promise: Promise<HermesSshConnection>
  idleTimer: ReturnType<typeof setTimeout> | null
}

export class HermesSshConnectionBroker {
  private readonly entries = new Map<string, Entry>()
  private readonly credentials: HermesCredentialBroker
  private readonly idleTtlMs: number
  private readonly connectFn: (target: HermesTarget) => Promise<HermesSshConnection>

  constructor(options: {
    credentialBroker?: HermesCredentialBroker
    idleTtlMs?: number
    connect?: (target: HermesTarget) => Promise<HermesSshConnection>
  } = {}) {
    this.credentials = options.credentialBroker ?? hermesCredentialBroker
    this.idleTtlMs = options.idleTtlMs ?? 30_000
    this.connectFn = options.connect ?? ((target) => this.connectDefault(target))
  }

  async acquire(target: HermesTarget): Promise<HermesSshConnectionLease> {
    if (!target.ssh) throw new Error('Hermes target 未配置 SSH')
    let entry = this.entries.get(target.id)
    if (!entry) {
      entry = { refs: 0, promise: this.connectFn(target), idleTimer: null }
      this.entries.set(target.id, entry)
      void entry.promise.catch(() => { if (this.entries.get(target.id) === entry) this.entries.delete(target.id) })
    }
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null }
    const connection = await entry.promise
    entry.refs += 1
    let released = false
    return {
      connection,
      release: () => {
        if (released) return
        released = true
        entry!.refs = Math.max(0, entry!.refs - 1)
        if (entry!.refs !== 0 || this.entries.get(target.id) !== entry) return
        entry!.idleTimer = setTimeout(() => {
          if (entry!.refs !== 0 || this.entries.get(target.id) !== entry) return
          this.entries.delete(target.id)
          void entry!.promise.then((value) => value.close()).catch(() => undefined)
        }, this.idleTtlMs)
      },
    }
  }

  invalidate(targetId: string): void {
    const entry = this.entries.get(targetId)
    if (!entry) return
    this.entries.delete(targetId)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    void entry.promise.then((value) => value.close()).catch(() => undefined)
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map(async (entry) => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
      try { await (await entry.promise).close() } catch { /* failed connection */ }
    }))
  }

  private connectDefault(target: HermesTarget): Promise<HermesSshConnection> {
    const ssh = target.ssh!
    return HermesSshConnection.connect({
      host: ssh.host,
      port: ssh.port,
      username: ssh.username,
      password: this.credentials.getSecret(target.id, 'ssh-password') ?? undefined,
      privateKey: this.credentials.getSecret(target.id, 'ssh-private-key') ?? undefined,
      passphrase: this.credentials.getSecret(target.id, 'ssh-private-key-passphrase') ?? undefined,
    }, {
      endpoints: target.mode === 'ssh-tunnel'
        ? {
            dashboard: target.endpoints?.dashboard?.remotePort,
            apiServer: target.endpoints?.apiServer?.remotePort,
          }
        : {},
    })
  }
}

export const hermesSshConnectionBroker = new HermesSshConnectionBroker()
