import type { SDKMessage } from '@proma/shared'

export function getSDKMessageUuid(message: SDKMessage): string | null {
  const uuid = (message as unknown as { uuid?: unknown }).uuid
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null
}

export function findLastStableSDKMessageUuid(messages: SDKMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const metadata = message as unknown as { _promaOptimistic?: boolean }
    if (metadata._promaOptimistic) continue
    const uuid = getSDKMessageUuid(message)
    if (uuid) return uuid
  }
  return null
}

/**
 * 用主进程返回的 canonical tail 替换边界后的乐观/旧尾段，并保留历史前缀对象引用。
 */
export function reconcileSDKMessagesAfterBoundary(
  previous: SDKMessage[],
  boundaryUuid: string,
  canonicalTail: SDKMessage[],
): SDKMessage[] | null {
  const boundaryIndex = previous.findLastIndex((message) => getSDKMessageUuid(message) === boundaryUuid)
  if (boundaryIndex < 0) return null
  return [...previous.slice(0, boundaryIndex + 1), ...canonicalTail]
}

/**
 * 将包含稳定边界的 canonical 末页拼回已加载历史；边界不在该页时返回 null，
 * 由调用方退回该 canonical 页及其分页游标。
 */
export function reconcileSDKMessagesWithCanonicalPage(
  previous: SDKMessage[],
  boundaryUuid: string,
  canonicalPage: SDKMessage[],
): SDKMessage[] | null {
  const boundaryIndex = canonicalPage.findLastIndex(
    (message) => getSDKMessageUuid(message) === boundaryUuid,
  )
  if (boundaryIndex < 0) return null
  return reconcileSDKMessagesAfterBoundary(
    previous,
    boundaryUuid,
    canonicalPage.slice(boundaryIndex + 1),
  )
}
