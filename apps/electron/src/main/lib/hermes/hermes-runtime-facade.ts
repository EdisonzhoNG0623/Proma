import { posix, win32 } from 'node:path'
import type {
  HermesProtocol,
  HermesTarget,
  HermesTurnAttachment,
  HermesTurnInput,
  HermesTurnSubmitState,
  SDKMessage,
  SDKUserMessageInput,
} from '@proma/shared'
import { buildDashboardRestAuthHeaders } from './hermes-auth'
import { HermesApiServerAdapter } from './hermes-api-server-adapter'
import {
  HermesDashboardConnectionBroker,
  hermesDashboardConnectionBroker,
  type HermesDashboardBrokerLease,
} from './hermes-dashboard-connection-broker'
import type { HermesSessionCreateInput, HermesSessionResult } from './hermes-dashboard-adapter'
import { HermesError, HermesRpcError } from './hermes-errors'
import { HermesSdkMessageMapper, type HermesTurnEvent } from './hermes-sdk-message-mapper'
import { normalizeApiServerEvent, normalizeDashboardNotification } from './hermes-turn-normalizer'
import type { HermesCredentialSlot } from './hermes-credential-store'
import type { HermesSseHandle, HermesTransport } from './transport/hermes-transport'

export interface HermesRuntimeQueryInput {
  agentRuntime?: 'hermes-remote'
  sessionId: string
  prompt: string
  model?: string
  hermesTurn?: HermesTurnInput
  onHermesTurnSubmitState?: (state: HermesTurnSubmitState) => void
}

export interface HermesSessionBinding {
  targetId: string
  protocol?: HermesProtocol
  profile?: string
  remoteSessionId?: string
  workspaceSlug?: string
  remoteCwd?: string
  title?: string
}

export interface HermesDashboardPasswordCredential {
  username: string
  password: string
}

export interface HermesRuntimeDeps {
  getTarget(targetId: string): HermesTarget | null
  getBinding(sessionId: string): HermesSessionBinding | null
  persistRemoteSessionId(
    sessionId: string,
    remoteSessionId: string,
    expected: Pick<HermesSessionBinding, 'targetId' | 'protocol' | 'profile'>,
  ): boolean | void
  buildTransport(target: HermesTarget, protocol?: HermesProtocol): Promise<HermesTransport>
  getTargetCredential?(targetId: string, slot: HermesCredentialSlot): string | null
  dashboardBroker?: HermesDashboardConnectionBroker
  /** Legacy credential bridge kept only for V1 target migration/media compatibility. */
  getCredential?(ref: string): string | null
  saveCredential?(ref: string, secret: string): void
  readDashboardPassword?(ref: string): HermesDashboardPasswordCredential | null
  ensureRemoteCwd?(targetId: string, cwd: string): Promise<boolean>
}

interface ActiveTurn {
  protocol: HermesProtocol
  dashboardLease?: HermesDashboardBrokerLease
  apiServer?: HermesApiServerAdapter
  apiTransport?: HermesTransport
  sseHandle?: HermesSseHandle
  runId?: string
  hermesSessionId?: string
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_TURN_ATTACHMENT_BYTES = 40 * 1024 * 1024

export function resolveHermesSessionFilePath(cwd: string, fileRef: string): string {
  if (!cwd.trim() || !fileRef.trim() || cwd.includes('\0') || fileRef.includes('\0')) {
    throw new HermesError('Hermes 附件路径无效', 'invalid-response')
  }
  const pathApi = /^[A-Za-z]:[\\/]/.test(cwd) ? win32 : posix
  const root = pathApi.resolve(cwd)
  const resolved = pathApi.resolve(root, fileRef)
  const relative = pathApi.relative(root, resolved)
  if (!relative || relative === '.') throw new HermesError('Hermes 附件必须指向文件', 'invalid-response')
  if (relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    throw new HermesError('Hermes 附件路径越出远端会话目录', 'invalid-response')
  }
  return resolved
}

function decodedBase64Size(base64: string): number {
  const raw = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64
  const compact = raw.replace(/\s+/g, '')
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new HermesError('Hermes 附件不是合法 base64', 'invalid-response')
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
  return Math.floor((compact.length * 3) / 4) - padding
}

export function validateHermesTurnAttachments(attachments: HermesTurnAttachment[]): void {
  let total = 0
  for (const attachment of attachments) {
    const bytes = decodedBase64Size(attachment.base64)
    if (bytes > MAX_ATTACHMENT_BYTES) throw new HermesError(`附件 ${attachment.name} 超过 25 MiB`, 'invalid-response')
    total += bytes
  }
  if (total > MAX_TURN_ATTACHMENT_BYTES) throw new HermesError('本次附件总大小超过 40 MiB', 'invalid-response')
}

export class HermesRuntimeFacade {
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly turnQueues = new Map<string, HermesTurnEvent[]>()
  private readonly dashboardBroker: HermesDashboardConnectionBroker

  constructor(private readonly deps: HermesRuntimeDeps) {
    this.dashboardBroker = deps.dashboardBroker ?? hermesDashboardConnectionBroker
  }

  async *query(input: HermesRuntimeQueryInput): AsyncIterable<SDKMessage> {
    const binding = this.requireBinding(input.sessionId)
    const target = this.requireTarget(binding.targetId)
    const protocol = binding.protocol ?? 'dashboard'
    const active: ActiveTurn = { protocol }
    let turnAccepted = false
    const routedInput: HermesRuntimeQueryInput = {
      ...input,
      onHermesTurnSubmitState: (state) => {
        if (state.status === 'accepted') turnAccepted = true
        input.onHermesTurnSubmitState?.(state)
      },
    }
    this.activeTurns.set(input.sessionId, active)
    try {
      if (protocol === 'dashboard') {
        yield* this.runDashboardTurn(active, target, binding, routedInput)
      } else {
        yield* this.runApiServerTurn(active, target, binding, routedInput)
      }
    } catch (error) {
      if (input.hermesTurn && !turnAccepted) input.onHermesTurnSubmitState?.({
        clientMessageId: input.hermesTurn.clientMessageId,
        status: 'rejected',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      this.activeTurns.delete(input.sessionId)
      this.turnQueues.delete(input.sessionId)
      active.sseHandle?.abort()
      active.dashboardLease?.untrackSession(input.sessionId)
      active.dashboardLease?.release()
      active.apiTransport?.dispose()
    }
  }

  private async *runDashboardTurn(
    active: ActiveTurn,
    target: HermesTarget,
    binding: HermesSessionBinding,
    input: HermesRuntimeQueryInput,
  ): AsyncIterable<SDKMessage> {
    const lease = await this.dashboardBroker.acquire(target)
    active.dashboardLease = lease
    const session = await this.ensureDashboardSession(lease, binding, input.sessionId)
    active.hermesSessionId = session.sessionId
    lease.trackSession(
      input.sessionId,
      session.storedSessionId,
      this.resumeInput(binding),
      (resumed) => { active.hermesSessionId = resumed.sessionId },
      session.sessionId,
    )
    const off = lease.subscribeSession(input.sessionId, (event) => {
      const normalized = normalizeDashboardNotification('event', {
        type: event.type,
        ...(event.sessionId ? { session_id: event.sessionId } : {}),
        payload: event.payload,
      })
      if (normalized) this.enqueueTurnEvent(input.sessionId, normalized)
    })
    try {
      const attachments = input.hermesTurn?.attachments ?? []
      validateHermesTurnAttachments(attachments)
      const prompt = await lease.withAdapter(async (dashboard) => {
        const refs: string[] = []
        for (const attachment of attachments) {
          if (attachment.kind === 'image') {
            // image.attach_bytes only queues pixels in the live gateway session; Hermes
            // persists prompt text, not that transient queue. Include the returned
            // canonical path as an @image directive so REST history can reconstruct the
            // media after every Proma process restart without relying on local JSONL.
            const result = await dashboard.attachImageBytes(session.sessionId, attachment.base64, attachment.name) as { path?: unknown }
            if (typeof result.path !== 'string' || !result.path.trim()) {
              throw new HermesError('Hermes image.attach_bytes 未返回持久路径', 'invalid-response')
            }
            refs.push(`@image:${result.path.trim()}`)
          } else {
            const dataUrl = `data:${attachment.mimeType || 'application/octet-stream'};base64,${attachment.base64}`
            const result = await dashboard.attachFile(session.sessionId, dataUrl, attachment.name) as { ref_text?: unknown }
            if (typeof result.ref_text === 'string' && result.ref_text.trim()) refs.push(result.ref_text.trim())
          }
        }
        const composed = [input.prompt, ...refs].filter((part) => part.trim().length > 0).join('\n')
        if (!composed) throw new HermesError('Hermes turn 不能同时缺少文本和附件', 'invalid-response')
        await this.submitPromptWithRetry(dashboard, session.sessionId, composed)
        return composed
      })
      if (input.hermesTurn) input.onHermesTurnSubmitState?.({
        clientMessageId: input.hermesTurn.clientMessageId,
        status: 'accepted',
      })
      void prompt
      yield* this.drainTurnMessages(input.sessionId)
    } finally {
      off()
    }
  }

  private async *runApiServerTurn(
    active: ActiveTurn,
    target: HermesTarget,
    binding: HermesSessionBinding,
    input: HermesRuntimeQueryInput,
  ): AsyncIterable<SDKMessage> {
    if ((input.hermesTurn?.attachments.length ?? 0) > 0) {
      throw new HermesError('Hermes API Server 模式暂不支持附件；请选择 Dashboard 协议', 'protocol-incompatible')
    }
    const apiKey = this.targetCredential(target, 'api-server-key')
    if (!apiKey) throw new HermesError('缺少 API Server key，请在 Hermes 设置中配置', 'unauthorized')
    const transport = await this.deps.buildTransport(target, 'api-server')
    active.apiTransport = transport
    const adapter = new HermesApiServerAdapter(transport, apiKey)
    active.apiServer = adapter
    const run = await adapter.createRun({
      input: input.prompt,
      sessionId: binding.remoteSessionId,
      model: input.model,
    })
    active.runId = run.runId
    if (input.hermesTurn) input.onHermesTurnSubmitState?.({
      clientMessageId: input.hermesTurn.clientMessageId,
      status: 'accepted',
    })
    const mapper = new HermesSdkMessageMapper({ sessionId: input.sessionId })
    const events: HermesTurnEvent[] = []
    const handle = await adapter.openRunEvents(run.runId, (event) => {
      const normalized = normalizeApiServerEvent(event)
      if (normalized) events.push(normalized)
    })
    active.sseHandle = handle
    await handle.done
    for (const event of events) yield* mapper.push(event)
    yield* mapper.flush()
  }

  private async ensureDashboardSession(
    lease: HermesDashboardBrokerLease,
    binding: HermesSessionBinding,
    localSessionId: string,
  ): Promise<HermesSessionResult> {
    const resumeInput = this.resumeInput(binding)
    const resumed = binding.remoteSessionId
      ? await lease.withAdapter((dashboard) => dashboard.resumeSession(binding.remoteSessionId!, resumeInput)).catch((error: unknown) => {
          if (error instanceof HermesRpcError && (error.rpcCode === 4007 || /session not found/i.test(error.message))) return null
          throw error
        })
      : null
    const result = resumed ?? await lease.withAdapter((dashboard) => dashboard.createSession({
      ...resumeInput,
      ...(binding.title ? { title: binding.title } : {}),
      ...(binding.remoteCwd ? { cwd: binding.remoteCwd } : {}),
    }))
    if (result.created) {
      const persisted = this.deps.persistRemoteSessionId(localSessionId, result.storedSessionId, {
        targetId: binding.targetId,
        protocol: binding.protocol ?? 'dashboard',
        profile: binding.profile,
      })
      if (persisted === false) throw new HermesError('Hermes binding 已变化，拒绝写入旧远端会话', 'unknown')
    }
    if (binding.title) {
      await lease.withAdapter((dashboard) => dashboard.setSessionTitle(result.sessionId, binding.title!)).catch(() => undefined)
    }
    return result
  }

  private resumeInput(binding: HermesSessionBinding): HermesSessionCreateInput {
    return { profile: binding.profile, cols: 96, closeOnDisconnect: false }
  }

  private async submitPromptWithRetry(
    dashboard: import('./hermes-dashboard-adapter').HermesDashboardAdapter,
    sessionId: string,
    text: string,
    deadlineMs = 30_000,
  ): Promise<unknown> {
    const deadline = Date.now() + deadlineMs
    while (true) {
      try {
        return await dashboard.submitPrompt(sessionId, text)
      } catch (error) {
        const busyRpc = error instanceof HermesRpcError && error.rpcCode === 4009
        const busyText = error instanceof HermesRpcError && /busy|not ready|agent/i.test(error.message)
        if ((busyRpc || busyText) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        // Timeout/network after send has unknown outcome: never replay a mutating prompt.
        throw error
      }
    }
  }

  private enqueueTurnEvent(sessionId: string, event: HermesTurnEvent): void {
    const queue = this.turnQueues.get(sessionId) ?? []
    queue.push(event)
    this.turnQueues.set(sessionId, queue)
  }

  private async *drainTurnMessages(sessionId: string): AsyncIterable<SDKMessage> {
    const mapper = new HermesSdkMessageMapper({ sessionId })
    const stallTimeoutMs = 300_000
    let lastEventAt = Date.now()
    while (true) {
      const queue = this.turnQueues.get(sessionId) ?? []
      this.turnQueues.set(sessionId, [])
      let terminal = false
      for (const event of queue) {
        lastEventAt = Date.now()
        yield* mapper.push(event)
        if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'error') terminal = true
      }
      if (terminal) {
        yield* mapper.flush()
        return
      }
      if (!this.activeTurns.has(sessionId)) {
        yield* mapper.flush()
        return
      }
      if (Date.now() - lastEventAt > stallTimeoutMs) {
        throw new HermesError('Hermes turn 超过 5 分钟无事件', 'timeout')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  isActive(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
  }

  hasActiveTurns(): boolean {
    return this.activeTurns.size > 0
  }

  activeSessionIds(): string[] {
    return [...this.activeTurns.keys()]
  }

  abort(sessionId: string): void {
    const active = this.activeTurns.get(sessionId)
    if (!active) return
    active.sseHandle?.abort()
    active.dashboardLease?.untrackSession(sessionId)
    active.dashboardLease?.release()
    active.apiTransport?.dispose()
    this.activeTurns.delete(sessionId)
    this.turnQueues.delete(sessionId)
  }

  async interruptQuery(sessionId: string): Promise<void> {
    const active = this.activeTurns.get(sessionId)
    if (!active) return
    if (active.protocol === 'dashboard' && active.dashboardLease && active.hermesSessionId) {
      await active.dashboardLease.withAdapter((dashboard) => dashboard.interruptSession(active.hermesSessionId!)).then(() => undefined)
      return
    }
    if (active.apiServer && active.runId) {
      await active.apiServer.stopRunAndWait(active.runId)
      active.sseHandle?.abort()
    }
  }

  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    const active = this.activeTurns.get(sessionId)
    if (!active?.dashboardLease || !active.hermesSessionId) throw new HermesError('会话不在活跃 Dashboard 状态', 'unknown')
    const text = message?.message?.content
    if (!text) throw new HermesError('追加消息为空', 'unknown')
    await active.dashboardLease.withAdapter((dashboard) => dashboard.submitPrompt(active.hermesSessionId!, text)).then(() => undefined)
  }

  async respondInteraction(input: {
    sessionId: string
    type: 'approval' | 'clarify' | 'sudo' | 'secret'
    requestId?: string
    choice?: 'allow' | 'deny'
    all?: boolean
    answer?: string
    password?: string
    value?: string
  }): Promise<void> {
    const active = this.activeTurns.get(input.sessionId)
    if (!active?.dashboardLease || !active.hermesSessionId) throw new HermesError('会话不在活跃 Dashboard 状态', 'unknown')
    await active.dashboardLease.withAdapter(async (dashboard) => {
      const remote = active.hermesSessionId!
      if (input.type === 'approval') await dashboard.respondApproval({ sessionId: remote, choice: input.choice ?? 'allow', all: input.all })
      else if (input.type === 'clarify') {
        if (!input.answer || !input.requestId) throw new HermesError('clarify 缺少 answer/requestId', 'unknown')
        await dashboard.respondClarify({ sessionId: remote, answer: input.answer, requestId: input.requestId })
      } else if (input.type === 'sudo') {
        if (!input.password || !input.requestId) throw new HermesError('sudo 缺少 password/requestId', 'unknown')
        await dashboard.respondSudo({ sessionId: remote, password: input.password, requestId: input.requestId })
      } else {
        if (!input.value || !input.requestId) throw new HermesError('secret 缺少 value/requestId', 'unknown')
        await dashboard.respondSecret({ sessionId: remote, value: input.value, requestId: input.requestId })
      }
    })
  }

  async fetchMedia(targetId: string, mediaPath: string): Promise<{ dataUrl?: string } | null> {
    const target = this.deps.getTarget(targetId)
    if (!target || !mediaPath || mediaPath.includes('\0')) return null
    let authLease: HermesDashboardBrokerLease | null = null
    try {
      if (target.auth.dashboardMode === 'password-cookie') authLease = await this.dashboardBroker.acquire(target)
      const transport = await this.deps.buildTransport(target, 'dashboard')
      try {
        const token = target.auth.dashboardMode === 'token' ? this.targetCredential(target, 'dashboard-token') ?? undefined : undefined
        const response = await transport.requestJson(`/api/media?path=${encodeURIComponent(mediaPath)}`, {
          headers: buildDashboardRestAuthHeaders(target.auth.dashboardMode, token),
          timeoutMs: 15_000,
        })
        if (response.status !== 200 || !response.body || typeof response.body !== 'object') return null
        const dataUrl = (response.body as { data_url?: unknown }).data_url
        return typeof dataUrl === 'string' ? { dataUrl } : null
      } finally {
        transport.dispose()
      }
    } catch {
      return null
    } finally {
      authLease?.release()
    }
  }

  async fetchAttachment(sessionId: string, fileRef: string): Promise<{ dataUrl: string; name: string; cacheIdentity: string } | null> {
    const binding = this.deps.getBinding(sessionId)
    if (!binding?.targetId || (binding.protocol ?? 'dashboard') !== 'dashboard' || !binding.remoteSessionId) return null
    const target = this.deps.getTarget(binding.targetId)
    if (!target || !fileRef.trim() || fileRef.includes('\0')) return null
    let authLease: HermesDashboardBrokerLease | null = null
    try {
      if (target.auth.dashboardMode === 'password-cookie') authLease = await this.dashboardBroker.acquire(target)
      const transport = await this.deps.buildTransport(target, 'dashboard')
      try {
        const token = target.auth.dashboardMode === 'token' ? this.targetCredential(target, 'dashboard-token') ?? undefined : undefined
        const headers = buildDashboardRestAuthHeaders(target.auth.dashboardMode, token)
        const profileQuery = binding.profile ? `?profile=${encodeURIComponent(binding.profile)}` : ''
        const detail = await transport.requestJson(
          `/api/sessions/${encodeURIComponent(binding.remoteSessionId)}${profileQuery}`,
          { headers, timeoutMs: 10_000 },
        )
        if (detail.status !== 200 || !detail.body || typeof detail.body !== 'object') return null
        const cwd = (detail.body as { cwd?: unknown }).cwd
        if (typeof cwd !== 'string' || !cwd.trim()) return null
        const absolutePath = resolveHermesSessionFilePath(cwd, fileRef)
        const response = await transport.requestJson(`/api/fs/read-data-url?path=${encodeURIComponent(absolutePath)}`, {
          headers,
          timeoutMs: 20_000,
        })
        if (response.status !== 200 || !response.body || typeof response.body !== 'object') return null
        const dataUrl = (response.body as { dataUrl?: unknown }).dataUrl
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null
        const pathApi = /^[A-Za-z]:[\\/]/.test(absolutePath) ? win32 : posix
        return {
          dataUrl,
          name: pathApi.basename(absolutePath),
          cacheIdentity: `${target.id}:${binding.remoteSessionId}:${absolutePath}`,
        }
      } finally {
        transport.dispose()
      }
    } catch {
      return null
    } finally {
      authLease?.release()
    }
  }

  dispose(): void {
    for (const [sessionId] of [...this.activeTurns]) this.abort(sessionId)
    void this.dashboardBroker.disposeAll()
  }

  private requireBinding(sessionId: string): HermesSessionBinding {
    const binding = this.deps.getBinding(sessionId)
    if (!binding?.targetId) throw new HermesError('会话未绑定 Hermes target，请先在 Hermes 设置中绑定', 'unknown')
    return binding
  }

  private requireTarget(targetId: string): HermesTarget {
    const target = this.deps.getTarget(targetId)
    if (!target) throw new HermesError('Hermes target 不存在或已删除', 'unknown')
    return target
  }

  private targetCredential(target: HermesTarget, slot: HermesCredentialSlot): string | null {
    const owned = this.deps.getTargetCredential?.(target.id, slot)
    if (owned) return owned
    const legacyRef = slot === 'api-server-key' ? target.auth.apiServerKeyRef : target.auth.dashboardCredentialRef
    return legacyRef && this.deps.getCredential ? this.deps.getCredential(legacyRef) : null
  }
}
