import { describe, expect, test } from 'bun:test'
import { buildAgentStreamCompletePayload, loadCompletionMessagesIfRequested } from './agent-completion-payload'

describe('Agent lightweight completion', () => {
  test('Given UI completion When messages are not requested Then history loader is never executed', () => {
    let reads = 0
    const messages = loadCompletionMessagesIfRequested(false, () => {
      reads += 1
      return ['huge-history']
    })

    expect(messages).toBeUndefined()
    expect(reads).toBe(0)
  })

  test('Given headless summary completion When messages are requested Then loads history once', () => {
    let reads = 0
    const messages = loadCompletionMessagesIfRequested(true, () => {
      reads += 1
      return ['summary-source']
    })

    expect(messages).toEqual(['summary-source'])
    expect(reads).toBe(1)
  })

  test('Given renderer completion payload When built Then contains metadata only', () => {
    const payload = buildAgentStreamCompletePayload(
      { sessionId: 'session-1', triggeredBy: 'user' },
      { stoppedByUser: false, resultSubtype: 'success' },
    )

    expect(payload).toEqual({
      sessionId: 'session-1',
      triggeredBy: 'user',
      stoppedByUser: false,
      resultSubtype: 'success',
    })
    expect('messages' in payload).toBe(false)
  })
})
