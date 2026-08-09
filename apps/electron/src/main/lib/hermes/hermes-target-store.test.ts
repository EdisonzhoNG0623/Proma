/**
 * Hermes Target Store BDD 测试
 *
 * 覆盖：URL 校验、SSH 配置校验、CRUD 持久化、损坏文件降级。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HermesTargetStore,
  validateAndNormalizeDirectUrl,
  validateAndNormalizeSshConfig,
} from './hermes-target-store'

describe('HermesTargetStore Direct URL 校验', () => {
  test('Given 合法 https URL When 校验 Then 归一化并保留协议', () => {
    expect(validateAndNormalizeDirectUrl('https://hermes.example.com')).toBe(
      'https://hermes.example.com/',
    )
  })

  test('Given 带尾斜杠与 query 的 URL When 校验 Then 去掉尾斜杠与 query 保留根路径', () => {
    expect(validateAndNormalizeDirectUrl('http://192.168.1.10:9119/?foo=1')).toBe(
      'http://192.168.1.10:9119/',
    )
  })

  test('Given 非 http/https 协议 When 校验 Then 抛出协议错误', () => {
    expect(() => validateAndNormalizeDirectUrl('ftp://hermes.example.com')).toThrow(
      '仅支持 http/https',
    )
  })

  test('Given URL 包含 userinfo When 校验 Then 拒绝并提示使用认证配置', () => {
    expect(() =>
      validateAndNormalizeDirectUrl('https://admin:secret@hermes.example.com'),
    ).toThrow('不允许包含用户名密码')
  })

  test('Given URL 包含 hash 片段 When 校验 Then 拒绝', () => {
    expect(() => validateAndNormalizeDirectUrl('https://hermes.example.com/#/chat')).toThrow(
      '不允许包含 hash',
    )
  })

  test('Given 空 URL When 校验 Then 拒绝', () => {
    expect(() => validateAndNormalizeDirectUrl('  ')).toThrow('不能为空')
  })

  test('Given 无法解析的 URL When 校验 Then 拒绝', () => {
    expect(() => validateAndNormalizeDirectUrl('not a url')).toThrow('无效')
  })
})

describe('HermesTargetStore SSH 配置校验', () => {
  test('Given 合法 SSH 配置 When 校验 Then 补默认远端端口 9119/8642', () => {
    const result = validateAndNormalizeSshConfig({
      host: 'vps.example.com',
      port: 22,
      username: 'deploy',
    })
    expect(result.dashboardRemotePort).toBe(9119)
    expect(result.apiServerRemotePort).toBe(8642)
    expect(result.host).toBe('vps.example.com')
  })

  test('Given 自定义远端端口 When 校验 Then 保留自定义值', () => {
    const result = validateAndNormalizeSshConfig({
      host: 'vps.example.com',
      port: 2222,
      username: 'deploy',
      dashboardRemotePort: 9000,
      apiServerRemotePort: 8000,
    })
    expect(result.port).toBe(2222)
    expect(result.dashboardRemotePort).toBe(9000)
    expect(result.apiServerRemotePort).toBe(8000)
  })

  test('Given 缺少 SSH 配置 When 校验 Then 拒绝', () => {
    expect(() => validateAndNormalizeSshConfig(undefined)).toThrow('必须提供 SSH 配置')
  })

  test('Given 主机为空 When 校验 Then 拒绝', () => {
    expect(() =>
      validateAndNormalizeSshConfig({ host: '  ', port: 22, username: 'u' }),
    ).toThrow('SSH 主机不能为空')
  })

  test('Given 端口越界 When 校验 Then 拒绝', () => {
    expect(() =>
      validateAndNormalizeSshConfig({ host: 'h', port: 70000, username: 'u' }),
    ).toThrow('端口必须在 1-65535')
  })
})

describe('HermesTargetStore CRUD', () => {
  const setup = (): { store: HermesTargetStore; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-target-'))
    const store = new HermesTargetStore(join(dir, 'hermes-targets.json'))
    return { store, dir }
  }
  const cleanup = (dir: string): void => rmSync(dir, { recursive: true, force: true })

  test('Given 空存储 When 创建 Direct Target Then 持久化并可读取', () => {
    const { store, dir } = setup()
    try {
      const created = store.createTarget({
        name: '我的 Hermes',
        mode: 'direct',
        remoteUrl: 'https://hermes.example.com',
      })
      expect(created.id).toBeTruthy()
      expect(created.mode).toBe('direct')
      expect(created.endpoints?.dashboard?.baseUrl).toBe('https://hermes.example.com/')
      expect(created.remoteUrl).toBeUndefined()
      expect(created.createdAt).toBeGreaterThan(0)

      const listed = store.listTargets()
      expect(listed).toHaveLength(1)
      expect(store.getTarget(created.id)?.name).toBe('我的 Hermes')
    } finally {
      cleanup(dir)
    }
  })

  test('Given 空存储 When 创建 SSH Target Then 补默认端口并持久化', () => {
    const { store, dir } = setup()
    try {
      const created = store.createTarget({
        name: 'VPS Hermes',
        mode: 'ssh-tunnel',
        ssh: { host: 'vps.example.com', port: 22, username: 'deploy' },
      })
      expect(created.endpoints?.dashboard?.remotePort).toBe(9119)
      expect(created.endpoints?.apiServer?.remotePort).toBe(8642)
      expect(created.remoteUrl).toBeUndefined()
      expect(store.listTargets()).toHaveLength(1)
    } finally {
      cleanup(dir)
    }
  })

  test('Given 重名 Target When 创建 Then 允许（名称不要求唯一）', () => {
    const { store, dir } = setup()
    try {
      store.createTarget({ name: '同名', mode: 'direct', remoteUrl: 'https://a.example.com' })
      store.createTarget({ name: '同名', mode: 'direct', remoteUrl: 'https://b.example.com' })
      expect(store.listTargets()).toHaveLength(2)
    } finally {
      cleanup(dir)
    }
  })

  test('Given Direct 模式缺少 URL When 创建 Then 拒绝', () => {
    const { store, dir } = setup()
    try {
      expect(() => store.createTarget({ name: 'x', mode: 'direct' })).toThrow('至少一个 Hermes 服务 URL')
    } finally {
      cleanup(dir)
    }
  })

  test('Given 名称空白 When 创建 Then 拒绝', () => {
    const { store, dir } = setup()
    try {
      expect(() =>
        store.createTarget({ name: '   ', mode: 'direct', remoteUrl: 'https://a.example.com' }),
      ).toThrow('连接名称不能为空')
    } finally {
      cleanup(dir)
    }
  })

  test('Given 已存在 Target When 更新名称与能力快照 Then 保留 id 与 createdAt', () => {
    const { store, dir } = setup()
    try {
      const created = store.createTarget({
        name: '旧名',
        mode: 'direct',
        remoteUrl: 'https://a.example.com',
      })
      const updated = store.updateTarget(created.id, {
        name: '新名',
        lastCapabilitySnapshot: {
          probedAt: Date.now(),
          version: '0.20.0',
          serviceClass: 'both',
          dashboard: { authRequired: true, authFlows: ['cookie'], supportsPassword: true },
          apiServer: { endpoints: ['/v1/runs'] },
        },
      })
      expect(updated.id).toBe(created.id)
      expect(updated.createdAt).toBe(created.createdAt)
      expect(updated.name).toBe('新名')
      expect(updated.lastCapabilitySnapshot?.version).toBe('0.20.0')
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
    } finally {
      cleanup(dir)
    }
  })

  test('Given 已存在 Direct Target When 切换为 SSH 模式 Then 重归一化并清空 remoteUrl', () => {
    const { store, dir } = setup()
    try {
      const created = store.createTarget({
        name: 'x',
        mode: 'direct',
        remoteUrl: 'https://a.example.com',
      })
      const updated = store.updateTarget(created.id, {
        mode: 'ssh-tunnel',
        ssh: { host: 'vps.example.com', port: 22, username: 'deploy' },
      })
      expect(updated.mode).toBe('ssh-tunnel')
      expect(updated.remoteUrl).toBeUndefined()
      expect(updated.ssh?.host).toBe('vps.example.com')
    } finally {
      cleanup(dir)
    }
  })

  test('Given 不存在的 id When 更新 Then 抛出错误', () => {
    const { store, dir } = setup()
    try {
      expect(() => store.updateTarget('missing', { name: 'x' })).toThrow('不存在')
    } finally {
      cleanup(dir)
    }
  })

  test('Given 已存在 Target When 删除 Then 返回被删除对象且列表清空', () => {
    const { store, dir } = setup()
    try {
      const created = store.createTarget({
        name: 'x',
        mode: 'direct',
        remoteUrl: 'https://a.example.com',
      })
      const removed = store.deleteTarget(created.id)
      expect(removed?.id).toBe(created.id)
      expect(store.listTargets()).toHaveLength(0)
      expect(store.deleteTarget(created.id)).toBeNull()
    } finally {
      cleanup(dir)
    }
  })

  test('Given 主配置与 backup 都损坏 When 读取 Then fail closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-target-'))
    const file = join(dir, 'hermes-targets.json')
    try {
      writeFileSync(file, '{ not valid json', 'utf-8')
      writeFileSync(`${file}.bak`, '{ also invalid', 'utf-8')
      const store = new HermesTargetStore(file)
      expect(() => store.listTargets()).toThrow('配置损坏')
      expect(() => store.createTarget({ name: '不可覆盖', mode: 'direct', remoteUrl: 'https://x.example.com' })).toThrow('配置损坏')
    } finally {
      cleanup(dir)
    }
  })

  test('Given V1 Direct 无 API-only 快照 When 读取 Then 保留 ID 并迁移为 Dashboard endpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-target-'))
    const file = join(dir, 'hermes-targets.json')
    try {
      writeFileSync(file, JSON.stringify({
        version: 1,
        targets: [{
          id: 'legacy-dashboard',
          name: '旧 Dashboard',
          mode: 'direct',
          remoteUrl: 'https://dashboard.example.com',
          auth: {},
          createdAt: 1,
          updatedAt: 2,
        }],
      }), 'utf8')
      const [target] = new HermesTargetStore(file).listTargets()
      expect(target?.id).toBe('legacy-dashboard')
      expect(target?.endpoints).toEqual({ dashboard: { baseUrl: 'https://dashboard.example.com/' } })
      expect(target?.remoteUrl).toBeUndefined()
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(2)
    } finally {
      cleanup(dir)
    }
  })

  test('Given V1 Direct API-only 快照 When 读取 Then 迁移为 API endpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-target-'))
    const file = join(dir, 'hermes-targets.json')
    try {
      writeFileSync(file, JSON.stringify({
        version: 1,
        targets: [{
          id: 'legacy-api',
          name: '旧 API',
          mode: 'direct',
          remoteUrl: 'https://api.example.com',
          auth: {},
          lastCapabilitySnapshot: { probedAt: 1, version: null, serviceClass: 'api-only' },
          createdAt: 1,
          updatedAt: 2,
        }],
      }), 'utf8')
      const [target] = new HermesTargetStore(file).listTargets()
      expect(target?.endpoints).toEqual({ apiServer: { baseUrl: 'https://api.example.com/' } })
      expect(target?.lastCapabilitySnapshot).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  test('Given 旧 V2 password ref 无 auth mode When 读取 Then 推断 password-cookie 并回写', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-target-'))
    const file = join(dir, 'hermes-targets.json')
    try {
      writeFileSync(file, JSON.stringify({
        version: 2,
        targets: [{
          id: 'legacy-password-v2',
          name: '旧密码配置',
          mode: 'direct',
          endpoints: { dashboard: { baseUrl: 'https://dashboard.example.com' } },
          auth: { dashboardCredentialRef: 'legacy-ref', dashboardProvider: 'basic' },
          createdAt: 1,
          updatedAt: 2,
        }],
      }), 'utf8')
      const [target] = new HermesTargetStore(file).listTargets()
      expect(target?.auth.dashboardMode).toBe('password-cookie')
      const persisted = JSON.parse(readFileSync(file, 'utf8')) as { targets: Array<{ auth: { dashboardMode?: string } }> }
      expect(persisted.targets[0]?.auth.dashboardMode).toBe('password-cookie')
    } finally {
      cleanup(dir)
    }
  })

  test('Given V2 Direct 两个 URL When 创建 Then 独立持久化', () => {
    const { store, dir } = setup()
    try {
      const target = store.createTarget({
        name: '双端点',
        mode: 'direct',
        endpoints: {
          dashboard: { baseUrl: 'https://dashboard.example.com' },
          apiServer: { baseUrl: 'https://api.example.com:8642' },
        },
      })
      expect(target.endpoints?.dashboard?.baseUrl).toBe('https://dashboard.example.com/')
      expect(target.endpoints?.apiServer?.baseUrl).toBe('https://api.example.com:8642/')
    } finally {
      cleanup(dir)
    }
  })

  test('Given endpoint 发生变化 When 更新 Then 清除旧能力快照', () => {
    const { store, dir } = setup()
    try {
      const target = store.createTarget({ name: 'x', mode: 'direct', remoteUrl: 'https://a.example.com' })
      store.updateTarget(target.id, {
        lastCapabilitySnapshot: { probedAt: 1, version: '1', serviceClass: 'dashboard-only' },
      })
      const updated = store.updateTarget(target.id, {
        endpoints: { dashboard: { baseUrl: 'https://b.example.com' } },
      })
      expect(updated.lastCapabilitySnapshot).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  test('Given 已有多个 Target When 列出 Then 按创建时间升序', () => {
    const { store, dir } = setup()
    try {
      const first = store.createTarget({
        name: 'a',
        mode: 'direct',
        remoteUrl: 'https://a.example.com',
      })
      const second = store.createTarget({
        name: 'b',
        mode: 'direct',
        remoteUrl: 'https://b.example.com',
      })
      const listed = store.listTargets()
      expect(listed.map((item) => item.id)).toEqual([first.id, second.id])
    } finally {
      cleanup(dir)
    }
  })
})
