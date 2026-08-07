/**
 * HermesRemoteSessionsView - 远端会话项目视图
 *
 * 展示远端 Hermes 的项目 → 会话分组（projects.tree / session.list），
 * 让 Proma 作为前端管理远端项目状态。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FolderOpen, MessageSquare, RefreshCw, Play, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SettingsCard } from './primitives/SettingsCard'
import { hermesTargetsAtom, activeHermesTargetIdAtom } from '@/atoms/hermes-atoms'
import { agentSessionsAtom, agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { useOpenSession } from '@/hooks/useOpenSession'
import type { HermesRemoteProject, HermesRemoteSessionSummary } from '@proma/shared'

/** 单个项目节点 */
function ProjectRow({
  project,
  sessions,
  onRefresh,
}: {
  project: HermesRemoteProject
  sessions: HermesRemoteSessionSummary[] | null
  onRefresh: () => void
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const [loadingSessions, setLoadingSessions] = React.useState(false)
  const activeTargetId = useAtomValue(activeHermesTargetIdAtom)

  const toggle = async (): Promise<void> => {
    if (!expanded && sessions === null && activeTargetId) {
      setLoadingSessions(true)
      try {
        const detail = await window.electronAPI.hermes.listRemoteProjectSessions(activeTargetId, project.id)
        if (detail?.repos) {
          // 首版展示项目级会话（previewSessions）；repo/lane 细分后续
          onRefresh()
        }
      } finally {
        setLoadingSessions(false)
      }
    }
    setExpanded((prev) => !prev)
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
      </div>
      {expanded && (
        <div className="ml-6 border-l pl-3 pb-2">
          {project.previewSessions && project.previewSessions.length > 0 ? (
            project.previewSessions.map((session, index) => (
              <div key={index} className="flex items-center gap-1.5 py-1 text-sm text-muted-foreground">
                <MessageSquare size={12} />
                <span className="truncate">{String((session as { title?: unknown })?.title ?? '会话')}</span>
              </div>
            ))
          ) : (
            <div className="py-1 text-xs text-muted-foreground">该项目的会话通过 projects.project_sessions 展开（后续）</div>
          )}
          {sessions && sessions.length > 0 && (
            <div className="mt-1">
              {sessions.map((session) => (
                <div key={session.id} className="flex items-center gap-1.5 py-1 text-sm">
                  <MessageSquare size={12} className="text-muted-foreground" />
                  <span className="truncate">{session.title || session.id}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{session.source}</span>
                </div>
              ))}
            </div>
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
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const [syncResult, setSyncResult] = React.useState<import('@proma/shared').HermesSyncResult | null>(null)
  const [syncing, setSyncing] = React.useState(false)
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

  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId) ?? workspaces[0]

  /** 同步当前项目到远端（SFTP 增量上传） */
  const handleSyncProject = React.useCallback(async (): Promise<void> => {
    if (!target || !currentWorkspace) return
    setSyncing(true)
    setSyncResult(null)
    try {
      const result = await window.electronAPI.hermes.syncProjectToRemote(target.id, currentWorkspace.id)
      setSyncResult(result)
    } catch (error) {
      window.alert(`同步失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSyncing(false)
    }
  }, [target, currentWorkspace])

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
                sessions={sessions}
                onRefresh={() => void refresh()}
              />
            ))
          )}
        </div>
      </SettingsCard>

      {/* 项目同步到远端（SFTP 增量上传） */}
      <SettingsCard>
        <div className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">项目同步到远端</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {currentWorkspace
                ? `项目：${currentWorkspace.name}（${currentWorkspace.projectRootPath ?? currentWorkspace.slug}）`
                : '无可用项目'}
            </div>
            {target?.mode !== 'ssh-tunnel' && (
              <div className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                需要 SSH Tunnel 模式连接才能同步文件
              </div>
            )}
            {syncResult && (
              <div className="mt-1 text-xs text-muted-foreground">
                同步完成：上传 {syncResult.uploaded} · 跳过 {syncResult.skipped} · 失败 {syncResult.failed}
                {syncResult.errors.length > 0 && `（${syncResult.errors.length} 个错误）`}
              </div>
            )}
          </div>
          <Button
            size="sm"
            onClick={() => void handleSyncProject()}
            disabled={syncing || !target || !currentWorkspace || target.mode !== 'ssh-tunnel'}
          >
            <Upload size={14} className="mr-1" />
            {syncing ? '同步中...' : '同步到远端'}
          </Button>
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
