/**
 * Hermes API Server Adapter
 *
 * 基于 Hermes Agent API Server 的稳定协议（gateway/platforms/api_server.py）：
 * - POST /v1/runs                → 202 { run_id }
 * - GET  /v1/runs/{run_id}       → run 状态
 * - GET  /v1/runs/{run_id}/events→ SSE 事件流
 * - POST /v1/runs/{run_id}/approval → { choice: once|session|always|deny }
 * - POST /v1/runs/{run_id}/stop  → 中断
 * - GET  /v1/capabilities
 *
 * 认证：`Authorization: Bearer <API_SERVER_KEY>`（key 不进入日志/Renderer）。
 */

import { HermesError, hermesErrorFromHttpStatus } from './hermes-errors'
import type { HermesTransport } from './transport/hermes-transport'
import type { HermesSseHandle } from './transport/hermes-transport'

/** 创建 run 的输入 */
export interface HermesRunCreateInput {
  /** 用户消息（字符串，或消息数组的最后一个） */
  input: string
  /** 系统提示/instructions（可选） */
  instructions?: string
  /** 显式历史（可选；优先级高于 previousResponseId） */
  conversationHistory?: Array<{ role: string; content: string }>
  /** 模型 ID（可选） */
  model?: string
  /** 会话 ID（会话连续性作用域；可选） */
  sessionId?: string
}

/** 创建 run 结果 */
export interface HermesRunCreated {
  runId: string
}

/** run 事件（SSE） */
export interface HermesRunEvent {
  /** 事件类型（message.delta / tool.started / approval.request / run.completed 等） */
  event: string
  runId: string
  timestamp?: number
  [key: string]: unknown
}

/** approval choice（Hermes 语义） */
export type HermesApprovalChoice = 'once' | 'session' | 'always' | 'deny'

/** 构建 Bearer 认证头（不打印 key） */
export function buildApiServerAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

/** 解析 createRun 响应（202 { run_id }） */
export function parseRunCreated(body: unknown): HermesRunCreated {
  if (!body || typeof body !== 'object') {
    throw new HermesError('远端未返回 run_id', 'invalid-response')
  }
  const runId = (body as { run_id?: unknown }).run_id
  if (typeof runId !== 'string' || !runId) {
    throw new HermesError('远端未返回 run_id', 'invalid-response')
  }
  return { runId }
}

/**
 * API Server Adapter
 */
export class HermesApiServerAdapter {
  constructor(
    private readonly transport: HermesTransport,
    private readonly apiKey: string,
  ) {}

  private authHeaders(): Record<string, string> {
    return buildApiServerAuthHeaders(this.apiKey)
  }

  /** 读取能力（GET /v1/capabilities） */
  async listCapabilities(): Promise<unknown> {
    const response = await this.transport.requestJson('/v1/capabilities', {
      headers: this.authHeaders(),
      timeoutMs: 6_000,
    })
    if (response.status === 401) {
      throw new HermesError('API Server 认证失败，请检查 API Server key', 'unauthorized', 401)
    }
    if (response.status !== 200) {
      throw hermesErrorFromHttpStatus(response.status, '读取 Hermes 能力失败')
    }
    return response.body
  }

  /** 启动 run（POST /v1/runs），立即返回 run_id */
  async createRun(input: HermesRunCreateInput): Promise<HermesRunCreated> {
    const body: Record<string, unknown> = {
      input: input.input,
    }
    if (input.instructions) body.instructions = input.instructions
    if (input.conversationHistory && input.conversationHistory.length > 0) {
      body.conversation_history = input.conversationHistory
    }
    if (input.model) body.model = input.model
    if (input.sessionId) body.session_id = input.sessionId

    const response = await this.transport.requestJson('/v1/runs', {
      method: 'POST',
      headers: this.authHeaders(),
      body,
      timeoutMs: 15_000,
    })
    if (response.status === 401) {
      throw new HermesError('API Server 认证失败，请检查 API Server key', 'unauthorized', 401)
    }
    if (response.status !== 202 && response.status !== 200) {
      throw hermesErrorFromHttpStatus(response.status, '启动 Hermes run 失败')
    }
    return parseRunCreated(response.body)
  }

  /** 获取 run 状态（GET /v1/runs/{run_id}） */
  async getRunStatus(runId: string): Promise<unknown> {
    const response = await this.transport.requestJson(`/v1/runs/${runId}`, {
      headers: this.authHeaders(),
      timeoutMs: 8_000,
    })
    if (response.status !== 200) {
      throw hermesErrorFromHttpStatus(response.status, '读取 run 状态失败')
    }
    return response.body
  }

  /** 订阅 run 事件流（GET /v1/runs/{run_id}/events SSE） */
  openRunEvents(
    runId: string,
    onEvent: (event: HermesRunEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<HermesSseHandle> {
    return this.transport.openSse(`/v1/runs/${runId}/events`, {
      headers: this.authHeaders(),
      signal: options.signal,
      timeoutMs: 0, // 长连接不设总超时
      onEvent: (sseEvent) => {
        try {
          const data = JSON.parse(sseEvent.data) as HermesRunEvent
          // 优先使用服务端事件内的 run_id，缺省时回退到路径参数
          onEvent({ ...data, runId: data.runId ?? runId })
        } catch {
          // 非 JSON 事件（keepalive 注释等）忽略
        }
      },
    })
  }

  /** 响应 approval（POST /v1/runs/{run_id}/approval） */
  async respondApproval(runId: string, choice: HermesApprovalChoice): Promise<unknown> {
    const response = await this.transport.requestJson(`/v1/runs/${runId}/approval`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: { choice },
      timeoutMs: 8_000,
    })
    if (response.status !== 200) {
      throw hermesErrorFromHttpStatus(response.status, '响应 approval 失败')
    }
    return response.body
  }

  /** 中断 run（POST /v1/runs/{run_id}/stop） */
  async stopRun(runId: string): Promise<unknown> {
    const response = await this.transport.requestJson(`/v1/runs/${runId}/stop`, {
      method: 'POST',
      headers: this.authHeaders(),
      timeoutMs: 8_000,
    })
    if (response.status !== 200) {
      throw hermesErrorFromHttpStatus(response.status, '停止 run 失败')
    }
    return response.body
  }

  /** stop ACK 仅表示 stopping；有限轮询到 terminal，超时则显式失败。 */
  async stopRunAndWait(
    runId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<unknown> {
    await this.stopRun(runId)
    const deadline = Date.now() + (options.timeoutMs ?? 8_000)
    while (Date.now() < deadline) {
      const status = await this.getRunStatus(runId)
      const value = status && typeof status === 'object'
        ? String((status as { status?: unknown }).status ?? '')
        : ''
      if (value === 'cancelled' || value === 'completed' || value === 'failed') return status
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 250))
    }
    throw new HermesError('Hermes API run 停止请求已发送，但等待终态超时', 'timeout')
  }
}
