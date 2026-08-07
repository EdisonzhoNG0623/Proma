/**
 * Hermes Dashboard Adapter
 *
 * 基于 Hermes Dashboard `/api/ws` JSON-RPC 的会话与交互适配：
 * - session.create / session.resume（含 seed messages / profile / cwd）
 * - prompt.submit（含 profile 作用域）
 * - session.interrupt
 * - approval.respond / clarify.respond / sudo.respond / secret.respond
 *
 * 协议细节参考 Hermes Agent `tui_gateway/methods_session.py`、`methods_prompt.py`：
 * - approval.respond 参数：{ session_id, choice: 'allow'|'deny', all? }
 * - clarify.respond 参数：{ session_id, answer }
 * - session.create/resume 返回 { session_id, stored_session_id, resumed? }
 */

import { HermesDashboardWsClient } from './hermes-dashboard-ws-client'
import type { HermesWsConnector } from './hermes-dashboard-ws-client'
import type { HermesRemoteProject, HermesProjectTree, HermesRemoteSessionSummary } from '@proma/shared'

/** 会话创建输入 */
export interface HermesSessionCreateInput {
  /** 终端列宽（默认 96） */
  cols?: number
  /** seed 历史消息（可选） */
  messages?: Array<{ role: string; content: string }>
  /** 工作目录（可选） */
  cwd?: string
  /** 远端 profile 名（可选） */
  profile?: string
  /** 模型 ID（可选，per-session override） */
  model?: string
  /** provider（可选） */
  provider?: string
  /** 断线是否关闭会话（默认 false） */
  closeOnDisconnect?: boolean
}

/** 会话创建/恢复结果 */
export interface HermesSessionResult {
  /** 运行时 session_id（进程内） */
  sessionId: string
  /** 持久 stored_session_id（REST 与重连使用） */
  storedSessionId: string
  /** 是否新建（resume 时为 false） */
  created: boolean
}

/** approval 响应输入 */
export interface HermesApprovalResponseInput {
  sessionId: string
  choice: 'allow' | 'deny'
  /** 应用到本次所有待批准项 */
  all?: boolean
}

/** clarify 响应输入 */
export interface HermesClarifyResponseInput {
  sessionId: string
  answer: string
}

/** sudo 响应输入 */
export interface HermesSudoResponseInput {
  sessionId: string
  password: string
}

/** secret 响应输入 */
export interface HermesSecretResponseInput {
  sessionId: string
  value: string
}

/** 解析 session.create/resume 响应 */
export function parseSessionResult(
  body: unknown,
  created: boolean,
): HermesSessionResult {
  if (!body || typeof body !== 'object') {
    throw new Error('session 响应格式异常')
  }
  const data = body as { session_id?: unknown; stored_session_id?: unknown; resumed?: unknown }
  if (typeof data.session_id !== 'string' || !data.session_id) {
    throw new Error('session 响应缺少 session_id')
  }
  const stored = data.stored_session_id ?? data.resumed ?? data.session_id
  return {
    sessionId: data.session_id,
    storedSessionId: typeof stored === 'string' ? stored : data.session_id,
    created,
  }
}

/** 远端项目树（projects.tree 响应） */
export type { HermesRemoteProject, HermesProjectTree, HermesRemoteSessionSummary } from '@proma/shared'

/** 解析 projects.tree 响应 */
export function parseProjectTree(body: unknown): HermesProjectTree {
  if (!body || typeof body !== 'object') {
    return { projects: [], activeId: null, scopedSessionIds: [] }
  }
  const data = body as { projects?: unknown; active_id?: unknown; scoped_session_ids?: unknown }
  const projects = Array.isArray(data.projects)
    ? data.projects.filter((item): item is HermesRemoteProject =>
        !!item && typeof item === 'object' && typeof (item as HermesRemoteProject).id === 'string')
    : []
  return {
    projects,
    activeId: typeof data.active_id === 'string' ? data.active_id : null,
    scopedSessionIds: Array.isArray(data.scoped_session_ids)
      ? data.scoped_session_ids.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

/** 解析 session.list 响应 */
export function parseSessionList(body: unknown): HermesRemoteSessionSummary[] {
  if (!body || typeof body !== 'object') {
    return []
  }
  const sessions = (body as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions)) {
    return []
  }
  return sessions.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const s = item as { id?: unknown; title?: unknown; preview?: unknown; started_at?: unknown; message_count?: unknown; source?: unknown }
    if (typeof s.id !== 'string') return []
    return [{
      id: s.id,
      title: typeof s.title === 'string' ? s.title : '',
      preview: typeof s.preview === 'string' ? s.preview : '',
      startedAt: typeof s.started_at === 'number' ? s.started_at : 0,
      messageCount: typeof s.message_count === 'number' ? s.message_count : 0,
      source: typeof s.source === 'string' ? s.source : '',
    }]
  })
}

/** 远端历史消息（session.history 简化格式） */
export interface HermesHistoryMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
}

/** 解析 session.history 响应 */
export function parseHistoryMessages(body: unknown): HermesHistoryMessage[] {
  if (!body || typeof body !== 'object') {
    return []
  }
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) {
    return []
  }
  return messages.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const m = item as { role?: unknown; text?: unknown }
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool' && m.role !== 'system') {
      return []
    }
    const text = typeof m.text === 'string' ? m.text : ''
    if (!text.trim()) {
      return []
    }
    return [{ role: m.role, text }]
  })
}

/**
 * Dashboard Adapter
 */
export class HermesDashboardAdapter {
  constructor(private readonly client: HermesDashboardWsClient) {}

  /** 创建会话（可选 seed messages） */
  async createSession(input: HermesSessionCreateInput = {}): Promise<HermesSessionResult> {
    const params: Record<string, unknown> = {
      cols: input.cols ?? 96,
    }
    if (input.messages && input.messages.length > 0) {
      params.messages = input.messages
    }
    if (input.cwd) params.cwd = input.cwd
    if (input.profile) params.profile = input.profile
    if (input.model) params.model = input.model
    if (input.provider) params.provider = input.provider
    if (input.closeOnDisconnect) params.close_on_disconnect = true
    const result = await this.client.request<unknown>('session.create', params)
    return parseSessionResult(result, true)
  }

  /** 恢复持久会话 */
  async resumeSession(storedSessionId: string, input: HermesSessionCreateInput = {}): Promise<HermesSessionResult> {
    const params: Record<string, unknown> = {
      session_id: storedSessionId,
      cols: input.cols ?? 96,
    }
    if (input.profile) params.profile = input.profile
    if (input.model) params.model = input.model
    const result = await this.client.request<unknown>('session.resume', params)
    return parseSessionResult(result, false)
  }

  /** 提交 prompt（默认沿用会话 profile；显式 profile 时传入） */
  async submitPrompt(sessionId: string, text: string, profile?: string): Promise<void> {
    const params: Record<string, unknown> = { session_id: sessionId, text }
    if (profile && profile !== 'default') {
      params.profile = profile
    }
    await this.client.request<unknown>('prompt.submit', params, { timeoutMs: 60_000 })
  }

  /** 中断当前 turn */
  async interruptSession(sessionId: string): Promise<void> {
    await this.client.request<unknown>('session.interrupt', { session_id: sessionId })
  }

  /** 响应 approval */
  async respondApproval(input: HermesApprovalResponseInput): Promise<unknown> {
    const params: Record<string, unknown> = {
      session_id: input.sessionId,
      choice: input.choice,
    }
    if (input.all) params.all = true
    return await this.client.request<unknown>('approval.respond', params)
  }

  /** 响应 clarify */
  async respondClarify(input: HermesClarifyResponseInput): Promise<unknown> {
    return await this.client.request<unknown>('clarify.respond', {
      session_id: input.sessionId,
      answer: input.answer,
    })
  }

  /** 响应 sudo 密码 */
  async respondSudo(input: HermesSudoResponseInput): Promise<unknown> {
    return await this.client.request<unknown>('sudo.respond', {
      session_id: input.sessionId,
      password: input.password,
    })
  }

  /** 响应 secret */
  async respondSecret(input: HermesSecretResponseInput): Promise<unknown> {
    return await this.client.request<unknown>('secret.respond', {
      session_id: input.sessionId,
      value: input.value,
    })
  }

  /** 获取远端项目树（projects.tree：项目 → 仓库 → lane 分组） */
  async listProjects(): Promise<HermesProjectTree> {
    const result = await this.client.request<unknown>('projects.tree', {
      preview_limit: 3,
      session_limit: 2000,
    })
    return parseProjectTree(result)
  }

  /** 获取某项目的完整会话分组（projects.project_sessions） */
  async listProjectSessions(projectId: string): Promise<HermesRemoteProject | null> {
    const result = await this.client.request<unknown>('projects.project_sessions', {
      project_id: projectId,
      session_limit: 5000,
    })
    if (!result || typeof result !== 'object') {
      return null
    }
    const project = (result as { project?: unknown }).project
    if (!project || typeof project !== 'object') {
      return null
    }
    return project as HermesRemoteProject
  }

  /** 获取远端会话列表（session.list，按最近活跃排序） */
  async listSessions(limit = 200): Promise<HermesRemoteSessionSummary[]> {
    const result = await this.client.request<unknown>('session.list', { limit })
    return parseSessionList(result)
  }

  /** 获取远端会话历史（session.history，需活跃 runtime session） */
  async getSessionHistory(sessionId: string): Promise<HermesHistoryMessage[]> {
    const result = await this.client.request<unknown>('session.history', {
      session_id: sessionId,
    })
    return parseHistoryMessages(result)
  }
}

/** 创建连接后的 adapter（便捷工厂） */
export async function createDashboardAdapter(
  connector: HermesWsConnector,
  url: string,
  onClose?: (reason: string) => void,
): Promise<HermesDashboardAdapter> {
  const client = new HermesDashboardWsClient(connector, onClose)
  await client.connect(url)
  return new HermesDashboardAdapter(client)
}
