import type { Cookie, Session } from 'electron'
import { HermesDirectTransport } from './transport/hermes-direct-transport'

export interface HermesCookieSession {
  fetch(input: string, init?: RequestInit): Promise<Response>
  cookies: {
    get(filter: Record<string, never>): Promise<Array<Pick<Cookie, 'name' | 'domain' | 'path' | 'secure'>>>
    remove(url: string, name: string): Promise<void>
  }
  flushStorageData(): Promise<void> | void
}

type SessionFactory = (partition: string) => HermesCookieSession

export function hermesCookiePartition(targetId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(targetId)) throw new Error('Hermes targetId 无效')
  return `persist:proma-hermes-remote-${targetId}`
}

function defaultSessionFactory(partition: string): HermesCookieSession {
  // Lazy require keeps unit tests independent from Electron runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { session } = require('electron') as typeof import('electron')
  return session.fromPartition(partition) as Session
}

/** Electron partition owns RFC-compliant Dashboard cookies; token/API traffic never uses it. */
export class HermesCookieSessionManager {
  constructor(private readonly sessionFactory: SessionFactory = defaultSessionFactory) {}

  sessionFor(targetId: string): HermesCookieSession {
    return this.sessionFactory(hermesCookiePartition(targetId))
  }

  fetch(targetId: string, input: string, init?: RequestInit): Promise<Response> {
    return this.sessionFor(targetId).fetch(input, init)
  }

  createDashboardTransport(targetId: string, baseUrl: string): HermesDirectTransport {
    const cookieSession = this.sessionFor(targetId)
    return new HermesDirectTransport(baseUrl, {
      fetchImpl: (input, init) => cookieSession.fetch(input, init),
    })
  }

  async clear(targetId: string): Promise<void> {
    const value = this.sessionFor(targetId)
    const cookies = await value.cookies.get({})
    await Promise.all(cookies.map(async (cookie) => {
      if (!cookie.domain) return
      const domain = cookie.domain.replace(/^\./, '')
      const scheme = cookie.secure ? 'https' : 'http'
      const path = cookie.path?.startsWith('/') ? cookie.path : `/${cookie.path ?? ''}`
      await value.cookies.remove(`${scheme}://${domain}${path}`, cookie.name)
    }))
    await value.flushStorageData()
  }
}

export const hermesCookieSessionManager = new HermesCookieSessionManager()
