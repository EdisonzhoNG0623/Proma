/**
 * Hermes 连接工厂 BDD 测试
 */

import { describe, expect, test } from 'bun:test'
import {
  buildHermesTransport,
  parseDashboardPasswordSecret,
} from './hermes-connection'
import { HermesSshTunnelManager } from './transport/hermes-ssh-tunnel'
import type { HermesTarget } from '@proma/shared'

const baseTarget = (overrides: Partial<HermesTarget> = {}): HermesTarget => ({
  id: 't1',
  name: 't',
  mode: 'direct',
  remoteUrl: 'https://h.example.com/',
  auth: {},
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe('parseDashboardPasswordSecret 密码凭据解析', () => {
  test('Given JSON 格式 When 解析 Then 返回 username/password', () => {
    const result = parseDashboardPasswordSecret('{"username":"admin","password":"p@ss"}')
    expect(result.username).toBe('admin')
    expect(result.password).toBe('p@ss')
  })

  test('Given 纯密码 When 解析 Then username 为空', () => {
    const result = parseDashboardPasswordSecret('just-a-password')
    expect(result.username).toBe('')
    expect(result.password).toBe('just-a-password')
  })

  test('Given 畸形 JSON When 解析 Then 回退纯密码', () => {
    const result = parseDashboardPasswordSecret('{broken')
    expect(result.password).toBe('{broken')
  })
})

describe('buildHermesTransport transport 构建', () => {
  test('Given direct target When 构建 Then 返回 DirectTransport', async () => {
    const transport = await buildHermesTransport(baseTarget())
    expect(transport.baseUrl).toBe('https://h.example.com/')
    transport.dispose()
  })

  test('Given direct 缺少 URL When 构建 Then 抛错', async () => {
    await expect(buildHermesTransport(baseTarget({ remoteUrl: undefined }))).rejects.toThrow(
      '缺少远端 URL',
    )
  })

  test('Given ssh-tunnel 缺少配置 When 构建 Then 抛错', async () => {
    await expect(
      buildHermesTransport(baseTarget({ mode: 'ssh-tunnel', ssh: undefined })),
    ).rejects.toThrow('缺少 SSH 配置')
  })

  test('Given ssh-tunnel When 构建 Then 打开隧道并返回本地 transport', async () => {
    const manager = new HermesSshTunnelManager({
      // mock：不真正 spawn，但 findFreePort 返回可监听端口模拟就绪
      spawnImpl: () => ({
        pid: 999,
        on: () => undefined,
        kill: () => true,
      }),
      findFreePort: async () => {
        // 返回一个动态端口；此处用静态值但马上监听以通过就绪探测
        return 59991
      },
      knownHostsPath: '/tmp/kh',
    })
    // 预监听 59991 模拟隧道转发
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(59991, '127.0.0.1', () => resolve()))
    try {
      const transport = await buildHermesTransport(
        baseTarget({
          mode: 'ssh-tunnel',
          ssh: { host: 'vps.example.com', port: 22, username: 'deploy' },
        }),
        manager,
      )
      expect(transport.baseUrl).toBe('http://127.0.0.1:59991/')
      transport.dispose()
    } finally {
      server.close()
    }
  })
})
