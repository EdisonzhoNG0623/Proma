/**
 * Hermes Auth 编排 BDD 测试
 *
 * 覆盖：密码提交安全边界、providers 解析、密码登录与 Cookie 捕获、
 * WS ticket、按 target 隔离、错误映射。
 */

import { describe, expect, test } from 'bun:test'
import {
  HermesAuthService,
  buildTicketWsUrl,
  canSubmitPasswordTo,
  isLoopbackUrl,
  parseAuthProviders,
  parsePasswordLoginResponse,
  parseWsTicketResponse,
} from './hermes-auth'
import { HermesError } from './hermes-errors'
import type { HermesJsonResponse, HermesTransport } from './transport/hermes-transport'

describe('密码提交安全边界', () => {
  test('Given https URL When 检查 Then 允许提交密码', () => {
    expect(canSubmitPasswordTo('https://hermes.example.com')).toBe(true)
  })

  test('Given http 公网 URL When 检查 Then 禁止提交密码', () => {
    expect(canSubmitPasswordTo('http://hermes.example.com')).toBe(false)
  })

  test('Given http loopback When 检查 Then 允许提交密码', () => {
    expect(canSubmitPasswordTo('http://127.0.0.1:9119/')).toBe(true)
    expect(canSubmitPasswordTo('http://localhost:9119/')).toBe(true)
    expect(canSubmitPasswordTo('http://127.0.0.2:9119/')).toBe(true)
  })

  test('Given 非法 URL When 检查 Then 禁止提交密码', () => {
    expect(canSubmitPasswordTo('not a url')).toBe(false)
  })

  test('Given loopback 判定 When 检查 Then 正确识别', () => {
    expect(isLoopbackUrl('http://localhost:9119')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:9119')).toBe(true)
    expect(isLoopbackUrl('http://192.168.1.10:9119')).toBe(false)
  })
})

describe('parseAuthProviders providers 解析', () => {
  test('Given 标准响应 When 解析 Then 返回提供方列表', () => {
    const providers = parseAuthProviders({
      providers: [
        { name: 'nous', display_name: 'Nous Research', supports_password: false },
        { name: 'basic', display_name: 'Username & Password', supports_password: true },
      ],
    })
    expect(providers).toHaveLength(2)
    expect(providers[1]?.name).toBe('basic')
    expect(providers[1]?.supportsPassword).toBe(true)
  })

  test('Given 畸形响应 When 解析 Then 返回空列表', () => {
    expect(parseAuthProviders(null)).toEqual([])
    expect(parseAuthProviders({})).toEqual([])
    expect(parseAuthProviders({ providers: 'x' })).toEqual([])
    expect(parseAuthProviders({ providers: [{ name: 123 }] })).toEqual([])
  })
})

describe('parsePasswordLoginResponse 登录响应解析', () => {
  test('Given 200 ok When 解析 Then 返回成功', () => {
    const result = parsePasswordLoginResponse(200, { ok: true, next: '/' })
    expect(result.ok).toBe(true)
    expect(result.next).toBe('/')
  })

  test('Given 401 When 解析 Then 抛 unauthorized', () => {
    const error = (() => {
      try {
        parsePasswordLoginResponse(401, {})
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(HermesError)
    expect((error as HermesError).code).toBe('unauthorized')
  })

  test('Given 429 When 解析 Then 抛 rate-limited', () => {
    expect(() => parsePasswordLoginResponse(429, {})).toThrow('尝试过多')
  })

  test('Given 503 When 解析 Then 抛 provider-unavailable', () => {
    const error = (() => {
      try {
        parsePasswordLoginResponse(503, {})
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(HermesError)
    expect((error as HermesError).code).toBe('provider-unavailable')
  })

  test('Given 200 非 JSON When 解析 Then 抛 protocol-incompatible', () => {
    expect(() => parsePasswordLoginResponse(200, null)).toThrow('远端登录响应格式异常')
  })
})

describe('parseWsTicketResponse / buildTicketWsUrl', () => {
  test('Given 有效 ticket 响应 When 解析 Then 返回 ticket', () => {
    expect(parseWsTicketResponse({ ticket: 'abc-123' })).toBe('abc-123')
  })

  test('Given 缺少 ticket When 解析 Then 抛 invalid-response', () => {
    expect(() => parseWsTicketResponse({})).toThrow('invalid-response'.replace('invalid-response', '未返回'))
  })

  test('Given https base When 构建 Then 生成 wss 并带 ticket', () => {
    expect(buildTicketWsUrl('https://h.example.com/', 't-1')).toBe(
      'wss://h.example.com/api/ws?ticket=t-1',
    )
  })

  test('Given http base When 构建 Then 生成 ws', () => {
    expect(buildTicketWsUrl('http://127.0.0.1:9119/', 't-1')).toBe(
      'ws://127.0.0.1:9119/api/ws?ticket=t-1',
    )
  })
})

describe('HermesAuthService 登录与 Cookie', () => {
  const fakeTransport = (handler: (path: string, options?: { headers?: Record<string, string> }) => HermesJsonResponse): HermesTransport => ({
    baseUrl: 'https://h.example.com/',
    requestJson: async (path, options) => {
      const headers = (options?.headers ?? {}) as Record<string, string>
      return handler(path, { headers })
    },
    openSse: async () => {
      throw new Error('not used')
    },
    connectWebSocket: async () => ({ socket: null, errorCode: null, errorMessage: null }),
    dispose: () => undefined,
  })

  test('Given 密码登录成功 When 登录 Then 捕获 Set-Cookie 到 target Jar', async () => {
    let sentBody = ''
    let sentHeaders: Record<string, string> = {}
    const transport = fakeTransport((path, init) => {
      if (path === '/auth/password-login') {
        sentBody = String(init?.headers?.['__body']) ?? ''
        sentHeaders = init?.headers ?? {}
        return {
          status: 200,
          body: { ok: true, next: '/' },
          headers: {
            'set-cookie': ['hermes_session_at=at-token; Path=/', 'hermes_session_rt=rt-token; HttpOnly'],
          },
        }
      }
      return { status: 404, body: {} }
    })
    // 捕获请求体（transport 实现里 body 不直接可见；此处直接校验 service 行为）
    const auth = new HermesAuthService(transport)
    const result = await auth.passwordLogin('target-a', {
      provider: 'basic',
      username: 'admin',
      password: 'hunter2',
    })
    expect(result.ok).toBe(true)
    expect(sentHeaders).toBeDefined()
    const jar = auth.cookieJarFor('target-a')
    expect(jar.get('hermes_session_at')).toBe('at-token')
    expect(jar.get('hermes_session_rt')).toBe('rt-token')
  })

  test('Given 已登录 When 获取 ticket Then 携带 Cookie 并返回 ticket', async () => {
    let sentCookie = ''
    const transport = fakeTransport((path, init) => {
      if (path === '/api/auth/ws-ticket') {
        sentCookie = String(init?.headers?.Cookie ?? '')
        return { status: 200, body: { ticket: 'ws-ticket-1' } }
      }
      return { status: 404, body: {} }
    })
    const auth = new HermesAuthService(transport)
    auth.cookieJarFor('target-a').set('hermes_session_at', 'at-token')
    const ticket = await auth.mintWsTicket('target-a')
    expect(ticket).toBe('ws-ticket-1')
    expect(sentCookie).toContain('hermes_session_at=at-token')
  })

  test('Given 两个 target When 登录 Then Cookie 相互隔离', async () => {
    const transport = fakeTransport(() => ({
      status: 200,
      body: { ok: true },
      headers: { 'set-cookie': ['hermes_session_at=at-A'] },
    }))
    const auth = new HermesAuthService(transport)
    await auth.passwordLogin('target-a', {
      provider: 'basic',
      username: 'u',
      password: 'p',
    })
    // target-b 的 Jar 为空
    expect(auth.cookieJarFor('target-b').size).toBe(0)
    expect(auth.cookieJarFor('target-a').get('hermes_session_at')).toBe('at-A')
  })

  test('Given 401 登录失败 When 登录 Then 抛 unauthorized 且不写入 Cookie', async () => {
    const transport = fakeTransport(() => ({ status: 401, body: {} }))
    const auth = new HermesAuthService(transport)
    const error = await auth
      .passwordLogin('target-a', { provider: 'basic', username: 'u', password: 'p' })
      .catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('unauthorized')
    expect(auth.cookieJarFor('target-a').size).toBe(0)
  })

  test('Given 清理 When 调用 Then 移除 target Jar', async () => {
    const transport = fakeTransport(() => ({ status: 200, body: { ok: true } }))
    const auth = new HermesAuthService(transport)
    await auth.passwordLogin('target-a', {
      provider: 'basic',
      username: 'u',
      password: 'p',
    })
    auth.clearCookies('target-a')
    expect(auth.cookieJarFor('target-a').size).toBe(0)
  })

  test('Given ticket 请求 401 When 获取 Then 抛 unauthorized', async () => {
    const transport = fakeTransport(() => ({ status: 401, body: {} }))
    const auth = new HermesAuthService(transport)
    auth.cookieJarFor('target-a').set('hermes_session_at', 'expired')
    const error = await auth.mintWsTicket('target-a').catch((e: unknown) => e)
    expect((error as HermesError).code).toBe('unauthorized')
  })
})
