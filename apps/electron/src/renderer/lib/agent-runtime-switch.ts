import type { AgentRuntime, HermesProtocol, HermesPublicTarget } from '@proma/shared'

/**
 * Runtime Selector 创建 Hermes 会话时必须一次性绑定协议。
 * Dashboard 优先；仅配置 API Server 时才选择 API Server。
 */
export function resolveHermesSwitchProtocol(target: HermesPublicTarget): HermesProtocol {
  if (target.endpoints?.dashboard) return 'dashboard'
  if (target.endpoints?.apiServer) return 'api-server'
  // 兼容从 V1 迁移、尚未物化 endpoints 的 Dashboard target。
  return 'dashboard'
}

/** 同一 Hermes Target 不需要重复创建并切换会话。 */
export function isCurrentHermesTarget(
  runtime: AgentRuntime,
  currentTargetId: string | undefined,
  selectedTargetId: string,
): boolean {
  return runtime === 'hermes-remote' && currentTargetId === selectedTargetId
}
