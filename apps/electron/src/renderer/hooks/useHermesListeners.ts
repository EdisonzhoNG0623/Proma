/**
 * Hermes Remote 全局监听与初始化
 *
 * 在应用启动时加载 Hermes target 列表到 Jotai。
 * 首版无主进程推送事件（target 变更由 UI 操作后主动刷新）；预留事件订阅扩展点。
 */

import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { hermesTargetsAtom, hermesTargetsLoadedAtom } from '@/atoms/hermes-atoms'

/**
 * Hermes 初始化器：应用启动时加载 target 列表。
 *
 * 建议挂载在 renderer/main.tsx 的初始化组件中（类似 AgentSettingsInitializer）。
 */
export function useHermesTargetsInitializer(): void {
  const setTargets = useSetAtom(hermesTargetsAtom)
  const setLoaded = useSetAtom(hermesTargetsLoadedAtom)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.hermes
      .listTargets()
      .then((targets) => {
        if (cancelled) return
        setTargets(targets)
      })
      .catch((error) => {
        console.error('[Hermes] 加载 target 列表失败:', error)
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [setTargets, setLoaded])
}
