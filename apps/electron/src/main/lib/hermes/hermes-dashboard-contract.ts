export interface HermesDashboardResponse {
  kind: 'response'
  id: number | string
  result?: unknown
  error?: { code?: number; message?: string }
}

export interface HermesDashboardEvent {
  kind: 'event'
  type: string
  sessionId?: string
  payload: unknown
}

export type HermesDashboardWireMessage = HermesDashboardResponse | HermesDashboardEvent

export function parseDashboardWireMessage(raw: string): HermesDashboardWireMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (message.jsonrpc !== '2.0') return null
  if (typeof message.id === 'number' || typeof message.id === 'string') {
    const error = message.error
    return {
      kind: 'response',
      id: message.id,
      ...(error && typeof error === 'object'
        ? {
            error: {
              code: typeof (error as Record<string, unknown>).code === 'number'
                ? (error as Record<string, unknown>).code as number
                : undefined,
              message: typeof (error as Record<string, unknown>).message === 'string'
                ? (error as Record<string, unknown>).message as string
                : undefined,
            },
          }
        : { result: message.result }),
    }
  }
  if (message.method !== 'event' || !message.params || typeof message.params !== 'object') return null
  const params = message.params as Record<string, unknown>
  if (typeof params.type !== 'string' || !params.type) return null
  return {
    kind: 'event',
    type: params.type,
    ...(typeof params.session_id === 'string' && params.session_id
      ? { sessionId: params.session_id }
      : {}),
    payload: params.payload,
  }
}

export function isGatewayReadyEvent(event: HermesDashboardEvent): boolean {
  return event.type === 'gateway.ready' && event.sessionId === undefined
}
