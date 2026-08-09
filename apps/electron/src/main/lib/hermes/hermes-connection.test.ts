import { describe, expect, test } from 'bun:test'
import type { HermesTarget } from '@proma/shared'
import { buildHermesTransport, parseDashboardPasswordSecret } from './hermes-connection'
import { HermesEndpointManager } from './hermes-endpoint-manager'
import type { HermesTransport } from './transport/hermes-transport'

const target: HermesTarget = {
  id: 't1',
  name: 'dual',
  mode: 'direct',
  endpoints: {
    dashboard: { baseUrl: 'https://dashboard.example.com/hermes' },
    apiServer: { baseUrl: 'https://api.example.com:8642/root' },
  },
  auth: {},
  createdAt: 0,
  updatedAt: 0,
}

function fakeTransport(baseUrl: string): HermesTransport {
  return {
    baseUrl,
    requestJson: async () => ({ status: 200, body: {} }),
    openSse: async () => ({ abort: () => undefined, done: Promise.resolve() }),
    connectWebSocket: async () => ({ socket: null, errorCode: null, errorMessage: null }),
    dispose: () => undefined,
  }
}

describe('parseDashboardPasswordSecret', () => {
  test('Given JSON / 纯密码 / 畸形 JSON When 解析 Then 兼容历史格式', () => {
    expect(parseDashboardPasswordSecret('{"username":"admin","password":"p@ss"}')).toEqual({ username: 'admin', password: 'p@ss' })
    expect(parseDashboardPasswordSecret('plain')).toEqual({ username: '', password: 'plain' })
    expect(parseDashboardPasswordSecret('{broken').password).toBe('{broken')
  })
})

describe('buildHermesTransport explicit protocol', () => {
  test('Given Direct 双 URL When 构建 Then Dashboard/API 分别命中正确 origin', async () => {
    const manager = new HermesEndpointManager({ idleTtlMs: 0 })
    const dashboard = await buildHermesTransport(target, 'dashboard', manager)
    const api = await buildHermesTransport(target, 'api-server', manager)
    expect(dashboard.baseUrl).toBe('https://dashboard.example.com/hermes/')
    expect(api.baseUrl).toBe('https://api.example.com:8642/root/')
    dashboard.dispose(); api.dispose()
    await manager.disposeAll()
  })

  test('Given 未配置 API endpoint When 请求 API Then 显式失败不 fallback', async () => {
    const manager = new HermesEndpointManager({ idleTtlMs: 0 })
    const onlyDashboard = { ...target, endpoints: { dashboard: target.endpoints!.dashboard } }
    await expect(buildHermesTransport(onlyDashboard, 'api-server', manager)).rejects.toThrow('未配置 api-server')
    await manager.disposeAll()
  })

  test('Given manager 共享资源 When dispose wrapper Then 只 release lease', async () => {
    let disposed = 0
    const manager = new HermesEndpointManager({
      idleTtlMs: 0,
      build: async () => ({
        dashboard: fakeTransport('https://d/'),
        dispose: async () => { disposed += 1 },
      }),
    })
    const value = await buildHermesTransport(target, 'dashboard', manager)
    value.dispose(); value.dispose()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(disposed).toBe(1)
  })
})
