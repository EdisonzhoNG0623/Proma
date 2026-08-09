import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SDKToolResultBlock } from '@proma/shared'
import { buildSDKMessageLookupIndex } from './ContentBlock'

describe('SDKMessage tool lookup index', () => {
  test('Given 大量历史消息 When 建立索引 Then 工具结果和子 Agent 元数据均按 ID O(1) 查询', () => {
    const filler = Array.from({ length: 10_000 }, (_, index) => ({
      type: 'assistant',
      uuid: `assistant-${index}`,
      message: { content: [{ type: 'text', text: String(index) }] },
    } as unknown as SDKMessage))
    const resultBlock: SDKToolResultBlock = { type: 'tool_result', tool_use_id: 'tool-1', content: 'done', is_error: false }
    const messages: SDKMessage[] = [
      ...filler,
      { type: 'user', message: { content: [resultBlock] } } as unknown as SDKMessage,
      {
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: 'tool-1',
        usage: { duration_ms: 123, total_tokens: 456, tool_uses: 7 },
      } as unknown as SDKMessage,
    ]

    const index = buildSDKMessageLookupIndex(messages)

    expect(index.toolResults.get('tool-1')).toBe(resultBlock)
    expect(index.subAgentMeta.get('tool-1')).toEqual({ durationMs: 123, totalTokens: 456, toolUses: 7 })
    expect(index.toolResults.size).toBe(1)
  })
})
