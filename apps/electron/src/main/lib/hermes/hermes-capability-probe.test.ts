/**
 * Hermes 能力探测 BDD 测试
 *
 * 覆盖：Dashboard / API Server 探测、服务分类、密码 provider 探测、协议不兼容。
 */

import { describe, expect, test } from 'bun:test'
import {
  classifyHermesService,
  probeApiServer,
  probeDashboard,
  probeHermesCapabilities,
  type ApiServerProbeResult,
  type DashboardProbeResult,
} from './hermes-capability-probe'
import type { HermesJsonResponse, HermesTransport } from './transport/hermes-transport'
import { HermesError } from './hermes-errors'

/** 构造 fake transport */
const fakeTransport = (handler: (path: string) => HermesJsonResponse | Promise<HermesJsonResponse> | Error): HermesTransport => ({
  baseUrl: 'https://h.example.com/',
  requestJson: async (path) => {
    const result = handler(path)
    if (result instanceof Error) throw result
    return result
  },
  openSse: async () => {
    throw new Error('not used')
  },
  connectWebSocket: async () => ({ socket: null, errorCode: null, errorMessage: null }),
  dispose: () => undefined,
})

const dashOk = (overrides: Partial<DashboardProbeResult> = {}): DashboardProbeResult => ({
  available: true,
  authRequired: false,
  authFlows: [],
  supportsPassword: false,
  version: '0.20.0',
  protocolIncompatible: false,
  ...overrides,
})

const apiOk = (overrides: Partial<ApiServerProbeResult> = {}): ApiServerProbeResult => ({
  available: true,
  authRequired: false,
  endpoints: ['/v1/runs', '/v1/chat/completions'],
  protocolIncompatible: false,
  ...overrides,
})

describe('probeDashboard Dashboard 探测', () => {
  test('Given /api/status 返回 200 When 探测 Then available 且带版本', async () => {
    const transport = fakeTransport(() => ({
      status: 200,
      body: { version: '0.20.0', auth_required: false },
    }))
    const result = await probeDashboard(transport)
    expect(result.available).toBe(true)
    expect(result.version).toBe('0.20.0')
    expect(result.authRequired).toBe(false)
  })

  test('Given /api/status 返回 auth_required true When 探测 Then 标记认证开启', async () => {
    const transport = fakeTransport(() => ({
      status: 200,
      body: { version: '0.20.0', auth_required: true, auth_flows: ['cookie'] },
    }))
    const result = await probeDashboard(transport)
    expect(result.authRequired).toBe(true)
    expect(result.authFlows).toEqual(['cookie'])
  })

  test('Given /api/status 返回 401 When 探测 Then available 且探测 providers 密码支持', async () => {
    let providersCalled = false
    const transport = fakeTransport((path) => {
      if (path === '/api/status') {
        return { status: 401, body: {} }
      }
      if (path === '/api/auth/providers') {
        providersCalled = true
        return {
          status: 200,
          body: {
            providers: [
              { name: 'nous', display_name: 'Nous', supports_password: false },
              { name: 'basic', display_name: 'Basic', supports_password: true },
            ],
          },
        }
      }
      return { status: 404, body: {} }
    })
    const result = await probeDashboard(transport)
    expect(result.available).toBe(true)
    expect(result.authRequired).toBe(true)
    expect(providersCalled).toBe(true)
    expect(result.supportsPassword).toBe(true)
  })

  test('Given /api/status 返回 404 When 探测 Then unavailable', async () => {
    const transport = fakeTransport(() => ({ status: 404, body: {} }))
    const result = await probeDashboard(transport)
    expect(result.available).toBe(false)
    expect(result.protocolIncompatible).toBe(false)
  })

  test('Given 网络错误 When 探测 Then unavailable', async () => {
    const transport = fakeTransport(() => new HermesError('无法连接', 'network'))
    const result = await probeDashboard(transport)
    expect(result.available).toBe(false)
  })

  test('Given 非 JSON 响应 When 探测 Then protocolIncompatible', async () => {
    const transport = fakeTransport(
      () => new HermesError('远端返回非 JSON', 'protocol-incompatible'),
    )
    const result = await probeDashboard(transport)
    expect(result.protocolIncompatible).toBe(true)
    expect(result.available).toBe(false)
  })
})

describe('probeApiServer API Server 探测', () => {
  test('Given /v1/capabilities 返回 200 When 探测 Then available 且带端点', async () => {
    const transport = fakeTransport(() => ({
      status: 200,
      body: { capabilities: ['/v1/runs', '/v1/chat/completions'] },
    }))
    const result = await probeApiServer(transport)
    expect(result.available).toBe(true)
    expect(result.endpoints).toContain('/v1/runs')
  })

  test('Given 返回 401 When 探测 Then available 且标记认证', async () => {
    const transport = fakeTransport(() => ({ status: 401, body: {} }))
    const result = await probeApiServer(transport)
    expect(result.available).toBe(true)
    expect(result.authRequired).toBe(true)
  })

  test('Given 网络错误 When 探测 Then unavailable', async () => {
    const transport = fakeTransport(() => new HermesError('无法连接', 'network'))
    const result = await probeApiServer(transport)
    expect(result.available).toBe(false)
  })
})

describe('classifyHermesService 服务分类', () => {
  test('Given 两者可用 When 分类 Then both', () => {
    expect(classifyHermesService(dashOk(), apiOk())).toBe('both')
  })

  test('Given 仅 Dashboard 可用 When 分类 Then dashboard-only', () => {
    expect(classifyHermesService(dashOk(), { ...apiOk(), available: false })).toBe(
      'dashboard-only',
    )
  })

  test('Given 仅 API Server 可用 When 分类 Then api-only', () => {
    expect(classifyHermesService({ ...dashOk(), available: false }, apiOk())).toBe(
      'api-only',
    )
  })

  test('Given 任一协议不兼容 When 分类 Then protocol-incompatible', () => {
    expect(
      classifyHermesService({ ...dashOk(), protocolIncompatible: true }, apiOk()),
    ).toBe('protocol-incompatible')
  })

  test('Given 均不可用 When 分类 Then unreachable', () => {
    expect(
      classifyHermesService({ ...dashOk(), available: false }, { ...apiOk(), available: false }),
    ).toBe('unreachable')
  })
})

describe('probeHermesCapabilities 完整探测', () => {
  test('Given Dashboard 与 API Server 均可用 When 探测 Then 生成完整快照', async () => {
    const dashboardTransport = fakeTransport(() => ({
      status: 200,
      body: { version: '0.20.0', auth_required: true, auth_flows: ['cookie'] },
    }))
    const apiServerTransport = fakeTransport(() => ({
      status: 200,
      body: { capabilities: ['/v1/runs'] },
    }))
    const snapshot = await probeHermesCapabilities({
      dashboardTransport,
      apiServerTransport,
    })
    expect(snapshot.serviceClass).toBe('both')
    expect(snapshot.version).toBe('0.20.0')
    expect(snapshot.dashboard?.authRequired).toBe(true)
    expect(snapshot.apiServer?.endpoints).toEqual(['/v1/runs'])
  })

  test('Given 仅 API Server 可用 When 探测 Then api-only 且 dashboard 无数据', async () => {
    const dashboardTransport = fakeTransport(() => new HermesError('无法连接', 'network'))
    const apiServerTransport = fakeTransport(() => ({
      status: 200,
      body: { capabilities: ['/v1/runs'] },
    }))
    const snapshot = await probeHermesCapabilities({
      dashboardTransport,
      apiServerTransport,
    })
    expect(snapshot.serviceClass).toBe('api-only')
    expect(snapshot.dashboard).toBeUndefined()
    expect(snapshot.apiServer?.endpoints).toEqual(['/v1/runs'])
  })

  test('Given 均不可达 When 探测 Then unreachable', async () => {
    const dashboardTransport = fakeTransport(() => new HermesError('无法连接', 'network'))
    const apiServerTransport = fakeTransport(() => new HermesError('无法连接', 'network'))
    const snapshot = await probeHermesCapabilities({
      dashboardTransport,
      apiServerTransport,
    })
    expect(snapshot.serviceClass).toBe('unreachable')
  })
})
