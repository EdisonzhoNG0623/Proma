import type { HermesTarget } from '@proma/shared'
import { HermesCredentialBroker, hermesCredentialBroker } from './hermes-credential-broker'
import { HermesSshConnectionBroker, hermesSshConnectionBroker } from './hermes-ssh-connection-broker'
import { HermesCookieSessionManager, hermesCookieSessionManager } from './hermes-cookie-session'
import { HermesDirectTransport } from './transport/hermes-direct-transport'
import { HermesSshConnection } from './transport/hermes-ssh-connection'
import type { HermesTransport } from './transport/hermes-transport'

export interface HermesEndpointResource {
  dashboard?: HermesTransport
  apiServer?: HermesTransport
  ssh?: HermesSshConnection
  dispose(): Promise<void>
}

export interface HermesEndpointLease {
  targetId: string
  generation: number
  dashboard?: HermesTransport
  apiServer?: HermesTransport
  ssh?: HermesSshConnection
  release(): void
}

interface Entry {
  targetId: string
  generation: number
  refs: number
  promise: Promise<HermesEndpointResource>
  idleTimer: ReturnType<typeof setTimeout> | null
  disposing: boolean
}

type BuildFn = (target: HermesTarget, generation: number) => Promise<HermesEndpointResource>

export class HermesEndpointManager {
  private readonly entries = new Map<string, Entry>()
  private readonly generations = new Map<string, number>()
  private readonly idleTtlMs: number
  private readonly buildFn: BuildFn

  constructor(options: {
    idleTtlMs?: number
    build?: BuildFn
    credentialBroker?: HermesCredentialBroker
    cookieSessions?: HermesCookieSessionManager
    sshBroker?: HermesSshConnectionBroker
  } = {}) {
    this.idleTtlMs = options.idleTtlMs ?? 30_000
    const broker = options.credentialBroker ?? hermesCredentialBroker
    const cookies = options.cookieSessions ?? hermesCookieSessionManager
    const sshBroker = options.sshBroker
      ?? (options.credentialBroker ? new HermesSshConnectionBroker({ credentialBroker: broker }) : hermesSshConnectionBroker)
    this.buildFn = options.build ?? ((target) => this.buildDefault(target, cookies, sshBroker))
  }

  async acquire(target: HermesTarget): Promise<HermesEndpointLease> {
    let entry = this.entries.get(target.id)
    if (!entry) {
      const generation = this.generations.get(target.id) ?? 0
      entry = {
        targetId: target.id,
        generation,
        refs: 0,
        idleTimer: null,
        disposing: false,
        promise: Promise.resolve(null as never),
      }
      const currentEntry = entry
      entry.promise = this.buildFn(target, generation).then(async (resource) => {
        if (this.entries.get(target.id) !== currentEntry || this.currentGeneration(target.id) !== generation) {
          await resource.dispose()
          throw new Error('Hermes endpoint lease stale')
        }
        return resource
      })
      this.entries.set(target.id, entry)
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    const resource = await entry.promise
    if (this.entries.get(target.id) !== entry || this.currentGeneration(target.id) !== entry.generation) {
      throw new Error('Hermes endpoint lease stale')
    }
    entry.refs += 1
    let released = false
    return {
      targetId: target.id,
      generation: entry.generation,
      dashboard: resource.dashboard,
      apiServer: resource.apiServer,
      ssh: resource.ssh,
      release: () => {
        if (released) return
        released = true
        this.release(entry!)
      },
    }
  }

  invalidate(targetId: string): void {
    this.generations.set(targetId, this.currentGeneration(targetId) + 1)
    const entry = this.entries.get(targetId)
    if (!entry) return
    this.entries.delete(targetId)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    void this.disposeEntry(entry)
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) {
      this.generations.set(entry.targetId, this.currentGeneration(entry.targetId) + 1)
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
    }
    await Promise.all(entries.map((entry) => this.disposeEntry(entry)))
  }

  private currentGeneration(targetId: string): number {
    return this.generations.get(targetId) ?? 0
  }

  private release(entry: Entry): void {
    if (entry.refs > 0) entry.refs -= 1
    if (entry.refs !== 0 || this.entries.get(entry.targetId) !== entry) return
    entry.idleTimer = setTimeout(() => {
      if (entry.refs !== 0 || this.entries.get(entry.targetId) !== entry) return
      this.entries.delete(entry.targetId)
      void this.disposeEntry(entry)
    }, this.idleTtlMs)
  }

  private async disposeEntry(entry: Entry): Promise<void> {
    if (entry.disposing) return
    entry.disposing = true
    try {
      const resource = await entry.promise
      await resource.dispose()
    } catch {
      // Build failures and stale generation already own their cleanup path.
    }
  }

  private async buildDefault(
    target: HermesTarget,
    cookies: HermesCookieSessionManager,
    sshBroker: HermesSshConnectionBroker,
  ): Promise<HermesEndpointResource> {
    if (target.mode === 'direct') {
      const dashboardUrl = target.endpoints?.dashboard?.baseUrl
      const apiUrl = target.endpoints?.apiServer?.baseUrl
      const dashboard = dashboardUrl
        ? target.auth.dashboardMode === 'password-cookie'
          ? cookies.createDashboardTransport(target.id, dashboardUrl)
          : new HermesDirectTransport(dashboardUrl)
        : undefined
      const apiServer = apiUrl ? new HermesDirectTransport(apiUrl) : undefined
      if (!dashboard && !apiServer) throw new Error('Hermes target 未配置任何 endpoint')
      return {
        dashboard,
        apiServer,
        dispose: async () => {
          dashboard?.dispose()
          apiServer?.dispose()
        },
      }
    }

    if (!target.ssh) throw new Error('SSH Tunnel 模式缺少 SSH 配置')
    // SSH broker owns the single client and endpoint forwarders for this target.
    const sshLease = await sshBroker.acquire(target)
    const ssh = sshLease.connection
    const dashboard = ssh.localDashboardPort
      ? target.auth.dashboardMode === 'password-cookie'
        ? cookies.createDashboardTransport(target.id, `http://127.0.0.1:${ssh.localDashboardPort}/`)
        : new HermesDirectTransport(`http://127.0.0.1:${ssh.localDashboardPort}/`)
      : undefined
    const apiServer = ssh.localApiServerPort
      ? new HermesDirectTransport(`http://127.0.0.1:${ssh.localApiServerPort}/`)
      : undefined
    return {
      dashboard,
      apiServer,
      ssh,
      dispose: async () => {
        dashboard?.dispose()
        apiServer?.dispose()
        sshLease.release()
      },
    }
  }
}

export const hermesEndpointManager = new HermesEndpointManager()
