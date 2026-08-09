import { describe, expect, test } from 'bun:test'
import {
  parseDashboardWireMessage,
  isGatewayReadyEvent,
  type HermesDashboardEvent,
} from './hermes-dashboard-contract'

describe('Hermes Dashboard wire contract', () => {
  test('Given gateway.ready fixture When parse Then 识别全局 ready', () => {
    const value = parseDashboardWireMessage(JSON.stringify({
      jsonrpc: '2.0', method: 'event',
      params: { type: 'gateway.ready', payload: { skin: {}, change_events: true } },
    }))
    expect(value?.kind).toBe('event')
    expect(isGatewayReadyEvent(value as HermesDashboardEvent)).toBe(true)
  })

  test('Given session event When parse Then 保留 runtime session identity 与 payload', () => {
    const value = parseDashboardWireMessage(JSON.stringify({
      jsonrpc: '2.0', method: 'event',
      params: { type: 'message.delta', session_id: 'run-1', payload: { text: 'hi' } },
    }))
    expect(value).toEqual({ kind: 'event', type: 'message.delta', sessionId: 'run-1', payload: { text: 'hi' } })
  })

  test('Given response/error When parse Then 使用原始 id 不做文本 dedupe', () => {
    expect(parseDashboardWireMessage('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}')).toEqual({ kind: 'response', id: 7, result: { ok: true } })
    expect(parseDashboardWireMessage('{"jsonrpc":"2.0","id":8,"error":{"code":4006,"message":"session not found"}}')).toEqual({ kind: 'response', id: 8, error: { code: 4006, message: 'session not found' } })
  })

  test('Given malformed/unknown notification When parse Then fail closed', () => {
    expect(parseDashboardWireMessage('not json')).toBeNull()
    expect(parseDashboardWireMessage('{"jsonrpc":"1.0","method":"event","params":{}}')).toBeNull()
    expect(parseDashboardWireMessage('{"jsonrpc":"2.0","method":"other","params":{}}')).toBeNull()
    expect(parseDashboardWireMessage('{"jsonrpc":"2.0","method":"event","params":{"payload":{}}}')).toBeNull()
  })
})
