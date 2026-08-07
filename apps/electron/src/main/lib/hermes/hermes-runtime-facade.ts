/**
 * Hermes Runtime Facade
 *
 * 实现 AgentProviderAdapter，把远端 Hermes 作为 Proma Agent 的 External Runtime：
 * - query：按会话绑定的 target 建立连接 → Dashboard 优先（session.create/resume + prompt.submit + WS 事件流）
 *   → API Server fallback（/v1/runs + SSE）；
 * - 远端事件归一化为 HermesTurnEvent，再映射为 SDKMessage 流（HermesSdkMessageMapper）；
 * - abort / interruptQuery：停止远端 run / 断开 WS；
 * - dispose：清理全部活跃连接。
 *
 * 设计约束（方案文档）：
 * - 不伪装成 Proma Local；禁止断线时静默降级到本地执行（Dashboard 不可用时仅可切 API Server，仍是远端）；
 * - 会话绑定（targetId/profile/remoteSessionId）由调用方（agent-session-manager）持久化。
 */

import type { AgentProviderAdapter, AgentQueryInput, SDKMessage } from '@proma/shared'
import { HermesError } from './hermes-errors'
import { HermesAuthService, buildTicketWsUrl, canSubmitPasswordTo } from './hermes-auth'
import { HermesDashboardAdapter, type HermesSessionResult } from './hermes-dashboard-adapter'
import { HermesDashboardWsClient, type HermesWsNotificationHandler } from './hermes-dashboard-ws-client'
import { HermesApiServerAdapter } from './hermes-api-server-adapter'
import { HermesSdkMessageMapper, type HermesTurnEvent } from './hermes-sdk-message-mapper'
import { normalizeApiServerEvent, normalizeDashboardNotification } from './hermes-turn-normalizer'
import type { HermesTransport } from './transport/hermes-transport'
import type { HermesTarget } from '@proma/shared'

/** 会话绑定（持久化在 AgentSessionMeta 中） */
export interface HermesSessionBinding {
  targetId: string
  profile?: string
  remoteSessionId?: string
  /** 工作区 slug（用于远端 cwd 指向同步目录） */
  workspaceSlug?: string
  /** 显式远端 cwd（优先于 workspaceSlug 推导；如 ~/proma-projects/<项目名>） */
  remoteCwd?: string
  /** Proma 会话标题（新建远端会话时同步为 Hermes 标题） */
  title?: string
}

/** 读取 dashboard-password 凭据的解密结果 */
export interface HermesDashboardPasswordCredential {
  username: string
  password: string
}

/** Facade 依赖（接入 agent-service 时注入真实实现；测试注入 mock） */
export interface HermesRuntimeDeps {
  /** 读取 target */
  getTarget(targetId: string): HermesTarget | null
  /** 读取凭据明文（ref → secret） */
  getCredential(ref: string): string | null
  /** 保存凭据明文（ref → secret；用于持久化 Dashboard Cookie 复用） */
  saveCredential(ref: string, secret: string): void
  /** 读取 dashboard 密码凭据（ref → { username, password }） */
  readDashboardPassword(ref: string): HermesDashboardPasswordCredential | null
  /** 读取会话绑定 */
  getBinding(sessionId: string): HermesSessionBinding | null
  /** 持久化远端会话 ID（stored_session_id） */
  persistRemoteSessionId(sessionId: string, remoteSessionId: string): void
  /** 构建 target 的 transport（Direct 或 SSH Tunnel） */
  buildTransport(target: HermesTarget): Promise<HermesTransport>
  /**
   * 确保远端目录存在（SFTP mkdirp，用于自动创建同名项目目录）。
   * 无 SSH 配置或失败时返回 false（不阻塞会话，Hermes 会忽略不存在的 cwd）。
   */
  ensureRemoteCwd(targetId: string, cwd: string): Promise<boolean>
}

/** 活跃 turn 连接状态 */
interface ActiveTurn {
  dashboard?: HermesDashboardAdapter
  dashboardClient?: HermesDashboardWsClient
  apiServer?: HermesApiServerAdapter
  runId?: string
  transport: HermesTransport
}

/**
 * Hermes Runtime Facade
 */
export class HermesRuntimeFacade implements AgentProviderAdapter {
  private readonly activeTurns = new Map<string, ActiveTurn>()

  constructor(private readonly deps: HermesRuntimeDeps) {}

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const binding = this.deps.getBinding(input.sessionId)
    if (!binding?.targetId) {
      throw new HermesError('会话未绑定 Hermes target，请先在 Hermes 设置中绑定', 'unknown')
    }
    const target = this.deps.getTarget(binding.targetId)
    if (!target) {
      throw new HermesError('Hermes target 不存在或已删除', 'unknown')
    }

    const transport = await this.deps.buildTransport(target)
    const active: ActiveTurn = { transport }
    this.activeTurns.set(input.sessionId, active)

    try {
      // Dashboard 优先；服务不存在（404/连接拒绝）时回退 API Server
      try {
        yield* this.runDashboardTurn(active, target, binding, input)
      } catch (error) {
        if (error instanceof HermesError && error.code === 'service-not-found') {
          yield* this.runApiServerTurn(active, target, binding, input)
          return
        }
        throw error
      }
    } finally {
      this.activeTurns.delete(input.sessionId)
      transport.dispose()
    }
  }

  /**
   * Dashboard turn：认证 → 建 WS → create/resume session → submit prompt → 事件流。
   */
  private async *runDashboardTurn(
    active: ActiveTurn,
    target: HermesTarget,
    binding: HermesSessionBinding,
    input: AgentQueryInput,
  ): AsyncIterable<SDKMessage> {
    const transport = active.transport
    const auth = new HermesAuthService(transport)

    // 认证：password-cookie 或 token
    const mode = target.auth.dashboardMode ?? 'password-cookie'

    // 1. 复用持久化 Cookie（避免每次 turn 都密码登录触发 429 限流）
    if (mode === 'password-cookie') {
      const cookieRef = `hermes-cookie-${binding.targetId}`
      const persistedCookie = this.deps.getCredential(cookieRef)
      if (persistedCookie) {
        try {
          const jar = JSON.parse(persistedCookie) as Record<string, string>
          const targetJar = auth.cookieJarFor(binding.targetId)
          for (const [name, value] of Object.entries(jar)) {
            targetJar.set(name, value)
          }
        } catch {
          // Cookie 解析失败则忽略，走登录流程
        }
      }
    }

    // 2. 尝试用现有 Cookie 直接 mint ticket；401 再密码登录并持久化 Cookie
    let ticket: string
    try {
      ticket = await auth.mintWsTicket(binding.targetId)
    } catch (error) {
      const isAuthError = error instanceof HermesError && error.code === 'unauthorized'
      if (!isAuthError || mode !== 'password-cookie') {
        throw error
      }
      const credential = this.deps.readDashboardPassword(target.auth.dashboardCredentialRef ?? '')
      if (!credential) {
        throw new HermesError('缺少 Hermes 账号密码凭据，请在 Hermes 设置中登录', 'unauthorized')
      }
      if (!canSubmitPasswordTo(transport.baseUrl)) {
        throw new HermesError(
          'http 非 loopback 地址不允许提交 Hermes 密码（请使用 HTTPS 或 SSH Tunnel）',
          'network',
        )
      }
      await auth.passwordLogin(binding.targetId, {
        provider: target.auth.dashboardProvider ?? 'basic',
        username: credential.username,
        password: credential.password,
      })
      // 持久化 Cookie（含 refresh cookie，供后续复用）
      const jar = Object.fromEntries(auth.cookieJarFor(binding.targetId).entries())
      if (Object.keys(jar).length > 0) {
        try {
          this.deps.saveCredential(`hermes-cookie-${binding.targetId}`, JSON.stringify(jar))
        } catch (cookieError) {
          console.warn('[Hermes] 持久化 Dashboard Cookie 失败:', cookieError instanceof Error ? cookieError.message : String(cookieError))
        }
      }
      ticket = await auth.mintWsTicket(binding.targetId)
    }

    const wsUrl = buildTicketWsUrl(transport.baseUrl, ticket)
    const client = new HermesDashboardWsClient((url) => transport.connectWebSocket(url))
    active.dashboardClient = client
    await client.connect(wsUrl)
    const dashboard = new HermesDashboardAdapter(client)
    active.dashboard = dashboard

    console.log('[Hermes] turn 开始 binding:', JSON.stringify({ remoteSessionId: binding.remoteSessionId, title: binding.title, remoteCwd: binding.remoteCwd, workspaceSlug: binding.workspaceSlug }))

    // create / resume 远端会话（cwd 优先显式 remoteCwd，否则用同步目录）
    const remoteCwd = binding.remoteCwd
      ?? (binding.workspaceSlug ? `~/proma-projects/${binding.workspaceSlug}` : undefined)
    // 新建远端会话前：有 SSH 时用 SFTP 快速确保 cwd 目录存在（无 SSH 返回 false，稍后走免 SSH 引导）
    let preEnsuredCwd = false
    if (remoteCwd && !binding.remoteSessionId) {
      try {
        preEnsuredCwd = await this.deps.ensureRemoteCwd(binding.targetId, remoteCwd)
      } catch (error) {
        console.warn('[Hermes] ensureRemoteCwd 异常:', error instanceof Error ? error.message : String(error))
      }
    }
    const session = binding.remoteSessionId
      ? await dashboard.resumeSession(binding.remoteSessionId, {
          profile: binding.profile,
          cols: 96,
          ...(remoteCwd ? { cwd: remoteCwd } : {}),
        }).catch((error: unknown) => {
          // session not found 时重新创建
          if (error instanceof Error && /session not found/i.test(error.message)) {
            return null
          }
          throw error
        })
      : null
    const resolvedSession: HermesSessionResult = session ?? await dashboard.createSession({
      profile: binding.profile,
      cols: 96,
      ...(binding.title ? { title: binding.title } : {}),
      ...(remoteCwd ? { cwd: remoteCwd } : {}),
    })
    console.log('[Hermes] 会话模式:', session ? 'resume' : 'create', 'sid=', resolvedSession.sessionId, 'created=', resolvedSession.created)
    if (resolvedSession.created) {
      this.deps.persistRemoteSessionId(input.sessionId, resolvedSession.storedSessionId)
    }
    // 标题同步：把 Proma 当前标题同步到远端（含重命名后；create 时已在 session.create 传 title，resume 时这里补同步）
    if (binding.title) {
      try {
        await dashboard.setSessionTitle(resolvedSession.sessionId, binding.title)
        console.log('[Hermes] 已同步远端标题:', binding.title)
      } catch (error) {
        console.warn('[Hermes] 同步远端标题失败:', error instanceof Error ? error.message : String(error))
      }
    }

    // 事件 handler 提前注册：引导 turn（mkdir 初始化）也需要被监听
    const mapper = new HermesSdkMessageMapper({
      sessionId: input.sessionId,
      model: input.model,
    })
    const notificationHandler: HermesWsNotificationHandler = (method, params) => {
      const turnEvent = normalizeDashboardNotification(method, params)
      if (!turnEvent) return
      this.dispatchTurnEvent(active, input.sessionId, turnEvent)
    }
    const off = client.onNotification(notificationHandler)

    try {
      // 新建会话：SFTP 未确保目录时走免 SSH 引导（让 Hermes Agent 自己 mkdir，然后 cwd.set）
      if (resolvedSession.created && remoteCwd && !preEnsuredCwd) {
        await this.bootstrapRemoteCwd(dashboard, resolvedSession.sessionId, remoteCwd, binding.profile)
      }

      await this.submitPromptWithRetry(dashboard, resolvedSession.sessionId, input.prompt, binding.profile)

      // 等待 turn 结束：poll mapper 输出（notification 已同步进入 mapper）
      // 首版采用同步事件流：notification 处理中直接产出（由 dispatchTurnEvent 缓存后这里消费）
      yield* this.drainTurnMessages(active, input.sessionId)
    } finally {
      off()
    }
  }

  /**
   * 提交 prompt 并容忍 Hermes 会话未就绪（session busy / agent not ready）：
   * 新会话刚创建时 Agent 异步构建，立即提交会被拒绝，重试直至就绪或超时。
   */
  private async submitPromptWithRetry(
    dashboard: HermesDashboardAdapter,
    sessionId: string,
    text: string,
    profile?: string,
    deadlineMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + deadlineMs
    while (true) {
      try {
        await dashboard.submitPrompt(sessionId, text, profile)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/busy|not ready|agent/i.test(message) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          continue
        }
        throw error
      }
    }
  }

  /**
   * 免 SSH 引导：让 Hermes Agent 在远端执行 mkdir -p 创建项目目录，
   * 完成后用 session.cwd.set 把会话 cwd 指向该目录（引导 turn 事件丢弃，不进对话）。
   * 失败不阻断（Hermes 会忽略不存在的 cwd，会话落默认 workspace）。
   */
  private async bootstrapRemoteCwd(
    dashboard: HermesDashboardAdapter,
    sessionId: string,
    cwd: string,
    profile?: string,
  ): Promise<void> {
    try {
      // 会话刚创建时 Hermes Agent 可能还在异步构建（prompt.submit 会报 session busy），重试直至就绪
      await this.submitPromptWithRetry(
        dashboard,
        sessionId,
        `Proma 初始化：请仅执行 bash 命令 mkdir -p ${cwd}，不要做任何其他操作，完成后只回复 OK。`,
        profile,
        30_000,
      )
      console.log('[Hermes] 引导指令已提交，等待 turn 完成…')
      // 等待引导 turn 完成（事件进入队列但此处直接消费丢弃）
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const queue = this.turnQueues.get(sessionId) ?? []
        this.turnQueues.set(sessionId, [])
        let terminated = false
        for (const event of queue) {
          console.log('[Hermes] 引导事件:', event.type)
          if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'error') {
            terminated = true
          }
        }
        if (terminated) break
        await new Promise((resolve) => setTimeout(resolve, 25))
        if (!this.activeTurns.has(sessionId)) break
      }
      // 目录已创建，把会话 cwd 指向项目目录（session.cwd.set 要求目录存在；turn teardown 可能未完成，busy 时重试）
      const cwdDeadline = Date.now() + 30_000
      while (true) {
        try {
          await dashboard.setSessionCwd(sessionId, cwd)
          console.log('[Hermes] 引导完成，会话 cwd 已设为:', cwd)
          return
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/busy|not ready/i.test(message) && Date.now() < cwdDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
            continue
          }
          console.warn('[Hermes] cwd.set 失败:', message)
          return
        }
      }
    } catch (error) {
      console.warn('[Hermes] 免 SSH 引导创建项目目录失败:', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * API Server turn：createRun → SSE 事件流。
   */
  private async *runApiServerTurn(
    active: ActiveTurn,
    target: HermesTarget,
    binding: HermesSessionBinding,
    input: AgentQueryInput,
  ): AsyncIterable<SDKMessage> {
    const apiKey = target.auth.apiServerKeyRef
      ? this.deps.getCredential(target.auth.apiServerKeyRef)
      : null
    if (!apiKey) {
      throw new HermesError('缺少 API Server key，请在 Hermes 设置中配置', 'unauthorized')
    }
    const adapter = new HermesApiServerAdapter(active.transport, apiKey)
    active.apiServer = adapter

    const run = await adapter.createRun({
      input: input.prompt,
      sessionId: binding.remoteSessionId,
      model: input.model,
    })
    active.runId = run.runId

    const mapper = new HermesSdkMessageMapper({
      sessionId: input.sessionId,
      model: input.model,
    })

    const events: HermesTurnEvent[] = []
    const handle = await adapter.openRunEvents(run.runId, (event) => {
      const turnEvent = normalizeApiServerEvent(event)
      if (!turnEvent) return
      events.push(turnEvent)
    })
    await handle.done

    for (const event of events) {
      yield* mapper.push(event)
    }
    yield* mapper.flush()
  }

  /** 通知事件分发：把 turn 事件写入会话事件队列（由 drain 消费） */
  private dispatchTurnEvent(active: ActiveTurn, sessionId: string, event: HermesTurnEvent): void {
    let queue = this.turnQueues.get(sessionId)
    if (!queue) {
      queue = []
      this.turnQueues.set(sessionId, queue)
    }
    queue.push(event)
  }

  private readonly turnQueues = new Map<string, HermesTurnEvent[]>()

  /** 轮询消费 turn 事件直到终止事件（turn.completed / turn.failed / error） */
  private async *drainTurnMessages(active: ActiveTurn, sessionId: string): AsyncIterable<SDKMessage> {
    const mapper = new HermesSdkMessageMapper({ sessionId })
    // 一次性消费队列；终止事件后结束
    while (true) {
      const queue = this.turnQueues.get(sessionId) ?? []
      this.turnQueues.set(sessionId, [])
      let terminated = false
      for (const event of queue) {
        yield* mapper.push(event)
        if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'error') {
          terminated = true
        }
      }
      if (terminated) {
        this.turnQueues.delete(sessionId)
        return
      }
      // 队列为空：等待新事件（10ms 轮询；断线/关闭时跳出由连接 close 处理）
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (!this.activeTurns.has(sessionId)) {
        yield* mapper.flush()
        return
      }
    }
  }

  abort(sessionId: string): void {
    const active = this.activeTurns.get(sessionId)
    if (!active) return
    // 断开连接：dashboard WS close 会 reject pending，SSE handle 由 transport dispose 关闭
    active.dashboardClient?.close()
    this.activeTurns.delete(sessionId)
  }

  async interruptQuery(sessionId: string): Promise<void> {
    const active = this.activeTurns.get(sessionId)
    if (!active) return
    if (active.dashboard && active.dashboardClient) {
      // Dashboard 中断需要 runtime session id；Facade 不持有时由上层通过 IPC 调用 adapter
      // 首版：直接断开 WS 视为中断（远端 turn 会随连接关闭而取消）
      active.dashboardClient.close()
      return
    }
    if (active.apiServer && active.runId) {
      await active.apiServer.stopRun(active.runId)
    }
  }

  dispose(): void {
    for (const [sessionId, active] of this.activeTurns.entries()) {
      active.dashboardClient?.close()
      active.transport.dispose()
      this.activeTurns.delete(sessionId)
    }
    this.turnQueues.clear()
  }
}
