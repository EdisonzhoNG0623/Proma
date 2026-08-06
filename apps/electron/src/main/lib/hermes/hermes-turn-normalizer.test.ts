/**
 * Hermes 事件归一化 BDD 测试
 */

import { describe, expect, test } from 'bun:test'
import { normalizeApiServerEvent, normalizeDashboardNotification } from './hermes-turn-normalizer'

describe('normalizeDashboardNotification Dashboard 通知归一化', () => {
  test('Given message.delta When 归一化 Then text.delta', () => {
    const event = normalizeDashboardNotification('message.delta', { text: '你好' })
    expect(event).toEqual({ type: 'text.delta', text: '你好' })
  })

  test('Given message.delta 用 delta 字段 When 归一化 Then text.delta', () => {
    const event = normalizeDashboardNotification('message.delta', { delta: 'hi' })
    expect(event).toEqual({ type: 'text.delta', text: 'hi' })
  })

  test('Given thinking.delta When 归一化 Then reasoning.delta', () => {
    const event = normalizeDashboardNotification('thinking.delta', { text: '思考中' })
    expect(event).toEqual({ type: 'reasoning.delta', text: '思考中' })
  })

  test('Given tool.start When 归一化 Then tool.started 带 id 与 name', () => {
    const event = normalizeDashboardNotification('tool.start', {
      tool_use_id: 't1',
      tool_name: 'Bash',
      input: { command: 'ls' },
    })
    expect(event).toEqual({
      type: 'tool.started',
      toolUseId: 't1',
      toolName: 'Bash',
      input: { command: 'ls' },
    })
  })

  test('Given tool.completed When 归一化 Then tool.completed', () => {
    const event = normalizeDashboardNotification('tool.completed', {
      tool_use_id: 't1',
      tool_name: 'Bash',
    })
    expect(event?.type).toBe('tool.completed')
  })

  test('Given approval.request When 归一化 Then approval.request', () => {
    const event = normalizeDashboardNotification('approval.request', {
      request_id: 'r1',
      message: '允许?',
      tool_name: 'Bash',
    })
    expect(event).toMatchObject({ type: 'approval.request', requestId: 'r1', toolName: 'Bash' })
  })

  test('Given clarify.request When 归一化 Then clarify.request', () => {
    const event = normalizeDashboardNotification('clarify.request', {
      request_id: 'c1',
      question: '选哪个?',
    })
    expect(event).toMatchObject({ type: 'clarify.request', requestId: 'c1', question: '选哪个?' })
  })

  test('Given error When 归一化 Then error', () => {
    const event = normalizeDashboardNotification('error', { message: 'boom' })
    expect(event).toEqual({ type: 'error', message: 'boom' })
  })

  test('Given 未知 method When 归一化 Then null', () => {
    expect(normalizeDashboardNotification('heartbeat', {})).toBeNull()
  })

  test('Given message.delta 空文本 When 归一化 Then null', () => {
    expect(normalizeDashboardNotification('message.delta', {})).toBeNull()
  })
})

describe('normalizeApiServerEvent API SSE 归一化', () => {
  test('Given event 字段 When 归一化 Then 复用 notification 逻辑', () => {
    const event = normalizeApiServerEvent({ event: 'message.delta', delta: 'hi' })
    expect(event).toEqual({ type: 'text.delta', text: 'hi' })
  })

  test('Given tool.started 事件 When 归一化 Then tool.started', () => {
    const event = normalizeApiServerEvent({
      event: 'tool.started',
      tool_use_id: 't1',
      tool_name: 'Bash',
    })
    expect(event?.type).toBe('tool.started')
  })

  test('Given 无 event 字段 When 归一化 Then null', () => {
    expect(normalizeApiServerEvent({ foo: 'bar' })).toBeNull()
  })

  test('Given 非对象 When 归一化 Then null', () => {
    expect(normalizeApiServerEvent('string' as unknown as Record<string, unknown>)).toBeNull()
  })
})
