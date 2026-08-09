import { describe, expect, test } from 'bun:test'
import type { HermesPublicTarget } from '@proma/shared'
import { isCurrentHermesTarget, resolveHermesSwitchProtocol } from './agent-runtime-switch'

function target(
  id: string,
  endpoints: HermesPublicTarget['endpoints'],
): HermesPublicTarget {
  return {
    id,
    name: id,
    mode: 'direct',
    endpoints,
    auth: {},
    credentialState: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('Agent runtime switch', () => {
  test('Given Dashboard endpoint When selecting Hermes Then binds Dashboard explicitly', () => {
    expect(resolveHermesSwitchProtocol(target('dashboard', {
      dashboard: { baseUrl: 'http://127.0.0.1:9119' },
      apiServer: { baseUrl: 'http://127.0.0.1:8642' },
    }))).toBe('dashboard')
  })

  test('Given API Server only target When selecting Hermes Then binds API Server explicitly', () => {
    expect(resolveHermesSwitchProtocol(target('api', {
      apiServer: { baseUrl: 'http://127.0.0.1:8642' },
    }))).toBe('api-server')
  })

  test('Given legacy target without endpoints When selecting Hermes Then keeps Dashboard compatibility', () => {
    expect(resolveHermesSwitchProtocol(target('legacy', undefined))).toBe('dashboard')
  })

  test('Given current Hermes session When selecting same target Then does not create another session', () => {
    expect(isCurrentHermesTarget('hermes-remote', 'target-a', 'target-a')).toBe(true)
    expect(isCurrentHermesTarget('hermes-remote', 'target-a', 'target-b')).toBe(false)
    expect(isCurrentHermesTarget('pi', undefined, 'target-a')).toBe(false)
  })
})
