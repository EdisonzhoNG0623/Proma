import { describe, expect, test } from 'bun:test'
import type { HermesSshTunnelConfig } from '@proma/shared'
import { HermesSshTunnelManager } from './hermes-ssh-tunnel'
import type { HermesSshConnection } from './hermes-ssh-connection'

const config: HermesSshTunnelConfig = {
  host: 'vps.example.com',
  port: 22,
  username: 'deploy',
  dashboardRemotePort: 9119,
  apiServerRemotePort: 8642,
}

describe('HermesSshTunnelManager ssh2 compatibility facade', () => {
  test('Given password/key options When open Then 只传内存 auth 且建立两个 endpoint', async () => {
    let captured: unknown
    let closed = false
    const connection = {
      localDashboardPort: 40001,
      localApiServerPort: 40002,
      close: async () => { closed = true },
    } as unknown as HermesSshConnection
    const manager = new HermesSshTunnelManager({
      connectionFactory: async (auth, options) => {
        captured = { auth, endpoints: options.endpoints }
        return connection
      },
    })
    const handle = await manager.openTunnel(config, {
      password: 'secret',
      privateKey: 'private-key',
      passphrase: 'passphrase',
    })
    expect(captured).toEqual({
      auth: {
        host: 'vps.example.com',
        port: 22,
        username: 'deploy',
        password: 'secret',
        privateKey: 'private-key',
        passphrase: 'passphrase',
      },
      endpoints: { dashboard: 9119, apiServer: 8642 },
    })
    expect(handle.processPid).toBeUndefined()
    await handle.close()
    expect(closed).toBe(true)
  })

  test('Given forwarder 不完整 When open Then fail closed 并关闭 connection', async () => {
    let closed = false
    const manager = new HermesSshTunnelManager({
      connectionFactory: async () => ({
        localDashboardPort: 40001,
        localApiServerPort: undefined,
        close: async () => { closed = true },
      } as unknown as HermesSshConnection),
    })
    await expect(manager.openTunnel(config)).rejects.toThrow('未完整建立')
    expect(closed).toBe(true)
  })
})
