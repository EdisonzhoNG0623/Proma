import type { HermesTarget } from '@proma/shared'
import {
  buildTicketWsUrl,
  buildTokenWsUrl,
  buildUnauthenticatedWsUrl,
  canSubmitPasswordTo,
  HermesAuthService,
} from './hermes-auth'
import { HermesCredentialBroker, hermesCredentialBroker } from './hermes-credential-broker'
import { HermesDashboardAdapter, type HermesSessionCreateInput, type HermesSessionResult } from './hermes-dashboard-adapter'
import { isGatewayReadyEvent, type HermesDashboardEvent } from './hermes-dashboard-contract'
import { HermesDashboardWsClient } from './hermes-dashboard-ws-client'
import { HermesEndpointManager, hermesEndpointManager, type HermesEndpointLease } from './hermes-endpoint-manager'
import { HermesError } from './hermes-errors'
import type { HermesTransport } from './transport/hermes-transport'

export interface HermesDashboardBrokerLease {
  readonly targetId: string
  readonly generation: number
  withAdapter<T>(operation: (adapter: HermesDashboardAdapter) => Promise<T>): Promise<T>
  subscribeGlobal(handler: (event: HermesDashboardEvent) => void): () => void
  subscribeSession(bindingKey: string, handler: (event: HermesDashboardEvent) => void): () => void
  trackSession(
    bindingKey: string,
    storedSessionId: string,
    resumeInput?: HermesSessionCreateInput,
    onResumed?: (result: HermesSessionResult) => void,
    runtimeSessionId?: string,
  ): void
  untrackSession(bindingKey: string): void
  release(): void
}

interface TrackedSession {
  storedSessionId: string
  resumeInput: HermesSessionCreateInput
  runtimeSessionId?: string
  onResumed?: (result: HermesSessionResult) => void
}

interface BrokerEntry {
  target: HermesTarget
  refs: number
  generation: number
  client: HermesDashboardWsClient | null
  adapter: HermesDashboardAdapter | null
  endpointLease: HermesEndpointLease | null
  connectPromise: Promise<void> | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  closing: boolean
  connecting: boolean
  globalSubscribers: Set<(event: HermesDashboardEvent) => void>
  sessionSubscribers: Map<string, Set<(event: HermesDashboardEvent) => void>>
  trackedSessions: Map<string, TrackedSession>
}

export type HermesDashboardPrepareConnection = (
  target: HermesTarget,
  transport: HermesTransport,
  onClose: (reason: string) => void,
) => Promise<{ client: HermesDashboardWsClient; url: string }>

export class HermesDashboardConnectionBroker {
  private readonly entries = new Map<string, BrokerEntry>()
  private readonly endpointManager: HermesEndpointManager
  private readonly readyTimeoutMs: number
  private readonly reconnectDelayMs: number
  private readonly idleTtlMs: number
  private readonly prepareConnection: HermesDashboardPrepareConnection

  constructor(options: {
    endpointManager?: HermesEndpointManager
    credentialBroker?: HermesCredentialBroker
    readyTimeoutMs?: number
    reconnectDelayMs?: number
    idleTtlMs?: number
    prepareConnection?: HermesDashboardPrepareConnection
  } = {}) {
    this.endpointManager = options.endpointManager ?? hermesEndpointManager
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000
    this.reconnectDelayMs = options.reconnectDelayMs ?? 500
    this.idleTtlMs = options.idleTtlMs ?? 30_000
    const credentials = options.credentialBroker ?? hermesCredentialBroker
    this.prepareConnection = options.prepareConnection ?? ((target, transport, onClose) =>
      this.prepareDefaultConnection(target, transport, credentials, onClose))
  }

  async acquire(target: HermesTarget): Promise<HermesDashboardBrokerLease> {
    let entry = this.entries.get(target.id)
    if (!entry) {
      entry = this.createEntry(target)
      this.entries.set(target.id, entry)
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    entry.refs += 1
    try {
      await this.ensureConnected(entry)
    } catch (error) {
      entry.refs = Math.max(0, entry.refs - 1)
      if (entry.refs === 0) {
        // A failed initial connection closes this entry. Remove it from the
        // registry first so the next user action can build a fresh broker
        // instead of reusing a permanently `closing` entry.
        if (this.entries.get(target.id) === entry) this.entries.delete(target.id)
        await this.closeEntry(entry)
      }
      throw error
    }
    const broker = this
    let released = false
    return {
      targetId: target.id,
      get generation() { return entry!.generation },
      withAdapter: async <T>(operation: (adapter: HermesDashboardAdapter) => Promise<T>): Promise<T> => {
        await broker.ensureConnected(entry!)
        if (!entry!.adapter) throw new HermesError('Hermes Dashboard 未就绪', 'network')
        return await operation(entry!.adapter)
      },
      subscribeGlobal: (handler) => {
        entry!.globalSubscribers.add(handler)
        return () => entry!.globalSubscribers.delete(handler)
      },
      subscribeSession: (bindingKey, handler) => {
        let handlers = entry!.sessionSubscribers.get(bindingKey)
        if (!handlers) {
          handlers = new Set()
          entry!.sessionSubscribers.set(bindingKey, handlers)
        }
        handlers.add(handler)
        return () => {
          handlers!.delete(handler)
          if (handlers!.size === 0) entry!.sessionSubscribers.delete(bindingKey)
        }
      },
      trackSession: (bindingKey, storedSessionId, resumeInput = {}, onResumed, runtimeSessionId) => {
        entry!.trackedSessions.set(bindingKey, { storedSessionId, resumeInput, onResumed, runtimeSessionId })
      },
      untrackSession: (bindingKey) => {
        entry!.trackedSessions.delete(bindingKey)
        entry!.sessionSubscribers.delete(bindingKey)
      },
      release: () => {
        if (released) return
        released = true
        broker.releaseEntry(entry!)
      },
    }
  }

  invalidate(targetId: string): void {
    const entry = this.entries.get(targetId)
    if (!entry) return
    this.entries.delete(targetId)
    void this.closeEntry(entry)
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map((entry) => this.closeEntry(entry)))
  }

  private createEntry(target: HermesTarget): BrokerEntry {
    return {
      target,
      refs: 0,
      generation: 0,
      client: null,
      adapter: null,
      endpointLease: null,
      connectPromise: null,
      reconnectTimer: null,
      idleTimer: null,
      closing: false,
      connecting: false,
      globalSubscribers: new Set(),
      sessionSubscribers: new Map(),
      trackedSessions: new Map(),
    }
  }

  private async ensureConnected(entry: BrokerEntry): Promise<void> {
    if (entry.adapter && entry.client?.isConnected) return
    if (entry.closing) throw new HermesError('Hermes Dashboard broker 已关闭', 'network')
    if (!entry.connectPromise) {
      entry.connectPromise = this.connectEntry(entry).finally(() => {
        entry.connectPromise = null
      })
    }
    return await entry.connectPromise
  }

  private async connectEntry(entry: BrokerEntry): Promise<void> {
    entry.connecting = true
    if (!entry.endpointLease) entry.endpointLease = await this.endpointManager.acquire(entry.target)
    const transport = entry.endpointLease.dashboard
    if (!transport) throw new HermesError('Hermes target 未配置 Dashboard endpoint', 'protocol-incompatible')

    let client: HermesDashboardWsClient | null = null
    try {
      const prepared = await this.prepareConnection(entry.target, transport, (reason) => {
        if (client) this.handleClose(entry, client, reason)
      })
      client = prepared.client
      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      // A socket connect failure can happen before we start awaiting `ready`. Mark the
      // promise handled immediately so a concurrent timeout cannot surface as an
      // unhandled rejection while connect() is still pending.
      void ready.catch(() => undefined)
      const timer = setTimeout(() => rejectReady(new HermesError('等待 Hermes gateway.ready 超时', 'timeout')), this.readyTimeoutMs)
      const earlyEvents: HermesDashboardEvent[] = []
      const off = client.onEvent((event) => {
        if (isGatewayReadyEvent(event)) resolveReady()
        if (entry.client === client) this.dispatchEvent(entry, event)
        else if (entry.connecting) earlyEvents.push(event)
      })
      try {
        await client.connect(prepared.url)
        await ready
      } finally {
        clearTimeout(timer)
      }
      if (entry.closing) throw new HermesError('Hermes Dashboard broker 已关闭', 'network')
      entry.client = client
      entry.adapter = new HermesDashboardAdapter(client)
      entry.generation += 1
      entry.connecting = false
      for (const event of earlyEvents) this.dispatchEvent(entry, event)
      await this.resumeTrackedSessions(entry)
      // Keep event subscription for this socket until it closes.
      void off
    } catch (error) {
      entry.connecting = false
      client?.close()
      throw error
    }
  }

  private dispatchEvent(entry: BrokerEntry, event: HermesDashboardEvent): void {
    if (!event.sessionId) {
      for (const handler of entry.globalSubscribers) handler(event)
      return
    }
    for (const [bindingKey, tracked] of entry.trackedSessions) {
      if (tracked.runtimeSessionId !== event.sessionId) continue
      for (const handler of entry.sessionSubscribers.get(bindingKey) ?? []) handler(event)
    }
  }

  private async resumeTrackedSessions(entry: BrokerEntry): Promise<void> {
    const adapter = entry.adapter
    if (!adapter || entry.generation <= 1) return
    for (const tracked of entry.trackedSessions.values()) {
      const result = await adapter.resumeSession(tracked.storedSessionId, tracked.resumeInput)
      tracked.runtimeSessionId = result.sessionId
      tracked.onResumed?.(result)
    }
  }

  private handleClose(entry: BrokerEntry, client: HermesDashboardWsClient, _reason: string): void {
    if (entry.client !== client && !entry.connecting) return
    if (entry.client === client) {
      entry.client = null
      entry.adapter = null
    }
    if (entry.closing || entry.connecting || entry.refs === 0) return
    this.scheduleReconnect(entry)
  }

  private scheduleReconnect(entry: BrokerEntry): void {
    if (entry.closing || entry.refs === 0 || entry.reconnectTimer) return
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null
      void this.ensureConnected(entry).catch(() => this.scheduleReconnect(entry))
    }, this.reconnectDelayMs)
  }

  private releaseEntry(entry: BrokerEntry): void {
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs !== 0 || entry.closing) return
    entry.idleTimer = setTimeout(() => {
      if (entry.refs !== 0) return
      this.entries.delete(entry.target.id)
      void this.closeEntry(entry)
    }, this.idleTtlMs)
  }

  private async closeEntry(entry: BrokerEntry): Promise<void> {
    if (entry.closing) return
    entry.closing = true
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.client?.close()
    entry.client = null
    entry.adapter = null
    entry.endpointLease?.release()
    entry.endpointLease = null
    entry.globalSubscribers.clear()
    entry.sessionSubscribers.clear()
    entry.trackedSessions.clear()
  }

  private async prepareDefaultConnection(
    target: HermesTarget,
    transport: HermesTransport,
    credentials: HermesCredentialBroker,
    onClose: (reason: string) => void,
  ): Promise<{ client: HermesDashboardWsClient; url: string }> {
    const mode = target.auth.dashboardMode
    let url: string
    if (!mode) {
      url = buildUnauthenticatedWsUrl(transport.baseUrl)
    } else if (mode === 'token') {
      const token = credentials.getSecret(target.id, 'dashboard-token')
      if (!token) throw new HermesError('Hermes Dashboard token 缺失', 'unauthorized')
      url = buildTokenWsUrl(transport.baseUrl, token)
    } else if (mode === 'password-cookie') {
      if (!canSubmitPasswordTo(transport.baseUrl)) throw new HermesError('拒绝通过不安全连接提交 Hermes 密码', 'tls')
      const raw = credentials.getSecret(target.id, 'dashboard-password')
      if (!raw) throw new HermesError('Hermes Dashboard 密码缺失', 'unauthorized')
      let username = ''
      let password = raw
      try {
        const parsed = JSON.parse(raw) as { username?: unknown; password?: unknown }
        if (typeof parsed.username === 'string') username = parsed.username
        if (typeof parsed.password === 'string') password = parsed.password
      } catch {
        // Legacy pure-password credential.
      }
      const auth = new HermesAuthService(transport, { browserCookies: true })
      await auth.passwordLogin(target.id, {
        provider: target.auth.dashboardProvider ?? 'basic',
        username,
        password,
      })
      url = buildTicketWsUrl(transport.baseUrl, await auth.mintWsTicket(target.id))
    } else {
      throw new HermesError('Hermes native-pkce 认证暂不支持', 'protocol-incompatible')
    }
    return {
      client: new HermesDashboardWsClient((wsUrl) => transport.connectWebSocket(wsUrl), onClose),
      url,
    }
  }
}

export const hermesDashboardConnectionBroker = new HermesDashboardConnectionBroker()
