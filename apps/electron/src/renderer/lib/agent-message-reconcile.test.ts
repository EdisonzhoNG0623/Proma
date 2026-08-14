import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import {
  findLastStableSDKMessageUuid,
  reconcileSDKMessagesAfterBoundary,
  reconcileSDKMessagesWithCanonicalPage,
} from './agent-message-reconcile'

const message = (type: string, uuid?: string, text = type): SDKMessage => ({
  type,
  ...(uuid ? { uuid } : {}),
  message: { content: [{ type: 'text', text }] },
} as unknown as SDKMessage)

describe('Agent canonical tail reconcile', () => {
  test('Given 乐观尾段 When canonical delta 返回 Then 替换边界后内容并保留历史前缀引用', () => {
    const prefix = message('assistant', 'stable-boundary', '旧回复')
    const oldResult = message('result')
    const optimisticUser = message('user', undefined, '乐观问题')
    const canonicalResult = message('result')
    const canonicalUser = message('user', 'canonical-user', '问题')
    const canonicalAssistant = message('assistant', 'canonical-assistant', '回答')

    const previous = [prefix, oldResult, optimisticUser]
    const next = reconcileSDKMessagesAfterBoundary(
      previous,
      'stable-boundary',
      [canonicalResult, canonicalUser, canonicalAssistant],
    )

    expect(next?.[0]).toBe(prefix)
    expect(next).toEqual([prefix, canonicalResult, canonicalUser, canonicalAssistant])
  })

  test('Given 尾部消息无 UUID When 查找边界 Then 返回最近的稳定 UUID', () => {
    expect(findLastStableSDKMessageUuid([
      message('assistant', 'stable'),
      message('result'),
      message('user'),
    ])).toBe('stable')
  })

  test('Given 乐观消息已有临时 UUID When 查找边界 Then 跳过它避免 delta 错误回退 full snapshot', () => {
    expect(findLastStableSDKMessageUuid([
      message('assistant', 'canonical-a'),
      { ...message('user', 'temporary-user-uuid'), _promaOptimistic: true } as SDKMessage,
    ])).toBe('canonical-a')
  })

  test('Given boundary 不在本地缓存 When reconcile Then 返回 null 让调用方 full fallback', () => {
    expect(reconcileSDKMessagesAfterBoundary([message('assistant', 'other')], 'missing', [])).toBeNull()
  })

  test('Given 已加载更早历史 When canonical 末页包含边界 Then 只替换尾段并保留历史前缀', () => {
    const earliest = message('user', 'earliest')
    const boundary = message('assistant', 'boundary')
    const optimistic = { ...message('user', 'optimistic'), _promaOptimistic: true } as SDKMessage
    const canonicalUser = message('user', 'canonical-user')
    const canonicalAssistant = message('assistant', 'canonical-assistant')

    const next = reconcileSDKMessagesWithCanonicalPage(
      [earliest, boundary, optimistic],
      'boundary',
      [message('system', 'page-prefix'), boundary, canonicalUser, canonicalAssistant],
    )

    expect(next?.[0]).toBe(earliest)
    expect(next?.[1]).toBe(boundary)
    expect(next).toEqual([earliest, boundary, canonicalUser, canonicalAssistant])
  })

  test('Given canonical 末页已不含边界 When reconcile Then 返回 null 让调用方采用分页结果', () => {
    expect(reconcileSDKMessagesWithCanonicalPage(
      [message('assistant', 'boundary')],
      'boundary',
      [message('assistant', 'newer-only')],
    )).toBeNull()
  })
})
