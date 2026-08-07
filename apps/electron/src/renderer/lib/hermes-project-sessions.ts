import type { HermesRemoteProject, HermesRemoteSessionSummary } from '@proma/shared'

/**
 * 从 projects.project_sessions（drill-in）的 repos → groups → sessions 提取会话摘要。
 * 真实 Hermes 结构：project.repos[].groups[].sessions（会话 row 与 session.list 字段一致）。
 */
export function extractProjectSessions(detail: HermesRemoteProject | null): HermesRemoteSessionSummary[] {
  if (!detail?.repos) return []
  const out: HermesRemoteSessionSummary[] = []
  for (const repo of detail.repos) {
    if (!repo || typeof repo !== 'object') continue
    const groups = (repo as { groups?: unknown }).groups
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue
      const sessions = (group as { sessions?: unknown }).sessions
      if (!Array.isArray(sessions)) continue
      for (const item of sessions) {
        if (!item || typeof item !== 'object') continue
        const s = item as { id?: unknown; title?: unknown; preview?: unknown; started_at?: unknown; message_count?: unknown; source?: unknown }
        if (typeof s.id !== 'string') continue
        out.push({
          id: s.id,
          title: typeof s.title === 'string' ? s.title : '',
          preview: typeof s.preview === 'string' ? s.preview : '',
          startedAt: typeof s.started_at === 'number' ? s.started_at : 0,
          messageCount: typeof s.message_count === 'number' ? s.message_count : 0,
          source: typeof s.source === 'string' ? s.source : '',
        })
      }
    }
  }
  return out
}
