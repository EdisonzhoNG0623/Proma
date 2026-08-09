import { randomUUID } from 'node:crypto'
import type { HermesSshTunnelConfig } from '@proma/shared'
import { DEFAULT_HERMES_API_SERVER_PORT, DEFAULT_HERMES_DASHBOARD_PORT } from '../hermes-target-store'
import {
  HermesSshConnection,
  type HermesSshAuth,
} from './hermes-ssh-connection'
import { HermesKnownHostStore, hermesKnownHostStore } from '../hermes-known-host-store'

export interface HermesSshOpenOptions {
  /** legacy compatibility; trust is always explicit known-host verification. */
  hostKeyMode?: 'confirm' | 'strict'
  password?: string
  privateKey?: string
  passphrase?: string
  readyTimeoutMs?: number
}

export interface HermesSshTunnelHandle {
  readonly tunnelId: string
  readonly localDashboardPort: number
  readonly localApiServerPort: number
  readonly host: string
  readonly processPid: undefined
  readonly connection: HermesSshConnection
  close(): Promise<void>
  waitForReady(): Promise<void>
}

type ConnectionFactory = (
  auth: HermesSshAuth,
  options: {
    knownHosts: HermesKnownHostStore
    endpoints: { dashboard?: number; apiServer?: number }
    readyTimeoutMs?: number
  },
) => Promise<HermesSshConnection>

/** Compatibility facade backed by in-process ssh2; no child process, argv, ASKPASS, or env secret. */
export class HermesSshTunnelManager {
  private readonly knownHosts: HermesKnownHostStore
  private readonly connectionFactory: ConnectionFactory

  constructor(options: {
    knownHosts?: HermesKnownHostStore
    connectionFactory?: ConnectionFactory
  } = {}) {
    this.knownHosts = options.knownHosts ?? hermesKnownHostStore
    this.connectionFactory = options.connectionFactory ?? ((auth, connectOptions) =>
      HermesSshConnection.connect(auth, connectOptions))
  }

  async openTunnel(
    config: HermesSshTunnelConfig,
    options: HermesSshOpenOptions = {},
  ): Promise<HermesSshTunnelHandle> {
    const connection = await this.connectionFactory({
      host: config.host,
      port: config.port,
      username: config.username,
      password: options.password,
      privateKey: options.privateKey,
      passphrase: options.passphrase,
    }, {
      knownHosts: this.knownHosts,
      endpoints: {
        dashboard: config.dashboardRemotePort ?? DEFAULT_HERMES_DASHBOARD_PORT,
        apiServer: config.apiServerRemotePort ?? DEFAULT_HERMES_API_SERVER_PORT,
      },
      readyTimeoutMs: options.readyTimeoutMs,
    })
    if (!connection.localDashboardPort || !connection.localApiServerPort) {
      await connection.close()
      throw new Error('SSH endpoint forwarder 未完整建立')
    }
    return {
      tunnelId: randomUUID(),
      localDashboardPort: connection.localDashboardPort,
      localApiServerPort: connection.localApiServerPort,
      host: config.host,
      processPid: undefined,
      connection,
      close: () => connection.close(),
      waitForReady: async () => undefined,
    }
  }

  confirmHostKey(challenge: string, config: Pick<HermesSshTunnelConfig, 'host' | 'port'>): void {
    this.knownHosts.confirm(challenge, config)
  }
}

export const hermesSshTunnelManager = new HermesSshTunnelManager()
