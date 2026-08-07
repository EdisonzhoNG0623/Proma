/**
 * HermesRemoteSessionsView - 远端会话项目视图
 *
 * 展示远端 Hermes 的项目 → 会话分组（projects.tree / session.list），
 * 让 Proma 作为前端管理远端项目状态。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FolderOpen, MessageSquare, RefreshCw, Play, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SettingsCard } from './primitives/SettingsCard'
import { hermesTargetsAtom, activeHermesTargetIdAtom } from '@/atoms/hermes-atoms'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { useOpenSession } from '@/hooks/useOpenSession'
import { getOrCreateWorkspaceForProject } from '@/lib/hermes-workspace-helper'
import { extractProjectSessions } from '@/lib/hermes-project-sessions'
import type { HermesRemoteProject, HermesRemoteSessionSummary } from '@proma/shared'

/** 单个项目节点 */
function ProjectRow({
  project,
  onRefresh,
  targetId,
}: {
  project: HermesRemoteProject
  onRefresh: () => Promise<void>
  targetId: string
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
    <div>
      <div className="flex items-center gap-2 px-4 py-2">
        <Button variant="ghost" className="h-auto p-0 font-medium hover:bg-transparent" onClick={() => void toggle()}>
          <FolderOpen size={14} className="mr-1.5 text-muted-foreground" />
          <span>{project.label}</span>
          <span className="ml-1.5 text-xs text-muted-foreground">{project.path}</span>
        </Button>
        {typeof project.sessionCount === 'number' && (
          <Badge variant="secondary" className="text-xs">{project.sessionCount}</Badge>
        )}
        {loadingSessions && <span className="text-xs text-muted-foreground">加载中...</span>}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 text-xs"
          title="在此项目目录新建 Hermes 对话（无需 SSH）"
          onClick={() => void handleNewChat()}
          disabled={startingChat}
        >
          <MessageSquarePlus size={12} className="mr-1" />
          {startingChat ? '创建中...' : '新建对话'}
        </Button>
      </div>
      {expanded && (
        <div className="ml-6 border-l pl-3 pb-2">
          {loadingSessions ? (
            <div className="py-1 text-xs text-muted-foreground">加载会话...</div>
          ) : projectSessions && projectSessions.length > 0 ? (
            projectSessions.map((session) => (
              <SessionRow key={session.id} targetId={targetId} session={session} onOpened={onRefresh} />
            ))
          ) : (
            <div className="py-1 text-xs text-muted-foreground">该项目暂无会话</div>
          )}
        </div>
      )}
    </div>
  )
}

/** 单个会话行（含「打开」按钮） */
function SessionRow({
  targetId,
  session,
  onOpened,
}: {
  targetId: string
  session: HermesRemoteSessionSummary
  onOpened: () => Promise<void>
}): React.ReactElement {
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const openSession = useOpenSession()
  const [opening, setOpening] = React.useState(false)

  const handleOpen = async (): Promise<void> => {
    setOpening(true)
    try {
      const created = await window.electronAPI.hermes.createRemoteSession({
        targetId,
        remoteSessionId: session.id,
        title: session.title || session.id,
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
    <div className="flex items-center gap-2 px-4 py-1.5 text-sm">
      <MessageSquare size={13} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{session.title || session.id}</span>
      <Badge variant="outline" className="shrink-0 text-xs">{session.source}</Badge>
      <Button variant="ghost" size="sm" className="shrink-0 h-6 px-2 text-xs" onClick={() => void handleOpen()} disabled={opening}>
        <Play size={11} className="mr-1" />
        {opening ? '打开中...' : '打开'}
      </Button>
    </div>
  )
}

/** 远端会话项目视图 */
export function HermesRemoteSessionsView(): React.ReactElement {
  const targets = useAtomValue(hermesTargetsAtom)
  const activeTargetId = useAtomValue(activeHermesTargetIdAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const [projects, setProjects] = React.useState<HermesRemoteProject[] | null>(null)
  const [sessions, setSessions] = React.useState<HermesRemoteSessionSummary[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

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
          ) : (
            projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                onRefresh={() => refresh()}
                targetId={target.id}
              />
            ))
          )}
        </div>
      </SettingsCard>

      {target && sessions && sessions.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">最近会话（点「打开」恢复远端会话）</h4>
          <SettingsCard>
            <div className="py-1">
              {sessions.map((session) => (
                <SessionRow key={session.id} targetId={target.id} session={session} onOpened={handleSessionOpened} />
              ))}
            </div>
          </SettingsCard>
        </div>
      )}
    </div>
  )
}
