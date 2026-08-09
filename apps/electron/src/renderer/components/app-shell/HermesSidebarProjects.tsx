import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { ChevronDown, ChevronRight, EyeOff, FolderOpen, GripHorizontal, MessageSquare, MessageSquarePlus, Play, RefreshCw, Server, Settings2, TriangleAlert } from 'lucide-react'
import {
  activeHermesTargetIdAtom,
  hermesHiddenProjectsAtom,
  hermesRemotePanelHeightAtom,
  hermesTargetsAtom,
  hermesTargetsLoadedAtom,
  loadHermesTargets,
} from '@/atoms/hermes-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { useOpenSession } from '@/hooks/useOpenSession'
import { getOrCreateWorkspaceForProject } from '@/lib/hermes-workspace-helper'
import { extractProjectSessions } from '@/lib/hermes-project-sessions'
import {
  clampHermesPanelHeight,
  getHermesPanelToggleHeight,
  HERMES_PANEL_DEFAULT_HEIGHT,
  HERMES_PANEL_KEYBOARD_STEP,
  HERMES_PANEL_MAX_HEIGHT,
  HERMES_PANEL_MIN_HEIGHT,
  isHermesPanelCollapsed,
  resizeHermesPanelHeight,
} from '@/lib/hermes-sidebar-layout'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { HermesRemoteProject, HermesRemoteSessionSummary } from '@proma/shared'

/**
 * 侧栏「Hermes 远端项目」虚拟区块。
 * 列出远端 Hermes 的项目（projects.tree，走协议无需 SSH）：
 * - 点击项目 → 展开该项目专属会话（projects.project_sessions），会话行可打开/恢复
 * - 「✦ 新建对话」→ 创建/复用同名本地项目文件夹，会话挂到其下（cwd 仍为远端项目目录）
 * - 点击区块标题 → 打开 Hermes 设置（远端会话视图）
 * - 标准分割线可拖动或用键盘调整区块高度；可隐藏指定远端项目（Hermes Desktop 式）
 */
export function HermesSidebarProjects(): React.ReactElement | null {
  const store = useStore()
  const targets = useAtomValue(hermesTargetsAtom)
  const targetsLoaded = useAtomValue(hermesTargetsLoadedAtom)
  const activeTargetId = useAtomValue(activeHermesTargetIdAtom)
  const hiddenProjects = useAtomValue(hermesHiddenProjectsAtom)
  const panelHeight = useAtomValue(hermesRemotePanelHeightAtom)
  const setTargets = useSetAtom(hermesTargetsAtom)
  const setTargetsLoaded = useSetAtom(hermesTargetsLoadedAtom)
  const setActiveTargetId = useSetAtom(activeHermesTargetIdAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const openSession = useOpenSession()

  const [projects, setProjects] = React.useState<HermesRemoteProject[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [targetLoadError, setTargetLoadError] = React.useState<string | null>(null)
  const [targetReloadVersion, setTargetReloadVersion] = React.useState(0)
  const [startingChatId, setStartingChatId] = React.useState<string | null>(null)
  const [openingSessionId, setOpeningSessionId] = React.useState<string | null>(null)
  const [expandedProjectId, setExpandedProjectId] = React.useState<string | null>(null)
  const [projectSessionsMap, setProjectSessionsMap] = React.useState<Record<string, HermesRemoteSessionSummary[] | null>>({})
  const [loadingProjectId, setLoadingProjectId] = React.useState<string | null>(null)
  const [resizing, setResizing] = React.useState(false)
  const dragStateRef = React.useRef<{ startY: number; startHeight: number } | null>(null)
  const targetLoadAttemptedRef = React.useRef(false)
  const lastExpandedHeightRef = React.useRef(
    isHermesPanelCollapsed(panelHeight) ? HERMES_PANEL_DEFAULT_HEIGHT : clampHermesPanelHeight(panelHeight),
  )
  const effectivePanelHeight = clampHermesPanelHeight(panelHeight)
  const panelCollapsed = isHermesPanelCollapsed(effectivePanelHeight)

  const target = targets.find((t) => t.id === activeTargetId) ?? targets[0]

  React.useEffect(() => {
    // 全局 initializer 先加载；仅在其完成但列表为空/失败时执行一次侧边栏兜底重试。
    if (!targetsLoaded || targets.length > 0 || targetLoadAttemptedRef.current) return
    targetLoadAttemptedRef.current = true
    let cancelled = false
    void loadHermesTargets()
      .then((loadedTargets) => {
        if (!cancelled) {
          setTargetLoadError(null)
          setTargets(loadedTargets)
        }
      })
      .catch((error) => {
        if (!cancelled) setTargetLoadError(error instanceof Error ? error.message : String(error))
        console.error('[Hermes] 加载 Target 列表失败:', error)
      })
      .finally(() => {
        if (!cancelled) setTargetsLoaded(true)
      })
    return () => { cancelled = true }
  }, [setTargets, setTargetsLoaded, targetReloadVersion, targets.length, targetsLoaded])

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!target) {
      setProjects(null)
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      setProjects(await window.electronAPI.hermes.listRemoteProjects(target.id))
    } catch (error) {
      console.error('[Hermes] 加载远端项目失败:', error)
      setProjects(null)
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [target])

  React.useEffect(() => {
    setProjects(null)
    setLoadError(null)
    setExpandedProjectId(null)
    setProjectSessionsMap({})
    void refresh()
  }, [refresh])

  // 过滤已隐藏的项目
  const hiddenIds = target ? (hiddenProjects[target.id] ?? []) : []
  const visibleProjects = (projects ?? []).filter((p) => !hiddenIds.includes(p.id))
  const hiddenCount = (projects ?? []).length - visibleProjects.length
  const targetStatus = loading && projects === null
    ? { label: '正在连接', dotClassName: 'bg-amber-400 animate-pulse' }
    : loadError
      ? { label: '连接异常', dotClassName: 'bg-destructive' }
      : { label: `${visibleProjects.length} 个项目`, dotClassName: 'bg-emerald-500' }

  /** 展开/收起项目，首次展开加载该项目专属会话 */
  const handleToggleProject = async (project: HermesRemoteProject): Promise<void> => {
    if (!target) return
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
    if (!target) return
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
    if (!target) return
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
    if (!target) return
    const nextHidden = hiddenIds.includes(project.id)
      ? hiddenIds.filter((id) => id !== project.id)
      : Array.from(new Set([...hiddenIds, project.id]))
    const next = { ...hiddenProjects, [target.id]: nextHidden }
    store.set(hermesHiddenProjectsAtom, next)
    window.electronAPI.updateSettings({ hermesHiddenProjects: next }).catch(console.error)
  }

  const applyPanelHeight = React.useCallback((height: number): void => {
    const next = clampHermesPanelHeight(height)
    store.set(hermesRemotePanelHeightAtom, next)
    // 折叠是临时 UI 状态，不覆盖持久化的最近展开高度。
    if (!isHermesPanelCollapsed(next)) {
      lastExpandedHeightRef.current = next
      window.electronAPI.updateSettings({ hermesRemotePanelHeight: next }).catch(console.error)
    }
  }, [store])

  // 标准 split-pane 语义：向上拖扩大远端区域，向下拖缩小；不再制造中间空白。
  const handleResizePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragStateRef.current = { startY: event.clientY, startHeight: effectivePanelHeight }
    setResizing(true)
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (moveEvent: PointerEvent): void => {
      const start = dragStateRef.current
      if (!start) return
      store.set(hermesRemotePanelHeightAtom, resizeHermesPanelHeight(start.startHeight, start.startY, moveEvent.clientY))
    }
    const onUp = (): void => {
      const next = clampHermesPanelHeight(store.get(hermesRemotePanelHeightAtom))
      dragStateRef.current = null
      setResizing(false)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (!isHermesPanelCollapsed(next)) {
        lastExpandedHeightRef.current = next
        window.electronAPI.updateSettings({ hermesRemotePanelHeight: next }).catch(console.error)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'ArrowUp'
      ? effectivePanelHeight + HERMES_PANEL_KEYBOARD_STEP
      : event.key === 'ArrowDown'
        ? effectivePanelHeight - HERMES_PANEL_KEYBOARD_STEP
        : event.key === 'Home'
          ? HERMES_PANEL_MIN_HEIGHT
          : HERMES_PANEL_MAX_HEIGHT
    applyPanelHeight(next)
  }

  const handleToggleCompact = (): void => {
    if (!panelCollapsed) lastExpandedHeightRef.current = effectivePanelHeight
    applyPanelHeight(getHermesPanelToggleHeight(effectivePanelHeight, lastExpandedHeightRef.current))
  }

  if (!target) {
    return (
      <div data-hermes-sidebar-panel className="relative z-10 mt-1 flex flex-shrink-0 items-center gap-2 border-t border-foreground/[0.08] bg-[hsl(var(--sidebar-surface))] px-3 py-2.5 shadow-[0_-10px_24px_-22px_hsl(var(--foreground))]">
        <span className="flex size-7 flex-shrink-0 items-center justify-center rounded-lg bg-foreground/[0.055] text-foreground/40">
          <Server size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium text-foreground/65">Hermes 远端</span>
          <span className="block truncate text-[10px] text-foreground/35" title={targetLoadError ?? undefined}>
            {targetLoadError ? '连接列表加载失败' : targetsLoaded ? '尚未配置连接' : '正在加载连接…'}
          </span>
        </span>
        {targetLoadError && (
          <button
            type="button"
            onClick={() => {
              targetLoadAttemptedRef.current = false
              setTargetLoadError(null)
              setTargetReloadVersion((version) => version + 1)
            }}
            className="rounded-md px-2 py-1 text-[10px] text-foreground/45 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/75"
          >
            重试
          </button>
        )}
        <button
          type="button"
          onClick={handleOpenSettings}
          className="rounded-md bg-primary/[0.08] px-2 py-1 text-[10px] text-primary transition-colors hover:bg-primary/[0.13]"
        >
          {targetsLoaded && !targetLoadError ? '配置' : '设置'}
        </button>
      </div>
    )
  }

  return (
    <div data-hermes-sidebar-panel className="relative z-10 mt-1 flex-shrink-0 bg-[hsl(var(--sidebar-surface))] shadow-[0_-10px_24px_-22px_hsl(var(--foreground))]">
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整项目列表与 Hermes 远端项目的显示空间"
        aria-valuemin={HERMES_PANEL_MIN_HEIGHT}
        aria-valuemax={HERMES_PANEL_MAX_HEIGHT}
        aria-valuenow={effectivePanelHeight}
        tabIndex={0}
        className={cn(
          'group/resizer relative flex h-4 cursor-row-resize touch-none items-center justify-center outline-none',
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
          resizing && 'bg-primary/[0.04]',
        )}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        onDoubleClick={() => applyPanelHeight(HERMES_PANEL_DEFAULT_HEIGHT)}
        title="拖动调整高度；方向键微调；双击恢复默认"
      >
        <div className="absolute inset-x-2 h-px bg-foreground/[0.08] transition-colors group-hover/resizer:bg-foreground/[0.16]" />
        <div className={cn(
          'relative flex h-3.5 w-11 items-center justify-center rounded-full border border-foreground/[0.08] bg-[hsl(var(--sidebar-surface))] text-foreground/25 transition-all',
          'group-hover/resizer:w-14 group-hover/resizer:border-foreground/[0.14] group-hover/resizer:text-foreground/50',
          resizing && 'w-14 border-primary/30 text-primary',
        )}>
          <GripHorizontal size={13} />
        </div>
      </div>

      <div style={{ height: effectivePanelHeight }} className="flex min-h-0 flex-col overflow-hidden">
        <div className="flex h-[46px] flex-shrink-0 items-center gap-2 px-2.5 pb-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.045] data-[state=open]:bg-foreground/[0.055]"
                title={targets.length > 1 ? '切换 Hermes Target' : '查看 Hermes 连接'}
              >
                <span className="relative flex size-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/[0.10] text-primary shadow-sm">
                  <Server size={14} />
                  <span className={cn('absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-[hsl(var(--sidebar-surface))]', targetStatus.dotClassName)} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold leading-4 text-foreground/80">Hermes 远端</span>
                  <span className="block truncate text-[10px] leading-3.5 text-foreground/38">{target.name} · {targetStatus.label}</span>
                </span>
                <ChevronDown size={12} className="flex-shrink-0 text-foreground/30" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-64">
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">远端连接</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={target.id} onValueChange={setActiveTargetId}>
                {targets.map((candidate) => (
                  <DropdownMenuRadioItem key={candidate.id} value={candidate.id} className="items-start text-xs">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{candidate.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">{candidate.mode === 'ssh-tunnel' ? 'SSH Tunnel' : 'Direct'}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleOpenSettings} className="text-xs">
                <Settings2 size={13} />
                管理 Hermes 连接
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex size-7 flex-shrink-0 items-center justify-center rounded-md text-foreground/35 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70 disabled:cursor-wait"
            title="刷新远端项目"
            aria-label="刷新 Hermes 远端项目"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={handleOpenSettings}
            className="flex size-7 flex-shrink-0 items-center justify-center rounded-md text-foreground/35 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70"
            title="Hermes 设置"
            aria-label="打开 Hermes 设置"
          >
            <Settings2 size={13} />
          </button>
          <button
            type="button"
            onClick={handleToggleCompact}
            className="flex size-7 flex-shrink-0 items-center justify-center rounded-md text-foreground/35 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70"
            title={panelCollapsed ? '展开远端项目' : '收起远端项目'}
            aria-label={panelCollapsed ? '展开 Hermes 远端项目' : '收起 Hermes 远端项目'}
          >
            <ChevronDown size={14} className={cn('transition-transform', panelCollapsed && 'rotate-180')} />
          </button>
        </div>

        <div data-hermes-project-scroll className="min-h-0 flex-1 overflow-y-auto px-1 pb-1 scrollbar-thin">
        {loading && projects === null ? (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-foreground/35">
            <RefreshCw size={11} className="animate-spin" />
            正在读取远端项目…
          </div>
        ) : projects === null ? (
          <div className="mx-1.5 rounded-lg bg-destructive/[0.07] px-2.5 py-2 text-[11px]">
            <div className="flex items-start gap-2 text-destructive/85">
              <TriangleAlert size={13} className="mt-0.5 flex-shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">远端项目加载失败</span>
                <span className="mt-0.5 block truncate text-[10px] text-foreground/40" title={loadError ?? undefined}>{loadError ?? '无法读取远端项目'}</span>
              </span>
            </div>
            <div className="mt-2 flex items-center gap-1.5 pl-5">
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-md bg-foreground/[0.055] px-2 py-1 text-[10px] text-foreground/65 transition-colors hover:bg-foreground/[0.09] hover:text-foreground"
              >
                重试
              </button>
              <button
                type="button"
                onClick={handleOpenSettings}
                className="rounded-md px-2 py-1 text-[10px] text-foreground/45 transition-colors hover:bg-foreground/[0.05] hover:text-foreground/75"
              >
                检查设置
              </button>
            </div>
          </div>
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
    </div>
  )
}
