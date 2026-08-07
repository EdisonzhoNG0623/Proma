import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FolderOpen, MessageSquarePlus, Server, RefreshCw } from 'lucide-react'
import { hermesTargetsAtom, activeHermesTargetIdAtom } from '@/atoms/hermes-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { useOpenSession } from '@/hooks/useOpenSession'
import { getOrCreateWorkspaceForProject } from '@/lib/hermes-workspace-helper'
import type { HermesRemoteProject } from '@proma/shared'

/**
 * 侧栏「Hermes 远端项目」虚拟区块。
 * 列出远端 Hermes 的项目（projects.tree，走协议无需 SSH）：
 * - 点击项目 → 打开 Hermes 设置（远端会话视图）
 * - 「新建对话」→ 创建 cwd 绑定项目目录的 Hermes 会话
 * 目标是多电脑共享远端状态：项目活在远端，Proma 只是前端入口。
 */
export function HermesSidebarProjects(): React.ReactElement | null {
  const targets = useAtomValue(hermesTargetsAtom)
  const activeTargetId = useAtomValue(activeHermesTargetIdAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const openSession = useOpenSession()

  const [projects, setProjects] = React.useState<HermesRemoteProject[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [startingChatId, setStartingChatId] = React.useState<string | null>(null)

  const target = targets.find((t) => t.id === activeTargetId) ?? targets[0]

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!target) {
      setProjects(null)
      return
    }
    setLoading(true)
    try {
      setProjects(await window.electronAPI.hermes.listRemoteProjects(target.id))
    } catch (error) {
      console.error('[Hermes] 加载远端项目失败:', error)
      setProjects(null)
    } finally {
      setLoading(false)
    }
  }, [target])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  if (!target) return null

  /** 在项目目录新建 Hermes 对话：先复用/创建同名本地项目文件夹，会话挂到其下（cwd 仍为远端项目目录） */
  const handleNewChat = async (project: HermesRemoteProject): Promise<void> => {
    setStartingChatId(project.id)
    try {
      // 1. 本地 Agent 项目文件夹：同名已存在则复用，否则创建
      const workspace = await getOrCreateWorkspaceForProject(project.label)
      // 2. 在该项目文件夹下创建远端会话（cwd 绑定远端项目目录）
      const created = await window.electronAPI.hermes.createRemoteSession({
        targetId: target.id,
        remoteCwd: project.path || undefined,
        title: `${project.label} 对话`,
        workspaceId: workspace.id,
      })
      setAgentSessions(await window.electronAPI.listAgentSessions())
      setSettingsOpen(false)
      setAppMode('agent')
      setActiveView('conversations')
      openSession('agent', created.id, created.title, { bypassSettingsGuard: true })
    } catch (error) {
      console.error('[Hermes] 新建对话失败:', error)
      window.alert(`新建对话失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setStartingChatId(null)
    }
  }

  /** 打开 Hermes 设置（远端会话视图） */
  const handleOpenSettings = (): void => {
    setSettingsTab('hermes')
    setSettingsOpen(true)
  }

  return (
    <div className="mt-1 border-t border-foreground/[0.06] pt-1">
      <button
        type="button"
        onClick={handleOpenSettings}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-medium text-foreground/40 select-none hover:text-foreground/70"
      >
        <Server size={11} />
        Hermes 远端
        <span className="ml-auto flex items-center gap-0.5">
          <RefreshCw size={10} className="opacity-60" onClick={(e) => { e.stopPropagation(); void refresh() }} />
        </span>
      </button>
      {loading && projects === null ? (
        <div className="px-3 py-1 text-[11px] text-foreground/30">加载项目...</div>
      ) : projects === null || projects.length === 0 ? (
        <div className="px-3 py-1 text-[11px] text-foreground/30">
          {projects === null ? '项目加载失败' : '远端暂无项目'}
        </div>
      ) : (
        <div className="flex flex-col">
          {projects.map((project) => (
            <div key={project.id} className="group flex items-center gap-1 px-3 py-1 hover:bg-accent/40">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] text-foreground/70"
                onClick={handleOpenSettings}
                title={project.path}
              >
                <FolderOpen size={12} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{project.label}</span>
              </button>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
                title="在此项目新建 Hermes 对话"
                onClick={() => void handleNewChat(project)}
                disabled={startingChatId === project.id}
              >
                {startingChatId === project.id ? (
                  <span className="text-[10px]">创建中</span>
                ) : (
                  <MessageSquarePlus size={12} />
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
