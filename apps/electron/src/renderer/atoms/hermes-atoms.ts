/**
 * Hermes Remote 状态管理（Jotai）
 *
 * 管理 Hermes target 列表、加载状态与 active target。
 * 所有凭据操作只经 IPC 主进程（window.electronAPI.hermes.*），
 * 凭据明文绝不进入 Renderer 状态。
 */

import { atom } from 'jotai'
import type {
  HermesTarget,
  HermesTargetCreateInput,
  HermesTargetUpdateInput,
} from '@proma/shared'

/** Hermes target 列表（不含任何明文凭据） */
export const hermesTargetsAtom = atom<HermesTarget[]>([])

/** 是否已加载 */
export const hermesTargetsLoadedAtom = atom(false)

/** 当前 active target id（Hermes 会话绑定时使用） */
export const activeHermesTargetIdAtom = atom<string | null>(null)

/** 当前 active target 对象 */
export const activeHermesTargetAtom = atom<HermesTarget | null>((get) => {
  const id = get(activeHermesTargetIdAtom)
  if (!id) return null
  return get(hermesTargetsAtom).find((target) => target.id === id) ?? null
})

/**
 * 从主进程加载 Hermes target 列表。
 */
export async function loadHermesTargets(): Promise<HermesTarget[]> {
  const targets = await window.electronAPI.hermes.listTargets()
  return targets
}

/**
 * 创建 Hermes target（通过 IPC）。
 */
export async function createHermesTarget(input: HermesTargetCreateInput): Promise<HermesTarget> {
  return await window.electronAPI.hermes.createTarget(input)
}

/**
 * 更新 Hermes target（通过 IPC）。
 */
export async function updateHermesTarget(
  id: string,
  input: HermesTargetUpdateInput,
): Promise<HermesTarget> {
  return await window.electronAPI.hermes.updateTarget(id, input)
}

/**
 * 删除 Hermes target（通过 IPC；主进程同步清理关联凭据）。
 */
export async function deleteHermesTarget(id: string): Promise<boolean> {
  const result = await window.electronAPI.hermes.deleteTarget(id)
  return result.ok
}

/**
 * 每个 target 隐藏的远端项目 id（Hermes Desktop 式「隐藏项目文件夹」）。
 * key: targetId → hidden project ids；从 settings.json 加载。
 */
export const hermesHiddenProjectsAtom = atom<Record<string, string[]>>({})

/** 侧栏 Hermes 远端区域高度（px，可拖动分割线调整；从 settings.json 加载） */
export const hermesRemotePanelHeightAtom = atom<number>(220)
