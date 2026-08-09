import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { Client, type ConnectConfig, type SFTPWrapper, type VerifyCallback } from 'ssh2'
import type { Duplex } from 'node:stream'
import { HermesError } from '../hermes-errors'
import { HermesKnownHostStore, hermesKnownHostStore, type HermesHostKeyCheck } from '../hermes-known-host-store'

export interface HermesSshClientLike {
  on(event: string, listener: (...args: any[]) => void): this
  connect(config: ConnectConfig): void
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, stream?: Duplex) => void,
  ): void
  sftp(callback: (error: Error | undefined, sftp?: SFTPWrapper) => void): void
  end(): void
}

export interface HermesSshAuth {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export class HermesSshHostKeyChallengeError extends HermesError {
  constructor(readonly challenge: string, readonly fingerprint: string) {
    super(`首次连接 SSH 主机，需要确认指纹 ${fingerprint}`, 'ssh')
    this.name = 'HermesSshHostKeyChallengeError'
  }
}

export class HermesSshHostKeyChangedError extends HermesError {
  constructor(readonly fingerprint: string) {
    super(`SSH host key 已变化，已阻断连接（当前 ${fingerprint}）`, 'ssh')
    this.name = 'HermesSshHostKeyChangedError'
  }
}

interface ConnectOptions {
  knownHosts?: HermesKnownHostStore
  clientFactory?: () => HermesSshClientLike
  endpoints: { dashboard?: number; apiServer?: number }
  readyTimeoutMs?: number
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/** One ssh2.Client owns all forwards and SFTP for one target lease. */
export class HermesSshConnection {
  readonly id = randomUUID()
  readonly localDashboardPort?: number
  readonly localApiServerPort?: number
  private closed = false
  private readonly sockets = new Set<Socket | Duplex>()

  private constructor(
    private readonly client: HermesSshClientLike,
    private readonly dashboardServer: Server | undefined,
    private readonly apiServer: Server | undefined,
  ) {
    this.localDashboardPort = this.portOf(dashboardServer)
    this.localApiServerPort = this.portOf(apiServer)
  }

  static async connect(auth: HermesSshAuth, options: ConnectOptions): Promise<HermesSshConnection> {
    const knownHosts = options.knownHosts ?? hermesKnownHostStore
    const client: HermesSshClientLike = options.clientFactory?.()
      ?? (new Client() as unknown as HermesSshClientLike)
    let hostCheck: HermesHostKeyCheck | null = null
    const readyTimeoutMs = options.readyTimeoutMs ?? 15_000

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          error ? reject(error) : resolve()
        }
        const timer = setTimeout(() => finish(new HermesError('SSH 连接超时', 'ssh')), readyTimeoutMs)
        client.on('ready', () => finish())
        client.on('error', (error: Error) => {
          if (hostCheck?.status === 'unknown') {
            finish(new HermesSshHostKeyChallengeError(hostCheck.challenge!, hostCheck.fingerprint))
          } else if (hostCheck?.status === 'changed') {
            finish(new HermesSshHostKeyChangedError(hostCheck.fingerprint))
          } else {
            finish(new HermesError(`SSH 连接失败: ${error.message}`, 'ssh'))
          }
        })
        const hostVerifier = ((key: Buffer, verify: VerifyCallback): void => {
          hostCheck = knownHosts.check(auth.host, auth.port, key)
          verify(hostCheck.status === 'trusted')
        }) as NonNullable<ConnectConfig['hostVerifier']>
        client.connect({
          host: auth.host,
          port: auth.port,
          username: auth.username,
          password: auth.password,
          privateKey: auth.privateKey,
          passphrase: auth.passphrase,
          readyTimeout: readyTimeoutMs,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          agentForward: false,
          hostVerifier,
        })
      })
    } catch (error) {
      client.end()
      throw error
    }

    let dashboardServer: Server | undefined
    let apiServer: Server | undefined
    try {
      if (options.endpoints.dashboard) {
        dashboardServer = await HermesSshConnection.createForwarder(client, options.endpoints.dashboard)
      }
      if (options.endpoints.apiServer) {
        apiServer = await HermesSshConnection.createForwarder(client, options.endpoints.apiServer)
      }
      return new HermesSshConnection(client, dashboardServer, apiServer)
    } catch (error) {
      await closeServer(dashboardServer)
      await closeServer(apiServer)
      client.end()
      throw error
    }
  }

  private static async createForwarder(client: HermesSshClientLike, remotePort: number): Promise<Server> {
    const server = createServer((socket) => {
      client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        '127.0.0.1',
        remotePort,
        (error, stream) => {
          if (error || !stream) {
            socket.destroy(error)
            return
          }
          socket.pipe(stream).pipe(socket)
          const destroy = (): void => {
            socket.destroy()
            stream.destroy()
          }
          socket.once('error', destroy)
          stream.once('error', destroy)
        },
      )
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    return server
  }

  private portOf(server: Server | undefined): number | undefined {
    const address = server?.address()
    return address && typeof address === 'object' ? address.port : undefined
  }

  async openSftp(): Promise<SFTPWrapper> {
    if (this.closed) throw new HermesError('SSH 连接已关闭', 'ssh')
    return await new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((error, sftp) => {
        if (error || !sftp) reject(new HermesError(`SFTP 初始化失败: ${error?.message ?? 'unknown'}`, 'ssh'))
        else resolve(sftp)
      })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await Promise.all([closeServer(this.dashboardServer), closeServer(this.apiServer)])
    this.client.end()
  }
}
