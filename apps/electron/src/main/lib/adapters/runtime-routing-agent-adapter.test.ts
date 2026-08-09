import { describe, expect, test } from 'bun:test'
import type { AgentProviderAdapter, AgentRuntime, SDKMessage } from '@proma/shared'
import { RuntimeRoutingAgentAdapter } from './runtime-routing-agent-adapter'

function fake() {
  const calls = { query: 0, abort: 0, interrupt: 0, dispose: 0 }
  const adapter: AgentProviderAdapter = {
    async *query(): AsyncIterable<SDKMessage> { calls.query += 1 },
    abort: () => { calls.abort += 1 },
    interruptQuery: async () => { calls.interrupt += 1 },
    dispose: () => { calls.dispose += 1 },
  }
  return { adapter, calls }
}

function setup() {
  const claude = fake(); const pi = fake(); const hermes = fake()
  const router = new RuntimeRoutingAgentAdapter({
    claude: claude.adapter,
    pi: pi.adapter,
    'hermes-remote': hermes.adapter,
  } as Record<AgentRuntime, AgentProviderAdapter>)
  return { router, claude, pi, hermes }
}

describe('RuntimeRoutingAgentAdapter fail-closed routing', () => {
  test('Given Hermes query When interrupt Then 只路由 Hermes', async () => {
    const ctx = setup()
    const iterator = ctx.router.query({ sessionId: 's', prompt: 'x', agentRuntime: 'hermes-remote' })[Symbol.asyncIterator]()
    await ctx.router.interruptQuery('s')
    expect(ctx.hermes.calls.interrupt).toBe(1)
    expect(ctx.claude.calls.interrupt).toBe(0)
    await iterator.return?.()
  })

  test('Given unknown session When semantic operation Then fail closed 不默认 Claude', async () => {
    const ctx = setup()
    await expect(ctx.router.interruptQuery('missing')).rejects.toThrow('runtime binding')
    expect(ctx.claude.calls.interrupt).toBe(0)
  })

  test('Given unknown emergency abort When abort Then 覆盖所有 adapters 包括 Hermes', () => {
    const ctx = setup()
    ctx.router.abort('missing')
    expect(ctx.claude.calls.abort).toBe(1)
    expect(ctx.pi.calls.abort).toBe(1)
    expect(ctx.hermes.calls.abort).toBe(1)
  })

  test('Given dispose When 调用 Then 三个 runtime 各 dispose 一次', () => {
    const ctx = setup()
    ctx.router.dispose()
    expect(ctx.claude.calls.dispose).toBe(1)
    expect(ctx.pi.calls.dispose).toBe(1)
    expect(ctx.hermes.calls.dispose).toBe(1)
  })
})
