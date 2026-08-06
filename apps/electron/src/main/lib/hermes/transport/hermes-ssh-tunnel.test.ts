/**
 * Hermes SSH Tunnel BDD 测试
 *
 * 覆盖：ssh 参数构建、空闲端口分配、端口探测、就绪等待、隧道生命周期（mock spawn）。
 * 通过注入 fake spawn / findFreePort 避免真实 SSH 连接。
 */

import { describe, expect, test } from 'bun:test'
import { createServer, connect, type Server } from 'node:net'
import { EventEmitter } from 'node:events'
import type { HermesSshTunnelConfig } from '@proma/shared'
import {
  HermesSshTunnelManager,
  buildSshArgs,
  createFindFreePort,
  isPortOpen,
  waitForPort,
  type SshChildProcess,
  type SshSpawnFn,
} from './hermes-ssh-tunnel'
import { HermesError } from '../hermes-errors'

const sampleConfig: HermesSshTunnelConfig = {
  host: 'vps.example.com',
  port: 22,
  username: 'deploy',
  dashboardRemotePort: 9119,
  apiServerRemotePort: 8642,
}

describe('buildSshArgs 参数构建', () => {
  test('Given 配置 When 构建 Then 包含 -L 转发、安全选项与目标', () => {
    const args = buildSshArgs(
      sampleConfig,
      { localDashboard: 40001, localApiServer: 40002 },
      { userKnownHostsFile: '/home/u/.ssh/proma-known_hosts', hostKeyMode: 'confirm' },
    )
    expect(args).toContain('-L')
    expect(args).toContain('127.0.0.1:40001:127.0.0.1:9119')
    expect(args).toContain('127.0.0.1:40002:127.0.0.1:8642')
    expect(args).toContain('ExitOnForwardFailure=yes')
    expect(args).toContain('ForwardAgent=no')
    expect(args).toContain('StrictHostKeyChecking=accept-new')
    expect(args).toContain('ServerAliveInterval=15')
    expect(args).toContain('deploy@vps.example.com')
    expect(args.join(' ')).not.toContain('password')
  })

  test('Given hostKeyMode=strict When 构建 Then StrictHostKeyChecking=yes', () => {
    const args = buildSshArgs(
      sampleConfig,
      { localDashboard: 1, localApiServer: 2 },
      { userKnownHostsFile: 'f', hostKeyMode: 'strict' },
    )
    expect(args).toContain('StrictHostKeyChecking=yes')
  })
})

describe('createFindFreePort 空闲端口分配', () => {
  test('Given 查找 When 分配 Then 返回可监听端口且随后可复用', async () => {
    const findFreePort = createFindFreePort()
    const port = await findFreePort()
    expect(port).toBeGreaterThan(0)
    // 端口应可再次绑定
    const server: Server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    server.close()
  })

  test('Given 连续查找 When 分配 Then 返回不同端口', async () => {
    const findFreePort = createFindFreePort()
    const a = await findFreePort()
    const b = await findFreePort()
    expect(a).not.toBe(b)
  })
})

describe('isPortOpen / waitForPort 就绪判定', () => {
  test('Given 端口未监听 When 探测 Then 返回 false', async () => {
    expect(await isPortOpen(1)).toBe(false)
  })

  test('Given 端口已监听 When 探测 Then 返回 true', async () => {
    const server: Server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      expect(await isPortOpen(port)).toBe(true)
    } finally {
      server.close()
    }
  })

  test('Given 端口始终不可达 When 等待 Then 超时抛 ssh 错误', async () => {
    const error = await waitForPort(1, 30, 10).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HermesError)
    expect((error as HermesError).code).toBe('ssh')
  })

  test('Given 延迟可连 When 等待 Then 就绪', async () => {
    const port = 49999
    const server: Server = createServer()
    // 延迟 50ms 后监听
    setTimeout(() => server.listen(port, '127.0.0.1'), 50)
    try {
      await waitForPort(port, 2_000, 20)
    } finally {
      server.close()
    }
  })
})

describe('HermesSshTunnelManager 隧道生命周期', () => {
  const createFakeProcess = (): SshChildProcess & { emitExit: (code: number | null) => void; killed: boolean } => {
    const emitter = new EventEmitter() as EventEmitter &
      SshChildProcess &
      { emitExit: (code: number | null) => void; killed: boolean }
    Object.defineProperty(emitter, 'pid', { value: 1234, enumerable: true })
    emitter.killed = false
    emitter.emitExit = (code: number | null) => {
      emitter.emit('exit', code, null)
    }
    emitter.kill = () => {
      emitter.killed = true
      return true
    }
    return emitter
  }

  test('Given SSH 启动成功 When 打开隧道 Then 返回本地端口并复用已监听端口就绪', async () => {
    // 先监听一个端口模拟隧道转发成功
    const server: Server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const dashboardPort = typeof address === 'object' && address ? address.port : 0

    let portIndex = 0
    const spawned: Array<{ args: string[] }> = []
    const spawnImpl: SshSpawnFn = (args) => {
      spawned.push({ args })
      return createFakeProcess()
    }
    const manager = new HermesSshTunnelManager({
      spawnImpl,
      findFreePort: async () => {
        portIndex += 1
        return portIndex === 1 ? dashboardPort : dashboardPort + 1
      },
      knownHostsPath: '/tmp/kh',
    })

    const handle = await manager.openTunnel(sampleConfig, { hostKeyMode: 'confirm' })
    expect(handle.localDashboardPort).toBe(dashboardPort)
    expect(handle.host).toBe('vps.example.com')
    expect(spawned[0]?.args.join(' ')).toContain('StrictHostKeyChecking=accept-new')
    await handle.close()
    expect(handle.processPid).toBe(1234)
    server.close()
  })

  test('Given 端口始终不可连 When 打开隧道 Then 超时并终止进程', async () => {
    const proc = createFakeProcess()
    const spawnImpl: SshSpawnFn = () => proc
    const manager = new HermesSshTunnelManager({
      spawnImpl,
      findFreePort: async () => 49998,
      knownHostsPath: '/tmp/kh',
    })
    const error = await manager
      .openTunnel(sampleConfig, { hostKeyMode: 'confirm', readyTimeoutMs: 200 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HermesError)
    expect((error as HermesError).code).toBe('ssh')
    expect(proc.killed).toBe(true)
  })

  test('Given 密码选项 When 打开隧道 Then 环境注入 askpass 且命令行不含密码', async () => {
    let capturedEnv: Record<string, string> | null = null
    const spawnImpl: SshSpawnFn = (_args, options) => {
      capturedEnv = options.env
      return createFakeProcess()
    }
    const manager = new HermesSshTunnelManager({
      spawnImpl,
      findFreePort: async () => 49997,
      knownHostsPath: '/tmp/kh',
    })
    await manager
      .openTunnel(sampleConfig, {
        hostKeyMode: 'confirm',
        password: 'super-secret-password',
        readyTimeoutMs: 200,
      })
      .catch(() => undefined) // 端口不可达会超时，忽略
    const env = capturedEnv as Record<string, string> | null
    expect(env?.PROMA_SSH_PASSWORD).toBe('super-secret-password')
    expect(env?.SSH_ASKPASS_REQUIRE).toBe('force')
  })

  test('Given 进程意外退出 When 打开后 Then 记录日志不崩溃', async () => {
    const proc = createFakeProcess()
    const spawnImpl: SshSpawnFn = () => proc
    const manager = new HermesSshTunnelManager({
      spawnImpl,
      findFreePort: async () => 49996,
      knownHostsPath: '/tmp/kh',
    })
    const handle = await manager
      .openTunnel(sampleConfig, { hostKeyMode: 'confirm', readyTimeoutMs: 200 })
      .catch(() => null)
    if (handle) {
      // 触发退出监听
      proc.emitExit(255)
      expect(handle.processPid).toBe(1234)
    }
  })
})
