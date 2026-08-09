import { describe, expect, test } from 'bun:test'
import type { HermesTarget } from '@proma/shared'
import type { HermesTransport } from './transport/hermes-transport'
import {
  HermesEndpointManager,
  type HermesEndpointResource,
} from './hermes-endpoint-manager'

const target: HermesTarget = {
  id: 'target-a',
  name: 'a',
  mode: 'direct',
  endpoints: { dashboard: { baseUrl: 'https://dashboard.example.com' } },
  auth: {},
  createdAt: 1,
  updatedAt: 1,
}

function transport(baseUrl: string): HermesTransport {
  return {
    baseUrl,
    requestJson: async () => ({ status: 200, body: {} }),
    openSse: async () => ({ abort: () => undefined, done: Promise.resolve() }),
    connectWebSocket: async () => ({ socket: null, errorCode: null, errorMessage: null }),
    dispose: () => undefined,
  }
}

describe('HermesEndpointManager lease lifecycle', () => {
  test('Given 并发 acquire When build Then single-flight 且共享 generation', async () => {
    let builds = 0
    const manager = new HermesEndpointManager({
      idleTtlMs: 1_000,
      build: async (): Promise<HermesEndpointResource> => {
        builds += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { dashboard: transport('https://d.example.com'), dispose: async () => undefined }
      },
    })
    const [a, b] = await Promise.all([manager.acquire(target), manager.acquire(target)])
    expect(builds).toBe(1)
    expect(a.generation).toBe(b.generation)
    expect(a.dashboard).toBe(b.dashboard)
    a.release(); b.release()
    await manager.disposeAll()
  })

  test('Given 两个 lease When 释放一个 Then 不 dispose；归零 idle TTL 后关闭', async () => {
    let disposes = 0
    const manager = new HermesEndpointManager({
      idleTtlMs: 15,
      build: async () => ({ dashboard: transport('https://d'), dispose: async () => { disposes += 1 } }),
    })
    const a = await manager.acquire(target)
    const b = await manager.acquire(target)
    a.release()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(disposes).toBe(0)
    b.release()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(disposes).toBe(1)
  })

  test('Given build 未完成 When invalidate Then stale build 不能覆盖新 generation', async () => {
    let resolveFirst!: (resource: HermesEndpointResource) => void
    let builds = 0
    let staleDisposes = 0
    const manager = new HermesEndpointManager({
      build: async () => {
        builds += 1
        if (builds === 1) return await new Promise<HermesEndpointResource>((resolve) => { resolveFirst = resolve })
        return { dashboard: transport('https://new'), dispose: async () => undefined }
      },
    })
    const stale = manager.acquire(target)
    manager.invalidate(target.id)
    const fresh = await manager.acquire(target)
    resolveFirst({ dashboard: transport('https://old'), dispose: async () => { staleDisposes += 1 } })
    await expect(stale).rejects.toThrow('stale')
    expect(fresh.dashboard?.baseUrl).toBe('https://new')
    expect(staleDisposes).toBe(1)
    expect(fresh.generation).toBeGreaterThan(0)
    fresh.release()
    await manager.disposeAll()
  })

  test('Given release 重复调用 When 执行 Then refcount 只减少一次', async () => {
    let disposes = 0
    const manager = new HermesEndpointManager({
      idleTtlMs: 0,
      build: async () => ({ dashboard: transport('https://d'), dispose: async () => { disposes += 1 } }),
    })
    const lease = await manager.acquire(target)
    lease.release(); lease.release()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(disposes).toBe(1)
  })
})
