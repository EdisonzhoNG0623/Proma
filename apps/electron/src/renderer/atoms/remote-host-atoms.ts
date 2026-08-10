/**
 * Remote Host Jotai Atoms
 *
 * Renderer 侧 Remote Host 状态管理：target 列表、激活 target。
 * 所有凭据操作通过 IPC 交给主进程，Renderer 不接触明文 token/SSH 密钥。
 */

import { atom } from 'jotai'
import type { RemoteHostPublicTarget, RemoteHostHello } from '@proma/shared'

export const remoteHostTargetsAtom = atom<RemoteHostPublicTarget[]>([])
export const remoteHostTargetsLoadedAtom = atom(false)
export const activeRemoteHostTargetIdAtom = atom<string | null>(null)

export const activeRemoteHostTargetAtom = atom<RemoteHostPublicTarget | null>((get) => {
  const id = get(activeRemoteHostTargetIdAtom)
  if (!id) return null
  return get(remoteHostTargetsAtom).find((t) => t.id === id) ?? null
})

export async function loadRemoteHostTargets(): Promise<RemoteHostPublicTarget[]> {
  const targets = await window.electronAPI.remoteHost.listTargets()
  return targets
}

export async function createRemoteHostTarget(
  input: Parameters<typeof window.electronAPI.remoteHost.createTarget>[0],
): Promise<RemoteHostPublicTarget> {
  return await window.electronAPI.remoteHost.createTarget(input)
}

export async function updateRemoteHostTarget(
  id: string,
  input: Parameters<typeof window.electronAPI.remoteHost.updateTarget>[1],
): Promise<RemoteHostPublicTarget> {
  return await window.electronAPI.remoteHost.updateTarget(id, input)
}

export async function deleteRemoteHostTarget(id: string): Promise<void> {
  await window.electronAPI.remoteHost.deleteTarget(id)
}

export async function probeRemoteHostTarget(id: string): Promise<RemoteHostHello> {
  const { hello } = await window.electronAPI.remoteHost.probeTarget(id)
  return hello
}

export async function confirmRemoteHostKey(token: string, host: string, port: number): Promise<void> {
  await window.electronAPI.remoteHost.confirmHostKey(token, host, port)
}
