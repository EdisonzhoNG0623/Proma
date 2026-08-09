/**
 * Agent runtime 路由适配器。
 *
 * Orchestrator 只依赖 AgentProviderAdapter；这里按每个会话选择 Claude 或 Pi runtime。
 */

import type { AgentProviderAdapter, AgentQueryInput, AgentRuntime, SDKMessage, SDKUserMessageInput, SendQueuedMessageOptions } from '@proma/shared'

export class RuntimeRoutingAgentAdapter implements AgentProviderAdapter {
  private readonly sessionRuntimes = new Map<string, AgentRuntime>()

  constructor(private readonly adapters: Record<AgentRuntime, AgentProviderAdapter>) {}

  query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const runtime = input.agentRuntime ?? 'claude'
    const adapter = this.adapters[runtime]
    if (!adapter) throw new Error(`未知 Agent runtime: ${String(runtime)}`)
    this.sessionRuntimes.set(input.sessionId, runtime)
    const iterable = adapter.query(input)
    const bindings = this.sessionRuntimes
    return (async function* (): AsyncIterable<SDKMessage> {
      try {
        yield* iterable
      } finally {
        if (bindings.get(input.sessionId) === runtime) bindings.delete(input.sessionId)
      }
    })()
  }

  abort(sessionId: string): void {
    const runtime = this.sessionRuntimes.get(sessionId)
    if (runtime) {
      this.adapters[runtime].abort(sessionId)
      return
    }

    for (const adapter of new Set(Object.values(this.adapters))) adapter.abort(sessionId)
  }

  async interruptQuery(sessionId: string): Promise<void> {
    const adapter = this.getAdapter(sessionId)
    await adapter.interruptQuery?.(sessionId)
  }

  dispose(): void {
    for (const adapter of new Set(Object.values(this.adapters))) adapter.dispose()
    this.sessionRuntimes.clear()
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    const adapter = this.getAdapter(sessionId)
    if (!adapter.sendQueuedMessage) {
      throw new Error('当前 Agent runtime 不支持追加消息')
    }
    await adapter.sendQueuedMessage(sessionId, message, options)
  }

  async cancelQueuedMessage(sessionId: string, messageUuid: string): Promise<void> {
    const adapter = this.getAdapter(sessionId)
    await adapter.cancelQueuedMessage?.(sessionId, messageUuid)
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const adapter = this.getAdapter(sessionId)
    await adapter.setPermissionMode?.(sessionId, mode)
  }

  private getAdapter(sessionId: string): AgentProviderAdapter {
    const runtime = this.sessionRuntimes.get(sessionId)
    if (!runtime) throw new Error(`会话缺少 runtime binding: ${sessionId}`)
    const adapter = this.adapters[runtime]
    if (!adapter) throw new Error(`未知 Agent runtime: ${runtime}`)
    return adapter
  }
}
