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
