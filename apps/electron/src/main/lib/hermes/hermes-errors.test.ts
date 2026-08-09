/**
 * Hermes 类型化错误 BDD 测试
 *
 * 覆盖：错误码映射、needsAuth 标记、消息脱敏、诊断模型。
 */

import { describe, expect, test } from 'bun:test'
import {
  HermesError,
  hermesErrorFromHttpStatus,
  redactSecrets,
} from './hermes-errors'

describe('HermesError 错误码映射', () => {
  test('Given 401 When 映射 Then unauthorized 且 needsAuth 为 true', () => {
    const error = hermesErrorFromHttpStatus(401, 'fallback')
    expect(error.code).toBe('unauthorized')
    expect(error.needsAuth).toBe(true)
    expect(error.statusCode).toBe(401)
  })

  test('Given 429 When 映射 Then rate-limited', () => {
    expect(hermesErrorFromHttpStatus(429, 'f').code).toBe('rate-limited')
  })

  test('Given 503 When 映射 Then provider-unavailable', () => {
    expect(hermesErrorFromHttpStatus(503, 'f').code).toBe('provider-unavailable')
  })

  test('Given 404 When 映射 Then service-not-found 且使用 fallback 消息', () => {
    const error = hermesErrorFromHttpStatus(404, '找不到服务')
    expect(error.code).toBe('service-not-found')
    expect(error.message).toContain('找不到服务')
  })

  test('Given 500 When 映射 Then provider-unavailable', () => {
    expect(hermesErrorFromHttpStatus(500, 'f').code).toBe('provider-unavailable')
  })

  test('Given 403 When 映射 Then network（非 5xx 默认）', () => {
    expect(hermesErrorFromHttpStatus(403, 'f').code).toBe('network')
  })

  test('Given 手动构造 When 使用 Then 保留 code 与 statusCode', () => {
    const error = new HermesError('TLS 校验失败', 'tls', 0)
    expect(error.code).toBe('tls')
    expect(error.message).toBe('TLS 校验失败')
  })
})

describe('redactSecrets 消息脱敏', () => {
  test('Given Authorization 头 When 脱敏 Then 替换为 [REDACTED]', () => {
    const message = '请求失败: Authorization: Bearer sk-abc123def456'
    expect(redactSecrets(message)).toContain('Authorization: [REDACTED]')
    expect(redactSecrets(message)).not.toContain('sk-abc123def456')
  })

  test('Given Cookie 头 When 脱敏 Then 替换 session token', () => {
    const message = 'Cookie: hermes_session_at=abc123tokenvalue; path=/'
    const redacted = redactSecrets(message)
    expect(redacted).not.toContain('abc123tokenvalue')
  })

  test('Given URL userinfo When 脱敏 Then 隐藏凭据', () => {
    const message = 'https://admin:secret@hermes.example.com/api'
    const redacted = redactSecrets(message)
    expect(redacted).not.toContain('admin:secret')
    expect(redacted).toContain('[REDACTED]@')
  })

  test('Given sk- 风格 key When 脱敏 Then 隐藏', () => {
    const message = 'key: sk-live-0123456789abcdef'
    const redacted = redactSecrets(message)
    expect(redacted).not.toContain('sk-live-0123456789abcdef')
  })

  test('Given 查询参数 token When 脱敏 Then 隐藏', () => {
    const message = '/api/ws?ticket=longticketvalue12345'
    const redacted = redactSecrets(message)
    expect(redacted).not.toContain('longticketvalue12345')
  })

  test('Given 长随机 token When 脱敏 Then 隐藏', () => {
    const message = '连接 ticket=abcdefghijklmnopqrstuvwxyz123456'
    expect(redactSecrets(message)).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
  })

  test('Given 普通路径 When 脱敏 Then 不误伤短标识', () => {
    const message = 'GET /api/status 返回 200'
    expect(redactSecrets(message)).toBe(message)
  })
})
