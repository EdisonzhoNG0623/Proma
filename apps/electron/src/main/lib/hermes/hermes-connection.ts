import type { HermesProtocol, HermesTarget } from '@proma/shared'
import type { HermesDashboardPasswordCredential } from './hermes-runtime-facade'
import { HermesEndpointManager, hermesEndpointManager } from './hermes-endpoint-manager'
import type { HermesTransport } from './transport/hermes-transport'

export function parseDashboardPasswordSecret(secret: string): HermesDashboardPasswordCredential {
  const trimmed = secret.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { username?: unknown; password?: unknown }
      return {
        username: typeof parsed.username === 'string' ? parsed.username : '',
        password: typeof parsed.password === 'string' ? parsed.password : '',
      }
    } catch {
      // legacy pure-password fallback
    }
  }
  return { username: '', password: secret }
}

/**
 * Legacy call-site bridge. Protocol selection is explicit and EndpointManager owns lifetime;
 * dispose() only releases this lease and never directly tears down a shared transport.
 */
export async function buildHermesTransport(
  target: HermesTarget,
  protocol: HermesProtocol = 'dashboard',
  manager: HermesEndpointManager = hermesEndpointManager,
): Promise<HermesTransport> {
  const lease = await manager.acquire(target)
  const shared = protocol === 'dashboard' ? lease.dashboard : lease.apiServer
  if (!shared) {
    lease.release()
    throw new Error(`Hermes target 未配置 ${protocol} endpoint`)
  }
  let released = false
  return {
    baseUrl: shared.baseUrl,
    requestJson: (path, options) => shared.requestJson(path, options),
    openSse: (path, options) => shared.openSse(path, options),
    connectWebSocket: (path, options) => shared.connectWebSocket(path, options),
    dispose: () => {
      if (released) return
      released = true
      lease.release()
    },
  }
}
