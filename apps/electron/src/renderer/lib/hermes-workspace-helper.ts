import type { AgentWorkspace } from '@proma/shared'

/** 与 agent-workspace-manager 的 slugify 保持一致的 slug 生成（不含冲突后缀） */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * 查找或创建与远端项目同名的本地 Agent 项目文件夹（workspace）。
 * - 已存在同名（name 或 slug）→ 复用，不重复创建；
 * - 不存在 → 创建，返回新 workspace。
 * 会话随后挂到该 workspace 下（cwd 仍指向远端项目目录）。
 */
export async function getOrCreateWorkspaceForProject(projectLabel: string): Promise<AgentWorkspace> {
  const workspaces = await window.electronAPI.listAgentWorkspaces()
  const existing = workspaces.find((w) => w.name === projectLabel)
  if (existing) return existing

  const slug = slugifyName(projectLabel)
  if (slug) {
    const bySlug = workspaces.find((w) => w.slug === slug)
    if (bySlug) return bySlug
  }

  return window.electronAPI.createAgentWorkspace({ name: projectLabel })
}
