/**
 * HermesRemoteSessionsView - 远端会话项目视图
 *
 * 展示远端 Hermes 的项目 → 会话分组（projects.tree / session.list），
 * 让 Proma 作为前端管理远端项目状态。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { FolderOpen, MessageSquare, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SettingsCard } from './primitives/SettingsCard'
import { hermesTargetsAtom, activeHermesTargetIdAtom } from '@/atoms/hermes-atoms'
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

/** 远端会话项目视图 */
export function HermesRemoteSessionsView(): React.ReactElement {
  const targets = useAtomValue(hermesTargetsAtom)
  const activeTargetId = useAtomValue(activeHermesTargetIdAtom)
  const [projects, setProjects] = React.useState<HermesRemoteProject[] | null>(null)
  const [sessions, setSessions] = React.useState<HermesRemoteSessionSummary[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const target = targets.find((t) => t.id === activeTargetId) ?? targets[0]

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!target) return
    setLoading(true)
    setError(null)
    try {
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
  }, [target])

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
                sessions={sessions}
                onRefresh={() => void refresh()}
              />
            ))
          )}
        </div>
      </SettingsCard>

      {sessions && sessions.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">最近会话</h4>
          <SettingsCard>
            <div className="py-1">
              {sessions.map((session) => (
                <div key={session.id} className="flex items-center gap-2 px-4 py-1.5 text-sm">
                  <MessageSquare size={13} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{session.title || session.id}</span>
                  <Badge variant="outline" className="shrink-0 text-xs">{session.source}</Badge>
                </div>
              ))}
            </div>
          </SettingsCard>
        </div>
      )}
    </div>
  )
}
