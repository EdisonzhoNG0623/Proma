/**
 * HermesRemoteSessionsView - 远端会话项目视图
 *
 * 展示远端 Hermes 的项目 → 会话分组（projects.tree / session.list），
 * 让 Proma 作为前端管理远端项目状态。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FolderOpen, MessageSquare, RefreshCw, Play, MessageSquarePlus, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsCard } from './primitives/SettingsCard'
import { hermesTargetsAtom, activeHermesTargetIdAtom, hermesHiddenProjectsAtom } from '@/atoms/hermes-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { useOpenSession } from '@/hooks/useOpenSession'
import { getOrCreateWorkspaceForProject } from '@/lib/hermes-workspace-helper'
import { extractProjectSessions } from '@/lib/hermes-project-sessions'
import type { HermesRemoteProject, HermesRemoteSessionSummary } from '@proma/shared'

/** 单项目标专属会话预览上限（repos→groups→sessions 提取后用于展开） */
const RECENT_SESSION_PREVIEW = 10

/** 单个项目节点 */
function ProjectRow({
  project,
  onRefresh,
  targetId,
  hidden,
  onToggleHidden,
}: {
  project: HermesRemoteProject
  onRefresh: () => Promise<void>
  targetId: string
  hidden: boolean
  onToggleHidden: (project: HermesRemoteProject) => void
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [loadingSessions, setLoadingSessions] = React.useState(false)
  const [projectSessions, setProjectSessions] = React.useState<HermesRemoteSessionSummary[] | null>(null)
  const [startingChat, setStartingChat] = React.useState(false)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const openSession = useOpenSession()

  const toggle = async (): Promise<void> => {
    if (!expanded && projectSessions === null) {
      setLoadingSessions(true)
      try {
        // 展开时加载该项目专属会话（projects.project_sessions 的 repos lanes）
        const detail = await window.electronAPI.hermes.listRemoteProjectSessions(targetId, project.id)
        setProjectSessions(extractProjectSessions(detail))
      } catch (error) {
        console.error('[Hermes] 加载项目会话失败:', error)
        setProjectSessions([])
      } finally {
        setLoadingSessions(false)
      }
    }
    setExpanded((prev) => !prev)
  }

  /** 在此项目目录新建 Hermes 对话：复用/创建同名本地项目文件夹，会话挂到其下 */
  const handleNewChat = async (): Promise<void> => {
    setStartingChat(true)
    try {
      // 1. 本地 Agent 项目文件夹：同名已存在则复用，否则创建
      const workspace = await getOrCreateWorkspaceForProject(project.label)
      // 2. 在该项目文件夹下创建远端会话（cwd 绑定远端项目目录）
      const created = await window.electronAPI.hermes.createRemoteSession({
        targetId,
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
      console.error('[Hermes] 在项目新建对话失败:', error)
      window.alert(`新建对话失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setStartingChat(false)
    }
  }

  return (
    <div className="px-4 py-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left hover:opacity-80"
          onClick={() => void toggle()}
          title={project.path}
        >
          <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.label}</span>
          {typeof project.sessionCount === 'number' && (
            <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {project.sessionCount}
            </span>
          )}
        </button>
        {loadingSessions && <span className="shrink-0 text-xs text-muted-foreground">加载中...</span>}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground"
          title={hidden ? '在列表中显示该项目' : '隐藏该项目（侧栏不显示）'}
          onClick={() => onToggleHidden(project)}
        >
          <EyeOff size={12} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          title="在此项目目录新建 Hermes 对话（无需 SSH）"
          onClick={() => void handleNewChat()}
          disabled={startingChat}
        >
          <MessageSquarePlus size={12} className="mr-1" />
          {startingChat ? '创建中' : '新建对话'}
        </Button>
      </div>
      {project.path && (
        <div className="truncate pl-5 pr-2 pb-1 text-[11px] text-muted-foreground/50" title={project.path}>
          {project.path}
        </div>
      )}
      {expanded && (
        <div className="ml-6 border-l pl-3 pb-2">
          {loadingSessions ? (
            <div className="py-1 text-xs text-muted-foreground">加载会话...</div>
          ) : projectSessions && projectSessions.length > 0 ? (
            projectSessions.map((session) => (
              <SessionRow key={session.id} targetId={targetId} session={session} onOpened={onRefresh} workspaceName={project.label} />
            ))
          ) : (
            <div className="py-1 text-xs text-muted-foreground">该项目暂无会话</div>
          )}
        </div>
      )}
    </div>
  )
}

/** 单个会话行（含「打开」按钮）；workspaceName 存在时自动创建/复用同名本地项目文件夹 */
function SessionRow({
  targetId,
  session,
  onOpened,
  workspaceName,
}: {
  targetId: string
  session: HermesRemoteSessionSummary
  onOpened: () => Promise<void>
  workspaceName?: string
}): React.ReactElement {
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const openSession = useOpenSession()
  const [opening, setOpening] = React.useState(false)

  const handleOpen = async (): Promise<void> => {
    setOpening(true)
    try {
      // 项目上下文存在时：自动创建/复用同名本地项目文件夹，会话挂到其下
      let workspaceId: string | undefined
      if (workspaceName) {
        const workspace = await getOrCreateWorkspaceForProject(workspaceName)
        workspaceId = workspace.id
      }
      const created = await window.electronAPI.hermes.createRemoteSession({
        targetId,
        remoteSessionId: session.id,
        title: session.title || session.id,
        workspaceId,
      })
      // 刷新会话列表（新会话出现在 Agent 侧栏）
      await onOpened()
      // 关闭设置面板并精确定位到刚创建的会话
      setSettingsOpen(false)
      setAppMode('agent')
      setActiveView('conversations')
      openSession('agent', created.id, created.title, { bypassSettingsGuard: true })
    } catch (error) {
      console.error('[Hermes] 打开远端会话失败:', error)
      window.alert(`打开远端会话失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-sm hover:bg-accent/40">
      <MessageSquare size={13} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{session.title || session.id}</span>
      {session.messageCount > 0 && (
        <span className="shrink-0 text-[11px] text-muted-foreground/50">{session.messageCount} 条</span>
      )}
      {session.source && (
        <span className="shrink-0 text-[11px] text-muted-foreground/50">{session.source}</span>
      )}
      <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => void handleOpen()} disabled={opening}>
        <Play size={11} className="mr-1" />
        {opening ? '打开中' : '打开'}
      </Button>
    </div>
  )
}

/** 远端会话项目视图 */
export function HermesRemoteSessionsView(): React.ReactElement {
  const targets = useAtomValue(hermesTargetsAtom)
  const activeTargetId = useAtomValue(activeHermesTargetIdAtom)
  const hiddenProjects = useAtomValue(hermesHiddenProjectsAtom)
  const setHiddenProjects = useSetAtom(hermesHiddenProjectsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const [projects, setProjects] = React.useState<HermesRemoteProject[] | null>(null)
  const [sessions, setSessions] = React.useState<HermesRemoteSessionSummary[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [showAllSessions, setShowAllSessions] = React.useState(false)

  /** 打开会话后刷新 Agent 会话列表（新会话出现在侧栏） */
  const handleSessionOpened = React.useCallback(async (): Promise<void> => {
    try {
      setAgentSessions(await window.electronAPI.listAgentSessions())
    } catch (error) {
      console.error('[Hermes] 刷新会话列表失败:', error)
    }
  }, [setAgentSessions])

  const target = targets.find((t) => t.id === activeTargetId) ?? targets[0]

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!target) return
    setLoading(true)
    setError(null)
    try {
      // 自动清理历史重复的远端会话（同一 target+远端会话保留一个）
      const removed = await window.electronAPI.hermes.dedupeRemoteSessions()
      if (removed > 0) {
        // 清理后刷新 Agent 会话列表
        try {
          setAgentSessions(await window.electronAPI.listAgentSessions())
        } catch {
          // 忽略
        }
      }
      const [projectTree, sessionList] = await Promise.all([
        window.electronAPI.hermes.listRemoteProjects(target.id),
        window.electronAPI.hermes.listRemoteSessions(target.id, 50),
      ])
      setProjects(projectTree)
      setSessions(sessionList)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [target, setAgentSessions])

  React.useEffect(() => {
    if (target) void refresh()
  }, [target, refresh])

  // 隐藏项目管理
  const hiddenIds = target ? (hiddenProjects[target.id] ?? []) : []
  const visibleProjects = (projects ?? []).filter((p) => !hiddenIds.includes(p.id))
  const hiddenProjectsList = (projects ?? []).filter((p) => hiddenIds.includes(p.id))
  const handleToggleHidden = (project: HermesRemoteProject): void => {
    if (!target) return
    const nextHidden = hiddenIds.includes(project.id)
      ? hiddenIds.filter((id) => id !== project.id)
      : Array.from(new Set([...hiddenIds, project.id]))
    const next = { ...hiddenProjects, [target.id]: nextHidden }
    setHiddenProjects(next)
    window.electronAPI.updateSettings({ hermesHiddenProjects: next }).catch(console.error)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">远端会话</h3>
          <p className="text-xs text-muted-foreground">
            {target ? `项目来自：${target.name}` : '请先在连接列表选择 target'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading || !target}>
          <RefreshCw size={14} className="mr-1" />
          {loading ? '同步中...' : '刷新'}
        </Button>
      </div>

      {error && <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</div>}

      <SettingsCard>
        <div className="py-1">
          {!target ? (
            <div className="px-4 py-4 text-sm text-muted-foreground">没有可用的 Hermes 连接</div>
          ) : projects === null ? (
            <div className="px-4 py-4 text-sm text-muted-foreground">加载远端项目...</div>
          ) : projects.length === 0 ? (
            <div className="px-4 py-4 text-sm text-muted-foreground">远端暂无项目（或未开启 Dashboard）</div>
          ) : visibleProjects.length === 0 && hiddenProjectsList.length === 0 ? (
            <div className="px-4 py-4 text-sm text-muted-foreground">远端暂无项目（或未开启 Dashboard）</div>
          ) : (
            visibleProjects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                onRefresh={() => refresh()}
                targetId={target.id}
                hidden={false}
                onToggleHidden={handleToggleHidden}
              />
            ))
          )}
          {hiddenProjectsList.length > 0 && (
            <div className="border-t border-foreground/[0.06] px-4 py-2">
              <div className="mb-1 text-xs text-muted-foreground">已隐藏项目（在侧栏不显示）</div>
              {hiddenProjectsList.map((project) => (
                <div key={project.id} className="flex items-center justify-between gap-2 py-1">
                  <span className="min-w-0 truncate text-sm text-muted-foreground/70">
                    <EyeOff size={12} className="mr-1 inline text-muted-foreground" />
                    {project.label}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => handleToggleHidden(project)}
                  >
                    恢复显示
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsCard>

      {target && sessions && sessions.length > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <h4 className="text-xs font-medium text-muted-foreground">最近会话（点「打开」恢复远端会话）</h4>
            <span className="text-[11px] text-muted-foreground/50">{sessions.length} 个</span>
          </div>
          <SettingsCard>
            <div className="py-1">
              {sessions.slice(0, showAllSessions ? undefined : RECENT_SESSION_PREVIEW).map((session) => (
                <SessionRow key={session.id} targetId={target.id} session={session} onOpened={handleSessionOpened} />
              ))}
            </div>
          </SettingsCard>
          {sessions.length > RECENT_SESSION_PREVIEW && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 w-full text-xs text-muted-foreground"
              onClick={() => setShowAllSessions((prev) => !prev)}
            >
              {showAllSessions ? '收起' : `显示全部 ${sessions.length} 个`}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
