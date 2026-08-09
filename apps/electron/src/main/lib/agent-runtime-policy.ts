import type { AgentRuntime, LocalAgentRuntime } from '@proma/shared'

/** 不同 Agent runtime 在主进程编排层允许使用的本地能力。 */
export interface AgentRuntimePolicy {
  requiresLocalWorkspace: boolean
  requiresLocalChannel: boolean
  injectsLocalContext: boolean
  buildsLocalTools: boolean
  allowsLocalFallback: boolean
}

const LOCAL_RUNTIME_POLICY: AgentRuntimePolicy = {
  requiresLocalWorkspace: true,
  requiresLocalChannel: true,
  injectsLocalContext: true,
  buildsLocalTools: true,
  allowsLocalFallback: false,
}

const HERMES_RUNTIME_POLICY: AgentRuntimePolicy = {
  requiresLocalWorkspace: false,
  requiresLocalChannel: false,
  injectsLocalContext: false,
  buildsLocalTools: false,
  allowsLocalFallback: false,
}

export function agentRuntimePolicy(runtime: AgentRuntime): AgentRuntimePolicy {
  return runtime === 'hermes-remote' ? HERMES_RUNTIME_POLICY : LOCAL_RUNTIME_POLICY
}

export function isLocalAgentRuntime(value: unknown): value is LocalAgentRuntime {
  return value === 'claude' || value === 'pi'
}
