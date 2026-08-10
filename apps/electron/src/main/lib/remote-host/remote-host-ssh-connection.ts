import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { Client, type ConnectConfig, type SFTPWrapper, type VerifyCallback } from 'ssh2'
import type { Duplex } from 'node:stream'
import {
  RemoteHostKnownHostStore,
  remoteHostKnownHostStore,
  type RemoteHostHostKeyCheck,
} from '../remote-host/remote-host-known-host-store'

export interface RemoteHostSshClientLike {
  on(event: string, listener: (...args: unknown[]) => void): this
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

export interface RemoteHostSshAuth {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export class RemoteHostSshHostKeyChallengeError extends Error {
  readonly challenge: string
  readonly fingerprint: string
  constructor(challenge: string, fingerprint: string) {
    super(`首次连接 SSH 主机，需要确认指纹 ${fingerprint}`)
    this.name = 'RemoteHostSshHostKeyChallengeError'
    this.challenge = challenge
    this.fingerprint = fingerprint
  }
}

export class RemoteHostSshHostKeyChangedError extends Error {
  readonly fingerprint: string
  constructor(fingerprint: string) {
    super(`SSH host key 已变化，已阻断连接（当前 ${fingerprint}）`)
    this.name = 'RemoteHostSshHostKeyChangedError'
    this.fingerprint = fingerprint
  }
}

interface ConnectOptions {
  knownHosts?: RemoteHostKnownHostStore
  clientFactory?: () => RemoteHostSshClientLike
  remoteHostPort: number
  readyTimeoutMs?: number
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

export class RemoteHostSshConnection {
  readonly id = randomUUID()
  readonly localHostPort?: number
  private closed = false
  private readonly sockets = new Set<Socket | Duplex>()

  private constructor(
    private readonly client: RemoteHostSshClientLike,
    private readonly forwardServer: Server | undefined,
  ) {
    this.localHostPort = this.portOf(forwardServer)
  }

  static async connect(
    auth: RemoteHostSshAuth,
    options: ConnectOptions,
  ): Promise<RemoteHostSshConnection> {
    const knownHosts = options.knownHosts ?? remoteHostKnownHostStore
    const client: RemoteHostSshClientLike =
      options.clientFactory?.() ?? (new Client() as unknown as RemoteHostSshClientLike)
    let hostCheck: RemoteHostHostKeyCheck | null = null
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
        const timer = setTimeout(() => finish(new Error('SSH 连接超时')), readyTimeoutMs)
        client.on('ready', () => finish())
        client.on('error', (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err))
          if (hostCheck?.status === 'unknown') {
            finish(new RemoteHostSshHostKeyChallengeError(hostCheck.challenge!, hostCheck.fingerprint))
          } else if (hostCheck?.status === 'changed') {
            finish(new RemoteHostSshHostKeyChangedError(hostCheck.fingerprint))
          } else {
            finish(new Error(`SSH 连接失败: ${error.message}`))
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

    let forwardServer: Server | undefined
    try {
      forwardServer = await this.createForwarder(client, options.remoteHostPort)
      return new RemoteHostSshConnection(client, forwardServer)
    } catch (error) {
      await closeServer(forwardServer)
      client.end()
      throw error
    }
  }

  private static async createForwarder(
    client: RemoteHostSshClientLike,
    remotePort: number,
  ): Promise<Server> {
    const server = createServer((socket) => {
      client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        '127.0.0.1',
        remotePort,
        (error, stream) => {
          if (error || !stream) {
            socket.destroy()
            return
          }
          socket.pipe(stream).pipe(socket)
        },
      )
    })
    return new Promise<Server>((resolve, reject) => {
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve(server)
      })
    })
  }

  private portOf(server: Server | undefined): number | undefined {
    if (!server) return undefined
    const addr = server.address()
    if (addr && typeof addr === 'object') return addr.port
    return undefined
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const s of this.sockets) {
      try { s.destroy() } catch { /* ignore */ }
    }
    this.sockets.clear()
    await closeServer(this.forwardServer)
    this.client.end()
  }
}
