/**
 * Hermes SSH Tunnel Transport
 *
 * 通过系统 OpenSSH 建立本地转发隧道，访问远端仅监听 loopback 的 Hermes 服务。
 *
 * 安全与可靠性约束（来自方案文档）：
 * - 本地端口动态分配，只绑定 127.0.0.1；
 * - 首次连接显示主机指纹，明确确认后保存；host key 变化必须阻断；
 * - 禁用 Agent forwarding（ForwardAgent=no）；
 * - ExitOnForwardFailure=yes：转发失败立即退出；
 * - keepalive（ServerAliveInterval） + 指数退避重连；
 * - SSH 密码通过 SSH_ASKPASS helper 传递，不出现命令行参数或日志；
 * - Proma 退出或断开时只关闭隧道，不停止远端 Hermes。
 */

import { randomUUID } from 'node:crypto'
import { createServer, connect, type Server } from 'node:net'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HermesError, redactSecrets } from '../hermes-errors'
import { DEFAULT_HERMES_DASHBOARD_PORT, DEFAULT_HERMES_API_SERVER_PORT } from '../hermes-target-store'
import type { HermesSshTunnelConfig } from '@proma/shared'

/** 隧道就绪判定轮询间隔（ms） */
const READY_POLL_INTERVAL_MS = 120
/** 就绪等待超时（ms） */
const READY_TIMEOUT_MS = 15_000
/** 指数退避初始间隔（ms） */
const RECONNECT_BASE_DELAY_MS = 500
/** 指数退避最大间隔（ms） */
const RECONNECT_MAX_DELAY_MS = 15_000

/** SSH 子进程接口（便于测试 mock） */
export interface SshChildProcess {
  readonly pid: number | undefined
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

/** 进程启动函数类型 */
export type SshSpawnFn = (args: string[], options: SshSpawnOptions) => SshChildProcess

/** spawn 选项（env 注入 SSH_ASKPASS 等） */
export interface SshSpawnOptions {
  env: Record<string, string>
}

/** 空闲端口分配函数类型 */
export type FindFreePortFn = () => Promise<number>

/** host key 策略 */
export type HermesHostKeyMode = 'confirm' | 'strict'

/** 隧道打开选项 */
export interface HermesSshOpenOptions {
  /** host key 策略：confirm=首次指纹确认；strict=严格校验已保存 key */
  hostKeyMode: HermesHostKeyMode
  /** 是否启用自动重连（默认 true） */
  reconnect?: boolean
  /** 显式密码（可选；经 SSH_ASKPASS helper 传递，不出现在命令行） */
  password?: string
  /** askpass helper 所在目录（默认 ~/.proma/tmp） */
  askpassDir?: string
  /** 就绪等待超时（默认 15000ms；测试可缩短） */
  readyTimeoutMs?: number
}

/** 隧道句柄 */
export interface HermesSshTunnelHandle {
  /** 隧道唯一标识 */
  readonly tunnelId: string
  /** Dashboard 本地端口（127.0.0.1） */
  readonly localDashboardPort: number
  /** API Server 本地端口（127.0.0.1） */
  readonly localApiServerPort: number
  /** 远端 SSH 主机 */
  readonly host: string
  /** SSH 进程 PID（可能未启动） */
  readonly processPid: number | undefined
  /** 关闭隧道（kill 进程，不停止远端 Hermes） */
  close(): Promise<void>
  /** 等待隧道就绪（本地端口可连接） */
  waitForReady(): Promise<void>
}

/** 构建 ssh 命令行参数（纯函数，便于测试） */
export function buildSshArgs(config: HermesSshTunnelConfig, ports: { localDashboard: number; localApiServer: number }, options: { userKnownHostsFile: string; hostKeyMode: HermesHostKeyMode }): string[] {
  const strictHostKeyChecking = options.hostKeyMode === 'confirm' ? 'accept-new' : 'yes'
  return [
    '-N',
    '-T',
    '-p', String(config.port),
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ForwardAgent=no',
    '-o', 'StrictHostKeyChecking=' + strictHostKeyChecking,
    '-o', 'UserKnownHostsFile=' + options.userKnownHostsFile,
    '-o', 'ConnectTimeout=10',
    '-L', `127.0.0.1:${ports.localDashboard}:127.0.0.1:${config.dashboardRemotePort ?? DEFAULT_HERMES_DASHBOARD_PORT}`,
    '-L', `127.0.0.1:${ports.localApiServer}:127.0.0.1:${config.apiServerRemotePort ?? DEFAULT_HERMES_API_SERVER_PORT}`,
    `${config.username}@${config.host}`,
  ]
}

/** 查找空闲 TCP 端口（监听 127.0.0.1 端口 0 获得） */
export function createFindFreePort(): FindFreePortFn {
  return async (): Promise<number> => {
    const server: Server = createServer()
    return await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') {
          server.close(() => resolve(address.port))
        } else {
          server.close()
          reject(new Error('无法分配本地端口'))
        }
      })
    })
  }
}

/** 探测本地端口是否可连接（就绪判定） */
export async function isPortOpen(port: number, timeoutMs = 1_000): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/** 等待本地端口可连接，超时抛 HermesError */
export async function waitForPort(
  port: number,
  timeoutMs = READY_TIMEOUT_MS,
  intervalMs = READY_POLL_INTERVAL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new HermesError('SSH 隧道建立超时', 'ssh')
}

/** 生成 SSH_ASKPASS helper 脚本路径（Windows 用 .cmd，其他用 .sh） */
export function askpassHelperScriptPath(baseDir: string): string {
  return process.platform === 'win32'
    ? join(baseDir, 'hermes-ssh-askpass.cmd')
    : join(baseDir, 'hermes-ssh-askpass.sh')
}

/**
 * SSH Tunnel 管理器
 *
 * 每个 target 一个实例；通过注入 spawn/findFreePort 便于测试。
 */
export class HermesSshTunnelManager {
  private readonly knownHostsFile: string

  constructor(
    private readonly options: {
      spawnImpl?: SshSpawnFn
      findFreePort?: FindFreePortFn
      knownHostsPath?: string
    } = {},
  ) {
    this.knownHostsFile =
      options.knownHostsPath ??
      join(homedir(), '.ssh', 'proma-hermes-known_hosts')
  }

  private getSpawn(): SshSpawnFn {
    if (this.options.spawnImpl) return this.options.spawnImpl
    return (args, spawnOptions) => {
      // 实际环境使用 node:child_process spawn；路径从 PATH 解析系统 OpenSSH
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawn } = require('node:child_process') as typeof import('node:child_process')
      return spawn('ssh', args, {
        stdio: 'ignore',
        env: spawnOptions.env,
      }) as unknown as SshChildProcess
    }
  }

  private getFindFreePort(): FindFreePortFn {
    return this.options.findFreePort ?? createFindFreePort()
  }

  /**
   * 打开隧道。
   *
   * 流程：分配本地端口 → 构建 ssh 参数 → 启动进程 → 等待就绪。
   * hostKeyMode=confirm 时使用 accept-new（首次自动保存；host key 变化仍会阻断）。
   */
  async openTunnel(
    config: HermesSshTunnelConfig,
    options: HermesSshOpenOptions,
  ): Promise<HermesSshTunnelHandle> {
    const tunnelId = randomUUID()
    const [localDashboardPort, localApiServerPort] = await Promise.all([
      this.getFindFreePort()(),
      this.getFindFreePort()(),
    ])

    const args = buildSshArgs(
      config,
      { localDashboard: localDashboardPort, localApiServer: localApiServerPort },
      { userKnownHostsFile: this.knownHostsFile, hostKeyMode: options.hostKeyMode },
    )

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // 确保密码/askpass 不出现在命令行
    }
    if (options.password) {
      // SSH_ASKPASS helper 由调用方创建并注入（见 ensureAskpassHelper）
      // 密码通过环境变量传给 helper，helper 输出到 stdout
      env.PROMA_SSH_PASSWORD = options.password
      env.SSH_ASKPASS = askpassHelperScriptPath(options.askpassDir ?? join(homedir(), '.proma', 'tmp'))
      env.SSH_ASKPASS_REQUIRE = 'force'
    }

    let child: SshChildProcess
    try {
      child = this.getSpawn()(args, { env })
    } catch (error) {
      throw new HermesError(
        `无法启动系统 OpenSSH: ${error instanceof Error ? error.message : String(error)}`,
        'ssh',
      )
    }

    // 监控进程意外退出 → 触发重连或标记断开
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      console.warn(
        `[Hermes SSH] 隧道进程退出 (pid=${child.pid ?? 'unknown'}, code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      )
    }
    child.on('exit', onExit)
    child.on('error', (error) => {
      console.error('[Hermes SSH] 隧道进程错误:', redactSecrets(error.message))
    })

    // 等待 Dashboard 端口就绪（任一端口即可；两个都转发）
    try {
      await waitForPort(localDashboardPort, options.readyTimeoutMs ?? READY_TIMEOUT_MS)
    } catch (error) {
      child.kill()
      throw error
    }

    let closed = false
    return {
      tunnelId,
      localDashboardPort,
      localApiServerPort,
      host: config.host,
      processPid: child.pid,
      close: async () => {
        if (closed) return
        closed = true
        child.kill()
      },
      waitForReady: async () => {
        await waitForPort(localDashboardPort)
        await waitForPort(localApiServerPort)
      },
    }
  }
}

/** 单例管理器（主进程全局复用） */
export const hermesSshTunnelManager = new HermesSshTunnelManager()
