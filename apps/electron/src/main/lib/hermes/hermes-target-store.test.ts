/**
 * Hermes Target Store BDD 测试
 *
 * 覆盖：URL 校验、SSH 配置校验、CRUD 持久化、损坏文件降级。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
      expect(created.remoteUrl).toBe('https://hermes.example.com/')
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
      expect(created.ssh?.dashboardRemotePort).toBe(9119)
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
      expect(() => store.createTarget({ name: 'x', mode: 'direct' })).toThrow('必须提供远端 URL')
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

  test('Given 配置文件损坏 When 读取 Then 返回空列表而非崩溃', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-target-'))
    try {
      writeFileSync(join(dir, 'hermes-targets.json'), '{ not valid json', 'utf-8')
      const store = new HermesTargetStore(join(dir, 'hermes-targets.json'))
      expect(store.listTargets()).toEqual([])
      expect(store.getTarget('any')).toBeNull()
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
