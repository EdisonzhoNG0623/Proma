/**
 * Hermes 事件归一化与 SDKMessage 映射
 *
 * 把远端 Hermes 的两种事件形态（Dashboard WS notification / API Server SSE event）
 * 归一化为统一的 HermesTurnEvent，再由有状态映射器转换为 Proma 的 SDKMessage 流。
 *
 * 转换规则：
 * - text.delta / reasoning.delta / tool.started 统一累积到 blocks，事件边界才 flush 为完整 assistant；
 * - tool.completed → tool_progress 心跳消息；
 * - turn.completed → assistant + result(success)；
 * - turn.failed / error → assistant + result(error)。
 */

import type { SDKAssistantMessage, SDKContentBlock, SDKMessage, SDKResultMessage, SDKTextBlock, SDKThinkingBlock, SDKToolProgressMessage } from '@proma/shared'

/** 归一化后的 Hermes turn 事件 */
export type HermesTurnEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'tool.started'; toolUseId: string; toolName: string; input?: Record<string, unknown> }
  | { type: 'tool.completed'; toolUseId: string; toolName: string; output?: unknown }
  | {
      type: 'approval.request'
      requestId: string
      message: string
      toolName?: string
      toolInput?: Record<string, unknown>
    }
  | { type: 'clarify.request'; requestId: string; question: string }
  | { type: 'sudo.request'; requestId: string; message: string }
  | { type: 'secret.request'; requestId: string; message: string }
  | { type: 'turn.completed'; usage?: unknown }
  | { type: 'turn.failed'; error: string }
  | { type: 'error'; message: string }

/** 构建 SDK assistant 消息 */
export function buildAssistantMessage(
  content: SDKContentBlock[],
  options: { sessionId?: string; parentToolUseId?: string | null; model?: string } = {},
): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      content,
      ...(options.model ? { model: options.model } : {}),
    },
    parent_tool_use_id: options.parentToolUseId ?? null,
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
  }
}

/** 构建 SDK result 消息 */
export function buildResultMessage(
  subtype: SDKResultMessage['subtype'],
  options: { sessionId?: string; errors?: string[] } = {},
): SDKResultMessage {
  return {
    type: 'result',
    subtype,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...(options.errors && options.errors.length > 0 ? { errors: options.errors } : {}),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
  }
}

/**
 * 有状态事件映射器。
 *
 * 一个 mapper 实例对应一次远端 turn；push 增量事件，结束（turn.completed/failed）后
 * flush 产出完整 assistant + result。
 */
export class HermesSdkMessageMapper {
  private blocks: SDKContentBlock[] = []
  private ended = false

  constructor(
    private readonly options: { sessionId?: string; model?: string } = {},
  ) {}

  /** 取走当前累积的 blocks 并产出 assistant（无内容时返回 null） */
  private takeAssistant(): SDKAssistantMessage | null {
    if (this.blocks.length === 0) {
      return null
    }
    const content = this.blocks
    this.blocks = []
    return buildAssistantMessage(content, {
      sessionId: this.options.sessionId,
      model: this.options.model,
    })
  }

  private appendText(text: string): void {
    const last = this.blocks[this.blocks.length - 1]
    if (last && last.type === 'text') {
      ;(last as SDKTextBlock).text += text
    } else {
      this.blocks.push({ type: 'text', text })
    }
  }

  private appendThinking(thinking: string): void {
    const last = this.blocks[this.blocks.length - 1]
    if (last && last.type === 'thinking') {
      ;(last as SDKThinkingBlock).thinking += thinking
    } else {
      this.blocks.push({ type: 'thinking', thinking })
    }
  }

  /**
   * 处理一个事件，返回本事件产出的 SDKMessage 列表（可能为空）。
   */
  push(event: HermesTurnEvent): SDKMessage[] {
    if (this.ended) {
      return []
    }
    switch (event.type) {
      case 'text.delta':
        this.appendText(event.text)
        return []
      case 'reasoning.delta':
        this.appendThinking(event.text)
        return []
      case 'tool.started': {
        // 文本与 tool_use 放在同一个 assistant blocks 中（贴近 SDK 消息展示）
        this.blocks.push({
          type: 'tool_use',
          id: event.toolUseId,
          name: event.toolName,
          input: event.input ?? {},
        })
        return []
      }
      case 'tool.completed': {
        const progress: SDKToolProgressMessage = {
          type: 'tool_progress',
          tool_use_id: event.toolUseId,
          tool_name: event.toolName,
          parent_tool_use_id: null,
        }
        return [progress]
      }
      case 'approval.request':
      case 'clarify.request':
      case 'sudo.request':
      case 'secret.request': {
        // 首版把远端交互请求作为宽松透传消息交给上层（Proma 权限体系接入见 P1-4b）
        const messages: SDKMessage[] = []
        const assistant = this.takeAssistant()
        if (assistant) messages.push(assistant)
        const eventType = event.type === 'approval.request' ? 'hermes_approval_request'
          : event.type === 'clarify.request' ? 'hermes_clarify_request'
            : event.type === 'sudo.request' ? 'hermes_sudo_request'
              : 'hermes_secret_request'
        messages.push({
          type: eventType,
          requestId: event.requestId,
          message: 'message' in event ? event.message : 'question' in event ? event.question : '',
          session_id: this.options.sessionId,
          tool_name: 'toolName' in event ? event.toolName : undefined,
          tool_input: 'toolInput' in event ? event.toolInput : undefined,
        } as unknown as SDKMessage)
        return messages
      }
      case 'turn.completed': {
        this.ended = true
        const messages: SDKMessage[] = []
        const assistant = this.takeAssistant()
        if (assistant) messages.push(assistant)
        messages.push(buildResultMessage('success', { sessionId: this.options.sessionId }))
        return messages
      }
      case 'turn.failed':
      case 'error': {
        this.ended = true
        const messages: SDKMessage[] = []
        const assistant = this.takeAssistant()
        if (assistant) messages.push(assistant)
        messages.push(
          buildResultMessage('error_during_execution', {
            sessionId: this.options.sessionId,
            errors: [event.type === 'error' ? event.message : event.error],
          }),
        )
        return messages
      }
    }
  }

  /**
   * 结束映射（无终止事件时兜底，避免消息丢失）。
   */
  flush(): SDKMessage[] {
    if (this.ended) {
      return []
    }
    this.ended = true
    const messages: SDKMessage[] = []
    const assistant = this.takeAssistant()
    if (assistant) messages.push(assistant)
    if (messages.length === 0) {
      return []
    }
    messages.push(buildResultMessage('success', { sessionId: this.options.sessionId }))
    return messages
  }
}
