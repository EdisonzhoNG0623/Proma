import { describe, expect, test } from 'bun:test'
import { agentRuntimePolicy, isLocalAgentRuntime } from './agent-runtime-policy'

describe('agentRuntimePolicy', () => {
  test('Given Hermes Remote When 读取 policy Then 禁止所有本地上下文和 fallback', () => {
    expect(agentRuntimePolicy('hermes-remote')).toEqual({
      requiresLocalWorkspace: false,
      requiresLocalChannel: false,
      injectsLocalContext: false,
      buildsLocalTools: false,
      allowsLocalFallback: false,
    })
  })

  test('Given Claude/Pi When 读取 policy Then 保持本地执行能力', () => {
    for (const runtime of ['claude', 'pi'] as const) {
      expect(agentRuntimePolicy(runtime)).toEqual({
        requiresLocalWorkspace: true,
        requiresLocalChannel: true,
        injectsLocalContext: true,
        buildsLocalTools: true,
        allowsLocalFallback: false,
      })
    }
  })
})

describe('isLocalAgentRuntime', () => {
  test('Given Automation runtime When 校验 Then 只接受 Claude/Pi', () => {
    expect(isLocalAgentRuntime('claude')).toBe(true)
    expect(isLocalAgentRuntime('pi')).toBe(true)
    expect(isLocalAgentRuntime('hermes-remote')).toBe(false)
    expect(isLocalAgentRuntime('unknown')).toBe(false)
  })
})
