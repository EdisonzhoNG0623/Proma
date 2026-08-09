import { describe, expect, test } from 'bun:test'
import {
  HermesCookieSessionManager,
  hermesCookiePartition,
  type HermesCookieSession,
} from './hermes-cookie-session'

function fakeSession(): HermesCookieSession & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch: async (input) => {
      calls.push(`fetch:${String(input)}`)
      return new Response('{}', { status: 200 })
    },
    cookies: {
      get: async () => [
        { name: 'a', domain: '.example.com', path: '/', secure: true },
        { name: 'b', domain: 'example.com', path: '/auth', secure: false },
      ],
      remove: async (url, name) => { calls.push(`remove:${url}:${name}`) },
    },
    flushStorageData: async () => { calls.push('flush') },
  }
}

describe('Hermes Cookie partition', () => {
  test('Given target ID When 获取 partition Then 固定且按 target 隔离', () => {
    expect(hermesCookiePartition('target-a')).toBe('persist:proma-hermes-remote-target-a')
    expect(hermesCookiePartition('target-b')).not.toBe(hermesCookiePartition('target-a'))
    expect(() => hermesCookiePartition('../bad')).toThrow('targetId')
  })

  test('Given password-cookie 请求 When fetch Then 使用对应 Electron partition', async () => {
    const sessions = new Map<string, ReturnType<typeof fakeSession>>()
    const manager = new HermesCookieSessionManager((partition) => {
      const value = fakeSession()
      sessions.set(partition, value)
      return value
    })
    await manager.fetch('target-a', 'https://example.com/auth/password-login', { method: 'POST' })
    expect(sessions.get('persist:proma-hermes-remote-target-a')?.calls).toEqual([
      'fetch:https://example.com/auth/password-login',
    ])
  })

  test('Given partition 有多个 Cookie When clear Then 全部移除并 flush', async () => {
    const value = fakeSession()
    const manager = new HermesCookieSessionManager(() => value)
    await manager.clear('target-a')
    expect(value.calls).toContain('remove:https://example.com/:a')
    expect(value.calls).toContain('remove:http://example.com/auth:b')
    expect(value.calls.at(-1)).toBe('flush')
  })
})
