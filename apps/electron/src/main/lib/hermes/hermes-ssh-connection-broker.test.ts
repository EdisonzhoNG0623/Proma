import { describe, expect, test } from 'bun:test'
import type { HermesTarget } from '@proma/shared'
import { HermesSshConnectionBroker } from './hermes-ssh-connection-broker'
import type { HermesSshConnection } from './transport/hermes-ssh-connection'

const target: HermesTarget = {
  id: 'ssh-1', name: 'ssh', mode: 'ssh-tunnel',
  endpoints: { dashboard: { remotePort: 9119 }, apiServer: { remotePort: 8642 } },
  ssh: { host: 'vps.example.com', port: 22, username: 'deploy' },
  auth: {}, createdAt: 1, updatedAt: 1,
}

describe('HermesSshConnectionBroker ownership', () => {
  test('Given endpoint+SFTP 并发 leases When acquire Then 共享单一 ssh2 connection', async () => {
    let connects = 0; let closes = 0
    const connection = { close: async () => { closes += 1 } } as unknown as HermesSshConnection
    const broker = new HermesSshConnectionBroker({
      idleTtlMs: 10,
      connect: async () => { connects += 1; return connection },
    })
    const [endpoint, sftp] = await Promise.all([broker.acquire(target), broker.acquire(target)])
    expect(connects).toBe(1)
    expect(endpoint.connection).toBe(sftp.connection)
    endpoint.release()
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(closes).toBe(0)
    sftp.release()
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(closes).toBe(1)
  })

  test('Given target invalidated When active lease exists Then 立即关闭旧 connection', async () => {
    let closes = 0
    const broker = new HermesSshConnectionBroker({
      connect: async () => ({ close: async () => { closes += 1 } }) as unknown as HermesSshConnection,
    })
    const lease = await broker.acquire(target)
    broker.invalidate(target.id)
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(closes).toBe(1)
    lease.release()
  })
})
