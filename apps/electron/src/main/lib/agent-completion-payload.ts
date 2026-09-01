import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type {
  AgentSendInput,
  AgentStreamCompletePayload,
} from '@proma/shared'

export type AgentStreamCompletionDetails = Omit<
  AgentStreamCompletePayload,
  'sessionId' | 'triggeredBy'
>

export interface AgentStreamCompleteTarget {
  send(channel: string, payload: AgentStreamCompletePayload): void
}

/** UI completion 不读取历史；只有明确需要摘要的 headless 调用方才执行 loader。 */
export function loadCompletionMessagesIfRequested<T>(include: boolean | undefined, loader: () => T): T | undefined {
  return include ? loader() : undefined
}

export function buildAgentStreamCompletePayload(
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'> & { runGeneration?: number }>,
  details: AgentStreamCompletionDetails = {},
): AgentStreamCompletePayload {
  const { runGeneration, ...otherDetails } = details
  return {
    sessionId: run.sessionId,
    triggeredBy: run.triggeredBy,
    ...otherDetails,
    ...(runGeneration != null ? { runGeneration } : run.runGeneration != null ? { runGeneration: run.runGeneration } : {}),
  }
}

export function sendAgentStreamComplete(
  target: AgentStreamCompleteTarget,
  run: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'> & { runGeneration?: number }>,
  details: AgentStreamCompletionDetails = {},
): void {
  target.send(
    AGENT_IPC_CHANNELS.STREAM_COMPLETE,
    buildAgentStreamCompletePayload(run, details),
  )
}
