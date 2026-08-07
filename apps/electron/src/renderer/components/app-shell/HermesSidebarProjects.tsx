import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { ChevronRight, EyeOff, FolderOpen, MessageSquare, MessageSquarePlus, Play, Server, RefreshCw } from 'lucide-react'
import { hermesTargetsAtom, activeHermesTargetIdAtom, hermesHiddenProjectsAtom, hermesRemotePanelHeightAtom } from '@/atoms/hermes-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { useOpenSession } from '@/hooks/useOpenSession'
import { getOrCreateWorkspaceForProject } from '@/lib/hermes-workspace-helper'
import { extractProjectSessions } from '@/lib/hermes-project-sessions'
import type { HermesRemoteProject, HermesRemoteSessionSummary } from '@proma/shared'

const PANEL_MIN = 90
const PANEL_MAX = 700

/**
 * 侧栏「Hermes 远端项目」虚拟区块。
 * 列出远端 Hermes 的项目（projects.tree，走协议无需 SSH）：
 * - 点击项目 → 展开该项目专属会话（projects.project_sessions），会话行可打开/恢复
 * - 「✦ 新建对话」→ 创建/复用同名本地项目文件夹，会话挂到其下（cwd 仍为远端项目目录）
 * - 点击区块标题 → 打开 Hermes 设置（远端会话视图）
 * - 顶部分割线可拖动调整区块高度（内部滚动）；可隐藏指定远端项目（Hermes Desktop 式）
 */
export function HermesSidebarProjects(): React.ReactElement | null {
  const store = useStore()
  const targets = useAtomValue(hermesTargetsAtom)
  const activeTargetId = useAtomValue(activeHermesTargetIdAtom)
  const hiddenProjects = useAtomValue(hermesHiddenProjectsAtom)
  const panelHeight = useAtomValue(hermesRemotePanelHeightAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const openSession = useOpenSession()

  const [projects, setProjects] = React.useState<HermesRemoteProject[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [startingChatId, setStartingChatId] = React.useState<string | null>(null)
  const [openingSessionId, setOpeningSessionId] = React.useState<string | null>(null)
  const [expandedProjectId, setExpandedProjectId] = React.useState<string | null>(null)
  const [projectSessionsMap, setProjectSessionsMap] = React.useState<Record<string, HermesRemoteSessionSummary[] | null>>({})
  const [loadingProjectId, setLoadingProjectId] = React.useState<string | null>(null)

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

  // 过滤已隐藏的项目
  const hiddenIds = hiddenProjects[target.id] ?? []
  const visibleProjects = (projects ?? []).filter((p) => !hiddenIds.includes(p.id))
  const hiddenCount = (projects ?? []).length - visibleProjects.length

  /** 展开/收起项目，首次展开加载该项目专属会话 */
  const handleToggleProject = async (project: HermesRemoteProject): Promise<void> => {
    const willExpand = expandedProjectId !== project.id
    setExpandedProjectId(willExpand ? project.id : null)
    if (willExpand && projectSessionsMap[project.id] === undefined) {
      setLoadingProjectId(project.id)
      try {
        const detail = await window.electronAPI.hermes.listRemoteProjectSessions(target.id, project.id)
        setProjectSessionsMap((prev) => ({ ...prev, [project.id]: extractProjectSessions(detail) }))
      } catch (error) {
        console.error('[Hermes] 加载项目会话失败:', error)
        setProjectSessionsMap((prev) => ({ ...prev, [project.id]: [] }))
      } finally {
        setLoadingProjectId(null)
      }
    }
  }

  /** 在项目目录新建 Hermes 对话：先复用/创建同名本地项目文件夹，会话挂到其下（cwd 仍为远端项目目录） */
  const handleNewChat = async (project: HermesRemoteProject): Promise<void> => {
    setStartingChatId(project.id)
    try {
      const workspace = await getOrCreateWorkspaceForProject(project.label)
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

  /** 打开/恢复远端会话：自动创建/复用同名本地项目文件夹 */
  const handleOpenSession = async (project: HermesRemoteProject, session: HermesRemoteSessionSummary): Promise<void> => {
    setOpeningSessionId(session.id)
    try {
      const workspace = await getOrCreateWorkspaceForProject(project.label)
      const created = await window.electronAPI.hermes.createRemoteSession({
        targetId: target.id,
        remoteSessionId: session.id,
        title: session.title || session.id,
        workspaceId: workspace.id,
      })
      setAgentSessions(await window.electronAPI.listAgentSessions())
      setSettingsOpen(false)
      setAppMode('agent')
      setActiveView('conversations')
      openSession('agent', created.id, created.title, { bypassSettingsGuard: true })
    } catch (error) {
      console.error('[Hermes] 打开远端会话失败:', error)
      window.alert(`打开远端会话失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setOpeningSessionId(null)
    }
  }

  /** 打开 Hermes 设置（远端会话视图） */
  const handleOpenSettings = (): void => {
    setSettingsTab('hermes')
    setSettingsOpen(true)
  }

  /** 隐藏/恢复项目 */
  const handleToggleHidden = (project: HermesRemoteProject): void => {
    const nextHidden = hiddenIds.includes(project.id)
      ? hiddenIds.filter((id) => id !== project.id)
      : Array.from(new Set([...hiddenIds, project.id]))
    const next = { ...hiddenProjects, [target.id]: nextHidden }
    store.set(hermesHiddenProjectsAtom, next)
    window.electronAPI.updateSettings({ hermesHiddenProjects: next }).catch(console.error)
  }

  // 拖拽分割线调整区块高度
  const dragStateRef = React.useRef<{ startY: number; startHeight: number } | null>(null)
  const handleResizePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // 捕获失败忽略
    }
    dragStateRef.current = { startY: event.clientY, startHeight: panelHeight }
    const onMove = (moveEvent: PointerEvent): void => {
      if (!dragStateRef.current) return
      const delta = dragStateRef.current.startY - moveEvent.clientY
      const nextHeight = Math.min(PANEL_MAX, Math.max(PANEL_MIN, dragStateRef.current.startHeight + delta))
      store.set(hermesRemotePanelHeightAtom, nextHeight)
    }
    const onUp = (): void => {
      dragStateRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.electronAPI.updateSettings({ hermesRemotePanelHeight: store.get(hermesRemotePanelHeightAtom) }).catch(console.error)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="sticky bottom-0 z-10 mt-1 flex-shrink-0 border-t border-foreground/[0.06] bg-[hsl(var(--sidebar-surface))] pt-1">
      {/* 可拖动分割线：调整 Hermes 远端区块高度 */}
      <div
        className="group/resizer relative -mx-1 mb-0.5 flex h-4 cursor-row-resize touch-none items-center justify-center"
        onPointerDown={handleResizePointerDown}
        title="拖动调整高度（项目少时也可拉动）"
      >
        <div className="h-1 w-10 rounded-full bg-foreground/[0.12] transition-colors group-hover/resizer:h-1.5 group-hover/resizer:bg-foreground/25" />
      </div>

      <div style={{ height: panelHeight }} className="overflow-y-auto scrollbar-thin">
        <button
          type="button"
          onClick={handleOpenSettings}
          className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] font-medium text-foreground/40 select-none hover:text-foreground/70"
        >
          <Server size={11} />
          Hermes 远端
          <span className="ml-auto flex items-center gap-0.5">
            <RefreshCw size={10} className="opacity-60" onClick={(e) => { e.stopPropagation(); void refresh() }} />
          </span>
        </button>
        {loading && projects === null ? (
          <div className="px-3 py-1 text-[11px] text-foreground/30">加载项目...</div>
        ) : projects === null ? (
          <div className="px-3 py-1 text-[11px] text-foreground/30">项目加载失败</div>
        ) : visibleProjects.length === 0 ? (
          <div className="px-3 py-1 text-[11px] text-foreground/30">
            {hiddenCount > 0 ? '远端项目已全部隐藏' : '远端暂无项目'}
          </div>
        ) : (
          <div className="flex flex-col pb-1">
            {visibleProjects.map((project) => {
              const expanded = expandedProjectId === project.id
              const projectSessions = projectSessionsMap[project.id]
              const loadingProject = loadingProjectId === project.id
              return (
                <div key={project.id} className="group">
                  <div className="flex items-center gap-1 px-3 py-1 hover:bg-accent/40">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] text-foreground/70"
                      onClick={() => void handleToggleProject(project)}
                      title={project.path}
                    >
                      <ChevronRight size={11} className={`shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
                      <FolderOpen size={12} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{project.label}</span>
                      {typeof project.sessionCount === 'number' && (
                        <span className="shrink-0 text-[10px] text-foreground/30">{project.sessionCount}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
                      title="隐藏该项目"
                      onClick={() => handleToggleHidden(project)}
                    >
                      <EyeOff size={12} />
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
                  {expanded && (
                    <div className="ml-[18px] border-l border-foreground/[0.06] pl-2 pb-1">
                      {loadingProject ? (
                        <div className="px-2 py-1 text-[11px] text-foreground/30">加载会话...</div>
                      ) : projectSessions && projectSessions.length > 0 ? (
                        projectSessions.map((session) => (
                          <div key={session.id} className="group/session flex items-center gap-1 py-0.5 pl-1 hover:bg-accent/30">
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] text-foreground/60"
                              title={session.preview || session.title}
                              onClick={() => void handleOpenSession(project, session)}
                            >
                              <MessageSquare size={10} className="shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate">{session.title || session.id}</span>
                            </button>
                            <button
                              type="button"
                              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 group-hover/session:opacity-100"
                              title="打开会话"
                              onClick={() => void handleOpenSession(project, session)}
                              disabled={openingSessionId === session.id}
                            >
                              {openingSessionId === session.id ? (
                                <span className="text-[10px]">打开中</span>
                              ) : (
                                <Play size={10} />
                              )}
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="px-2 py-1 text-[11px] text-foreground/30">该项目暂无会话</div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={handleOpenSettings}
            className="w-full px-3 py-0.5 text-left text-[11px] text-foreground/30 hover:text-foreground/60"
            title="管理隐藏的远端项目"
          >
            已隐藏 {hiddenCount} 个项目（点击管理）
          </button>
        )}
      </div>
    </div>
  )
}
