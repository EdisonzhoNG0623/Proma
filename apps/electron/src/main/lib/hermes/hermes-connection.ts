/**
 * Hermes 连接工厂
 *
 * 为 HermesRuntimeFacade 提供真实依赖：
 * - buildHermesTransport：按 target.mode 构建 Direct 或 SSH Tunnel 传输；
 * - readHermesDashboardPassword：解析 dashboard-password 凭据（约定 JSON 或纯密码）。
 *
 * 安全约束：密码解析后仅存在于调用栈中，不缓存、不入日志。
 */

import type { HermesTarget } from '@proma/shared'
import { HermesDirectTransport } from './transport/hermes-direct-transport'
import { HermesSshTunnelManager, type HermesSshTunnelHandle } from './transport/hermes-ssh-tunnel'
import type { HermesTransport } from './transport/hermes-transport'
import type { HermesDashboardPasswordCredential } from './hermes-runtime-facade'

/**
 * 解析 dashboard-password 凭据。
 *
 * 支持两种格式：
 * - JSON：{"username":"...","password":"..."}（推荐）
 * - 纯密码：secret 即密码（历史兼容；username 为空）
 */
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
      // 回退到纯密码
    }
  }
  return { username: '', password: secret }
}

/** SSH 隧道句柄容器（生命周期由 transport dispose 管理） */
export interface HermesTunneledTransport {
  transport: HermesTransport
  tunnel?: HermesSshTunnelHandle
}

/**
 * 构建 target 的 transport。
 *
 * - direct：直接使用 remoteUrl；
 * - ssh-tunnel：先建立隧道，再基于 127.0.0.1 本地端口构建 transport。
 *
 * @returns transport（调用方负责 dispose；SSH 隧道随 dispose 关闭）
 */
export async function buildHermesTransport(
  target: HermesTarget,
  sshTunnelManager: HermesSshTunnelManager = new HermesSshTunnelManager(),
): Promise<HermesTransport> {
  if (target.mode === 'direct') {
    if (!target.remoteUrl) {
      throw new Error('Direct 模式缺少远端 URL')
    }
    return new HermesDirectTransport(target.remoteUrl)
  }

  if (target.mode === 'ssh-tunnel') {
    if (!target.ssh) {
      throw new Error('SSH Tunnel 模式缺少 SSH 配置')
    }
    const tunnel = await sshTunnelManager.openTunnel(target.ssh, {
      hostKeyMode: 'confirm',
    })
    const dashboardBase = `http://127.0.0.1:${tunnel.localDashboardPort}/`
    const transport = new HermesDirectTransport(dashboardBase)
    // 包装 dispose：关闭隧道（不停止远端 Hermes）
    const originalDispose = transport.dispose.bind(transport)
    transport.dispose = () => {
      originalDispose()
      void tunnel.close()
    }
    return transport
  }

  throw new Error(`未知的 Hermes 连接模式: ${String(target.mode)}`)
}
