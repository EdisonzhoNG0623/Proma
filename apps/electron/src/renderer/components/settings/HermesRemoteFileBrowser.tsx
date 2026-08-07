/**
 * HermesRemoteFileBrowser - 远端项目文件浏览器
 *
 * 以 SFTP 直连远端 Hermes，浏览/查看远端项目文件（项目数据在远端，Proma 是前端）。
 * 支持：新建远端项目（~/proma-projects/<name>）、目录浏览、文件内容查看。
 */

import * as React from 'react'
import { ArrowLeft, File, Folder, FolderPlus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsCard } from './primitives/SettingsCard'
import type { HermesTarget, HermesRemoteFileEntry } from '@proma/shared'

const REMOTE_ROOT = '~/proma-projects'

/** 远端文件浏览器 */
export function HermesRemoteFileBrowser({ target }: { target: HermesTarget }): React.ReactElement {
  const [currentPath, setCurrentPath] = React.useState(REMOTE_ROOT)
  const [entries, setEntries] = React.useState<HermesRemoteFileEntry[] | null>(null)
  const [selectedContent, setSelectedContent] = React.useState<{ path: string; content: string } | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [newProjectName, setNewProjectName] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadDir = React.useCallback(async (path: string): Promise<void> => {
    setLoading(true)
    setError(null)
    setSelectedContent(null)
    try {
      const list = await window.electronAPI.hermes.listRemoteFiles(target.id, path)
      setEntries(list)
      setCurrentPath(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [target.id])

  React.useEffect(() => {
    void loadDir(REMOTE_ROOT)
  }, [loadDir])

  const handleCreateProject = async (): Promise<void> => {
    const name = newProjectName.trim()
    if (!name) return
    setCreating(true)
    setError(null)
    try {
      await window.electronAPI.hermes.createRemoteProject(target.id, name)
      setNewProjectName('')
      void loadDir(REMOTE_ROOT)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const handleOpenEntry = async (entry: HermesRemoteFileEntry): Promise<void> => {
    if (entry.isDirectory) {
      void loadDir(entry.path)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const content = await window.electronAPI.hermes.readRemoteFile(target.id, entry.path)
      setSelectedContent({ path: entry.path, content })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const parentPath = (): string => {
    const parts = currentPath.split('/').filter(Boolean)
    parts.pop()
    if (parts.length <= 1) return REMOTE_ROOT
    return `/${parts.join('/')}`
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">远端项目文件</h3>
        <Button variant="ghost" size="sm" onClick={() => void loadDir(currentPath)} disabled={loading}>
          <RefreshCw size={14} className="mr-1" />
          {loading ? '读取中...' : '刷新'}
        </Button>
      </div>

      {error && <div className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">{error}</div>}

      {/* 新建远端项目 */}
      <div className="flex items-center gap-2">
        <Input
          value={newProjectName}
          onChange={(e) => setNewProjectName(e.target.value)}
          placeholder="新建远端项目名称（在 ~/proma-projects 下）"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreateProject()
          }}
          className="h-8 flex-1 text-sm"
        />
        <Button size="sm" onClick={() => void handleCreateProject()} disabled={creating || !newProjectName.trim()}>
          <FolderPlus size={14} className="mr-1" />
          {creating ? '创建中...' : '创建'}
        </Button>
      </div>

      {/* 路径导航 */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {currentPath !== REMOTE_ROOT && (
          <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => void loadDir(parentPath())}>
            <ArrowLeft size={12} className="mr-0.5" />上级
          </Button>
        )}
        <span className="truncate">{currentPath}</span>
      </div>

      {/* 文件列表 */}
      <SettingsCard>
        <div className="py-1">
          {entries === null ? (
            <div className="px-4 py-4 text-sm text-muted-foreground">加载中...</div>
          ) : entries.length === 0 ? (
            <div className="px-4 py-4 text-sm text-muted-foreground">
              目录为空。可用「新建远端项目」创建，或确认远端 ~/proma-projects 存在且 SSH 账号有权限。
            </div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-accent/50"
                onClick={() => void handleOpenEntry(entry)}
              >
                {entry.isDirectory ? (
                  <Folder size={14} className="shrink-0 text-muted-foreground" />
                ) : (
                  <File size={14} className="shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {!entry.isDirectory && (
                  <span className="shrink-0 text-xs text-muted-foreground">{formatSize(entry.size)}</span>
                )}
              </button>
            ))
          )}
        </div>
      </SettingsCard>

      {/* 文件内容预览 */}
      {selectedContent && (
        <div className="rounded-md border p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="truncate text-xs font-medium">{selectedContent.path}</span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setSelectedContent(null)}>
              关闭
            </Button>
          </div>
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
            {selectedContent.content}
          </pre>
        </div>
      )}
    </div>
  )
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
