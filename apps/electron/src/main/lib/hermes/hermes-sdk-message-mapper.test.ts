/**
 * Hermes 事件 → SDKMessage 映射器 BDD 测试
 */

import { describe, expect, test } from 'bun:test'
import {
  HermesSdkMessageMapper,
  buildAssistantMessage,
  buildResultMessage,
  type HermesTurnEvent,
} from './hermes-sdk-message-mapper'
import type { SDKMessage } from '@proma/shared'

describe('HermesSdkMessageMapper 文本累积', () => {
  test('Given 多个 text.delta When 处理 Then 产出 partial 流式消息，turn.completed 产出完整 assistant', () => {
    const mapper = new HermesSdkMessageMapper({ sessionId: 's1' })
    const out: SDKMessage[] = []
    out.push(...mapper.push({ type: 'text.delta', text: '你' }))
    out.push(...mapper.push({ type: 'text.delta', text: '好' }))
    // 流式：每个 text.delta 产出同 uuid 的 partial 消息
    expect(out).toHaveLength(2)
    expect((out[0] as { _partial?: boolean })._partial).toBe(true)
    expect((out[1] as { _partial?: boolean })._partial).toBe(true)
    const p0 = out[0] as { message: { content: Array<{ type: string; text?: string }> } }
    const p1 = out[1] as { message: { content: Array<{ type: string; text?: string }> } }
    expect(p0.message.content[0]?.text).toBe('你')
    expect(p1.message.content[0]?.text).toBe('你好')
    const finalOut = mapper.push({ type: 'turn.completed' })
    expect(finalOut).toHaveLength(2)
    expect(finalOut[0]?.type).toBe('assistant')
    const assistant = finalOut[0] as { message: { content: Array<{ type: string; text?: string }> }; _partial?: boolean }
    expect(assistant._partial).toBeUndefined()
    expect(assistant.message.content[0]?.text).toBe('你好')
    expect(finalOut[1]?.type).toBe('result')
  })

  test('Given 无文本 When turn.completed Then 只产出 result', () => {
    const mapper = new HermesSdkMessageMapper()
    const out = mapper.push({ type: 'turn.completed' })
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('result')
  })

  test('Given flush 兜底 When 未收到终止事件 Then 产出 assistant + result', () => {
    const mapper = new HermesSdkMessageMapper()
    mapper.push({ type: 'text.delta', text: 'hi' })
    const out = mapper.flush()
    expect(out).toHaveLength(2)
  })
})

describe('HermesSdkMessageMapper 工具事件', () => {
  test('Given tool.started When 处理 Then 与文本同块累积，turn.completed 时产出', () => {
    const mapper = new HermesSdkMessageMapper()
    mapper.push({ type: 'text.delta', text: '我来执行' })
    const startedOut = mapper.push({
      type: 'tool.started',
      toolUseId: 't1',
      toolName: 'Bash',
      input: { command: 'ls' },
    })
    // 工具边界 flush 当前文本为完整 assistant（结束 partial 流）
    expect(startedOut).toHaveLength(1)
    expect(startedOut[0]?.type).toBe('assistant')
    expect((startedOut[0] as { _partial?: boolean })._partial).toBeUndefined()
    const flushed = startedOut[0] as { message: { content: Array<{ type: string; text?: string }> } }
    expect(flushed.message.content[0]?.text).toBe('我来执行')
    const out = mapper.push({ type: 'turn.completed' })
    expect(out[0]?.type).toBe('assistant')
    const assistant = out[0] as { message: { content: Array<{ type: string; text?: string; name?: string; id?: string }> } }
    const blocks = assistant.message.content
    expect(blocks[0]?.type).toBe('tool_use')
    expect(blocks[0]?.name).toBe('Bash')
    expect(blocks[0]?.id).toBe('t1')
  })

  test('Given tool.completed When 处理 Then 产出 tool_progress', () => {
    const mapper = new HermesSdkMessageMapper()
    const out = mapper.push({
      type: 'tool.completed',
      toolUseId: 't1',
      toolName: 'Bash',
      output: 'ok',
    })
    expect(out[0]?.type).toBe('tool_progress')
    expect((out[0] as { tool_use_id: string }).tool_use_id).toBe('t1')
  })
})

describe('HermesSdkMessageMapper 交互请求', () => {
  test('Given approval.request When 处理 Then 产出宽松透传消息', () => {
    const mapper = new HermesSdkMessageMapper({ sessionId: 's1' })
    const out = mapper.push({
      type: 'approval.request',
      requestId: 'r1',
      message: '允许执行 rm -rf?',
      toolName: 'Bash',
    })
    const msg = out[0] as { type: string; requestId: string; message: string; tool_name?: string }
    expect(msg.type).toBe('hermes_approval_request')
    expect(msg.requestId).toBe('r1')
    expect(msg.tool_name).toBe('Bash')
  })

  test('Given clarify.request When 处理 Then 产出 clarify 透传消息', () => {
    const mapper = new HermesSdkMessageMapper()
    const out = mapper.push({ type: 'clarify.request', requestId: 'c1', question: '选哪个?' })
    expect((out[0] as { type: string }).type).toBe('hermes_clarify_request')
  })
})

describe('HermesSdkMessageMapper 结束与错误', () => {
  test('Given turn.failed When 处理 Then 产出 assistant + error result', () => {
    const mapper = new HermesSdkMessageMapper()
    mapper.push({ type: 'text.delta', text: '出错了' })
    const out = mapper.push({ type: 'turn.failed', error: '远端崩溃' })
    expect(out[0]?.type).toBe('assistant')
    const result = out[1] as { type: string; subtype: string; errors?: string[] }
    expect(result.type).toBe('result')
    expect(result.subtype).toBe('error_during_execution')
    expect(result.errors).toEqual(['远端崩溃'])
  })

  test('Given error 事件 When 处理 Then 同样产出 error result', () => {
    const mapper = new HermesSdkMessageMapper()
    const out = mapper.push({ type: 'error', message: '连接断开' })
    const result = out[out.length - 1] as { type: string; errors?: string[] }
    expect(result.type).toBe('result')
    expect(result.errors).toEqual(['连接断开'])
  })
})

describe('HermesSdkMessageMapper 辅助构建', () => {
  test('Given buildAssistantMessage When 调用 Then 结构正确', () => {
    const msg = buildAssistantMessage([{ type: 'text', text: 'x' }], { sessionId: 's' })
    expect(msg.type).toBe('assistant')
    expect(msg.session_id).toBe('s')
    expect(msg.parent_tool_use_id).toBeNull()
  })

  test('Given buildResultMessage When 调用 Then 结构正确', () => {
    const msg = buildResultMessage('success', { sessionId: 's' })
    expect(msg.type).toBe('result')
    expect(msg.subtype).toBe('success')
  })
})
