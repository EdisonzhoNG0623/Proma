/**
 * Hermes 事件归一化
 *
 * 把两种远端事件形态归一化为统一的 HermesTurnEvent：
 * - Dashboard WS notification：{ method, params }
 * - API Server SSE event：{ event, ...data }
 *
 * 字段解析采用宽容策略（尝试常见字段名），保证协议演进时首版不崩溃。
 */

import type { HermesTurnEvent } from './hermes-sdk-message-mapper'

/** 从对象中取第一个存在的字符串字段 */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value) {
      return value
    }
  }
  return undefined
}

function pickObject(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (value && typeof value === 'object') {
      return value as Record<string, unknown>
    }
  }
  return undefined
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'number') {
      return value
    }
  }
  return undefined
}

/**
 * 归一化 Dashboard WS notification。
 *
 * 兼容两种格式：
 * 1. 真实 Hermes：method="event"，params={ type, session_id, payload }（事件类型在 params.type）
 * 2. mock/旧格式：method="message.delta"，params={ text }（method 即事件名）
 *
 * @returns 事件；无法识别时返回 null（调用方忽略并记录）
 */
export function normalizeDashboardNotification(
  method: string,
  rawParams: unknown,
): HermesTurnEvent | null {
  // 真实 Hermes 格式：method='event'，事件类型在 params.type，数据在 params.payload
  let eventName = method
  let eventPayload: unknown = rawParams
  if (method === 'event' && rawParams && typeof rawParams === 'object') {
    const inner = rawParams as { type?: unknown; payload?: unknown }
    if (typeof inner.type === 'string' && inner.type) {
      eventName = inner.type
      eventPayload = inner.payload ?? {}
    }
  }

  const params = eventPayload && typeof eventPayload === 'object'
    ? (eventPayload as Record<string, unknown>)
    : {}

  switch (eventName) {
    case 'message.start':
      // 单条消息开始（无内容载荷），忽略
      return null
    case 'message.delta': {
      const text = pickString(params, ['text', 'delta', 'content'])
      return text ? { type: 'text.delta', text } : null
    }
    case 'message.complete': {
      // Hermes Desktop 语义：assistant 消息完成即 turn 结束
      const status = pickString(params, ['status', 'state'])
      if (status === 'error' || status === 'failed') {
        return {
          type: 'turn.failed',
          error: pickString(params, ['text', 'error', 'message']) ?? '远端消息失败',
        }
      }
      return { type: 'turn.completed' }
    }
    case 'thinking.delta': {
      const text = pickString(params, ['text', 'delta'])
      return text ? { type: 'reasoning.delta', text } : null
    }
    case 'reasoning.delta': {
      const text = pickString(params, ['text', 'delta'])
      return text ? { type: 'reasoning.delta', text } : null
    }
    case 'tool.start':
    case 'tool.started':
    case 'tool.generating': {
      const toolUseId = pickString(params, ['tool_use_id', 'toolUseId', 'id']) ?? `tool-${Date.now()}`
      const toolName = pickString(params, ['tool_name', 'toolName', 'name']) ?? 'unknown'
      return {
        type: 'tool.started',
        toolUseId,
        toolName,
        input: pickObject(params, ['input', 'tool_input']) ?? {},
      }
    }
    case 'tool.complete':
    case 'tool.completed': {
      const toolUseId = pickString(params, ['tool_use_id', 'toolUseId', 'id']) ?? `tool-${Date.now()}`
      const toolName = pickString(params, ['tool_name', 'toolName', 'name']) ?? 'unknown'
      return { type: 'tool.completed', toolUseId, toolName, output: params.output }
    }
    case 'approval.request': {
      return {
        type: 'approval.request',
        requestId: pickString(params, ['request_id', 'requestId', 'approval_id']) ?? `appr-${Date.now()}`,
        message: pickString(params, ['message', 'prompt', 'description']) ?? '远端请求批准',
        toolName: pickString(params, ['tool_name', 'toolName']),
        toolInput: pickObject(params, ['tool_input', 'input']),
      }
    }
    case 'clarify.request': {
      const question = pickString(params, ['question', 'prompt', 'message']) ?? '远端提出问题'
      console.log('[Hermes] 收到 clarify.request:', question)
      return {
        type: 'clarify.request',
        requestId: pickString(params, ['request_id', 'requestId']) ?? `clar-${Date.now()}`,
        question,
      }
    }
    case 'sudo.request': {
      return {
        type: 'sudo.request',
        requestId: pickString(params, ['request_id', 'requestId']) ?? `sudo-${Date.now()}`,
        message: pickString(params, ['message', 'prompt']) ?? '远端请求 sudo 密码',
      }
    }
    case 'secret.request': {
      return {
        type: 'secret.request',
        requestId: pickString(params, ['request_id', 'requestId']) ?? `sec-${Date.now()}`,
        message: pickString(params, ['message', 'prompt']) ?? '远端请求密钥',
      }
    }
    case 'error':
      return { type: 'error', message: pickString(params, ['message', 'error']) ?? '远端错误' }
    case 'turn.completed':
    case 'run.completed':
      return { type: 'turn.completed' }
    case 'turn.failed':
    case 'run.failed':
      return {
        type: 'turn.failed',
        error: pickString(params, ['error', 'message']) ?? '远端 run 失败',
      }
    case 'run.cancelled':
      // 取消视为正常结束（上层通过 abort 感知中断）
      return { type: 'turn.completed' }
    case 'session.info': {
      const status = pickString(params, ['status', 'state'])
      // 透传远端 Hermes 实际模型（session.info 带 model），供消息头像/模型显示
      const model = pickString(params, ['model'])
      if (status === 'complete' || status === 'ended' || status === 'idle') {
        return model ? { type: 'session.info', model, status } : { type: 'turn.completed' }
      }
      return model ? { type: 'session.info', model, status } : null
    }
    default:
      return null
  }
}

/**
 * 归一化 API Server SSE 事件。
 */
export function normalizeApiServerEvent(event: HermesTurnEvent | Record<string, unknown>): HermesTurnEvent | null {
  if (!event || typeof event !== 'object') {
    return null
  }
  const name = pickString(event as Record<string, unknown>, ['event', 'type'])
  if (!name) {
    return null
  }
  return normalizeDashboardNotification(name, event)
}

/** Dashboard 通知中的 usage 字段归一化（预留：后续 token 统计） */
export function pickUsage(obj: Record<string, unknown>): { inputTokens?: number; outputTokens?: number } | undefined {
  const usage = pickObject(obj, ['usage'])
  if (!usage) return undefined
  return {
    inputTokens: pickNumber(usage, ['input_tokens', 'inputTokens']),
    outputTokens: pickNumber(usage, ['output_tokens', 'outputTokens']),
  }
}
