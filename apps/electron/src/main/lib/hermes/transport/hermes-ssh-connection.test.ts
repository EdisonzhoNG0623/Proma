import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectConfig } from 'ssh2'
import { HermesKnownHostStore } from '../hermes-known-host-store'
import {
  HermesSshConnection,
  HermesSshHostKeyChallengeError,
  HermesSshHostKeyChangedError,
  type HermesSshClientLike,
} from './hermes-ssh-connection'

class FakeClient extends EventEmitter implements HermesSshClientLike {
  connectCalls = 0
  ended = false
  constructor(private readonly key: Buffer) { super() }
  connect(config: ConnectConfig): void {
    this.connectCalls += 1
    let accepted = false
    const verify = config.hostVerifier as unknown as (key: Buffer, callback: (value: boolean) => void) => void
    verify(this.key, (value) => { accepted = value })
    queueMicrotask(() => accepted ? this.emit('ready') : this.emit('error', new Error('host denied')))
  }
  forwardOut(...args: unknown[]): void {
    const callback = args.at(-1) as (error: Error | undefined) => void
    callback(new Error('not used'))
  }
  sftp(callback: (error: Error | undefined) => void): void { callback(new Error('not used')) }
  end(): void { this.ended = true; this.emit('close') }
}

function setup(): { store: HermesKnownHostStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'proma-hermes-ssh-'))
  return { store: new HermesKnownHostStore(join(dir, 'hosts.json')), dir }
}

const config = { host: 'vps.example.com', port: 22, username: 'deploy' }

describe('HermesSshConnection host trust and lifecycle', () => {
  test('Given 首次 host key When connect Then 返回 challenge 且本次握手失败', async () => {
    const { store, dir } = setup()
    try {
      const client = new FakeClient(Buffer.from('key-a'))
      const error = await HermesSshConnection.connect(config, {
        knownHosts: store,
        clientFactory: () => client,
        endpoints: { dashboard: 9119 },
      }).catch((value: unknown) => value)
      expect(error).toBeInstanceOf(HermesSshHostKeyChallengeError)
      expect((error as HermesSshHostKeyChallengeError).fingerprint).toStartWith('SHA256:')
      expect((error as HermesSshHostKeyChallengeError).challenge).toBeTruthy()
      expect(client.ended).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('Given challenge 已确认 When 重连 Then 单 client 建两个 loopback forwarder', async () => {
    const { store, dir } = setup()
    try {
      const firstClient = new FakeClient(Buffer.from('key-a'))
      const first = await HermesSshConnection.connect(config, {
        knownHosts: store,
        clientFactory: () => firstClient,
        endpoints: { dashboard: 9119 },
      }).catch((value: unknown) => value)
      expect(first).toBeInstanceOf(HermesSshHostKeyChallengeError)
      store.confirm((first as HermesSshHostKeyChallengeError).challenge)

      const client = new FakeClient(Buffer.from('key-a'))
      const connection = await HermesSshConnection.connect(config, {
        knownHosts: store,
        clientFactory: () => client,
        endpoints: { dashboard: 9119, apiServer: 8642 },
      })
      expect(client.connectCalls).toBe(1)
      expect(connection.localDashboardPort).toBeGreaterThan(0)
      expect(connection.localApiServerPort).toBeGreaterThan(0)
      await connection.close()
      expect(client.ended).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('Given trusted key 变化 When connect Then 100% 阻断', async () => {
    const { store, dir } = setup()
    try {
      const unknown = store.check(config.host, config.port, Buffer.from('key-a'))
      store.confirm(unknown.challenge!)
      const error = await HermesSshConnection.connect(config, {
        knownHosts: store,
        clientFactory: () => new FakeClient(Buffer.from('key-b')),
        endpoints: { dashboard: 9119 },
      }).catch((value: unknown) => value)
      expect(error).toBeInstanceOf(HermesSshHostKeyChangedError)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
