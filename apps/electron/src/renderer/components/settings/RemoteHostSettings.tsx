/**
 * RemoteHostSettings - Proma Remote Host 设置面板
 *
 * 管理 Debian Remote Host 连接：
 * - SSH Tunnel 连接列表
 * - 创建/编辑表单
 * - 连接测试与能力探测
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Plus, RefreshCw, Trash2, Pencil, Server, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { SettingsCard } from './primitives/SettingsCard'
import { SettingsInput } from './primitives/SettingsInput'
import { SettingsSecretInput } from './primitives/SettingsSecretInput'
import { SettingsSection } from './primitives/SettingsSection'
import {
  remoteHostTargetsAtom,
  remoteHostTargetsLoadedAtom,
  activeRemoteHostTargetIdAtom,
} from '@/atoms/remote-host-atoms'
import {
  loadRemoteHostTargets,
  createRemoteHostTarget,
  updateRemoteHostTarget,
  deleteRemoteHostTarget,
  probeRemoteHostTarget,
  confirmRemoteHostKey,
} from '@/atoms/remote-host-atoms'
import type { RemoteHostPublicTarget, RemoteHostHello } from '@proma/shared'

interface FormState {
  name: string
  sshHost: string
  sshPort: string
  sshUsername: string
  remoteHostPort: string
  bearerToken: string
  sshPassword: string
}

const EMPTY_FORM: FormState = {
  name: '',
  sshHost: '',
  sshPort: '22',
  sshUsername: '',
  remoteHostPort: '9754',
  bearerToken: '',
  sshPassword: '',
}

const runtimeLabels: Record<string, string> = {
  pi: 'Pi',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

function targetToForm(target: RemoteHostPublicTarget): FormState {
  return {
    name: target.name,
    sshHost: target.ssh.host,
    sshPort: String(target.ssh.port),
    sshUsername: target.ssh.username,
    remoteHostPort: String(target.ssh.remoteHostPort),
    bearerToken: '',
    sshPassword: '',
  }
}

export function RemoteHostSettings(): JSX.Element {
  const [targets, setTargets] = useAtom(remoteHostTargetsAtom)
  const [loaded, setLoaded] = useAtom(remoteHostTargetsLoadedAtom)
  const [activeId, setActiveId] = useAtom(activeRemoteHostTargetIdAtom)

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = React.useState(false)
  const [probing, setProbing] = React.useState<Set<string>>(new Set())
  const [probeErrors, setProbeErrors] = React.useState<Map<string, string>>(new Map())
  const [probeResults, setProbeResults] = React.useState<Map<string, RemoteHostHello>>(new Map())

  const [hostKeyChallenge, setHostKeyChallenge] = React.useState<{
    targetId: string
    token: string
    host: string
    port: number
    fingerprint: string
  } | null>(null)

  React.useEffect(() => {
    if (!loaded) {
      loadRemoteHostTargets().then((list) => {
        setTargets(list)
        setLoaded(true)
      })
    }
  }, [loaded])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function resetForm(): void {
    setForm(EMPTY_FORM)
    setEditingId(null)
  }

  function openCreate(): void {
    resetForm()
    setDialogOpen(true)
  }

  function openEdit(target: RemoteHostPublicTarget): void {
    setForm(targetToForm(target))
    setEditingId(target.id)
    setDialogOpen(true)
  }

  async function handleProbe(id: string): Promise<void> {
    setProbing((prev) => new Set(prev).add(id))
    setProbeErrors((prev) => { const m = new Map(prev); m.delete(id); return m })
    try {
      const hello = await probeRemoteHostTarget(id)
      setProbeResults((prev) => new Map(prev).set(id, hello))
      // Refresh targets to get updated lastHello
      const list = await loadRemoteHostTargets()
      setTargets(list)
    } catch (err: unknown) {
      const details = (err as { details?: { challenge?: string; fingerprint?: string } })?.details
      if (details?.challenge) {
        const target = targets.find((t) => t.id === id)
        setHostKeyChallenge({
          targetId: id,
          token: details.challenge,
          host: target?.ssh.host ?? '',
          port: target?.ssh.port ?? 22,
          fingerprint: details.fingerprint ?? '',
        })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        setProbeErrors((prev) => new Map(prev).set(id, msg))
      }
    } finally {
      setProbing((prev) => { const s = new Set(prev); s.delete(id); return s })
    }
  }

  async function handleConfirmHostKey(): Promise<void> {
    if (!hostKeyChallenge) return
    try {
      await confirmRemoteHostKey(
        hostKeyChallenge.token,
        hostKeyChallenge.host,
        hostKeyChallenge.port,
      )
      setHostKeyChallenge(null)
      await handleProbe(hostKeyChallenge.targetId)
    } catch {
      // error shown via probe state
    }
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      if (editingId) {
        await updateRemoteHostTarget(editingId, {
          name: form.name,
          ssh: {
            host: form.sshHost,
            port: parseInt(form.sshPort, 10) || 22,
            username: form.sshUsername,
            remoteHostPort: parseInt(form.remoteHostPort, 10) || 9754,
          },
        })
        if (form.bearerToken) {
          await window.electronAPI.remoteHost.setBearerToken(editingId, form.bearerToken)
        }
        if (form.sshPassword) {
          await window.electronAPI.remoteHost.setSshPassword(editingId, form.sshPassword)
        }
      } else {
        const target = await createRemoteHostTarget({
          name: form.name,
          ssh: {
            host: form.sshHost,
            port: parseInt(form.sshPort, 10) || 22,
            username: form.sshUsername,
            remoteHostPort: parseInt(form.remoteHostPort, 10) || 9754,
          },
        })
        if (form.bearerToken) {
          await window.electronAPI.remoteHost.setBearerToken(target.id, form.bearerToken)
        }
        if (form.sshPassword) {
          await window.electronAPI.remoteHost.setSshPassword(target.id, form.sshPassword)
        }
      }
      const list = await loadRemoteHostTargets()
      setTargets(list)
      setDialogOpen(false)
      resetForm()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    await deleteRemoteHostTarget(id)
    const list = await loadRemoteHostTargets()
    setTargets(list)
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Remote Host 连接"
        description="通过 SSH Tunnel 连接 Debian Remote Host，管理远端项目和 Agent 会话。"
      >
        <div className="flex items-center justify-between mb-4">
          <Button onClick={openCreate} size="sm">
            <Plus className="w-4 h-4 mr-2" />
            添加连接
          </Button>
        </div>

        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            暂无 Remote Host 连接
          </p>
        ) : (
          <div className="space-y-3">
            {targets.map((target) => {
              const isProbing = probing.has(target.id)
              const hello = target.lastHello ?? probeResults.get(target.id)
              const error = probeErrors.get(target.id)
              return (
                <SettingsCard
                  key={target.id}
                  className={activeId === target.id ? 'ring-2 ring-primary' : ''}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Server className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="font-medium truncate">{target.name}</span>
                        <Badge variant="outline" className="text-xs">SSH</Badge>
                        {hello && (
                          <Badge variant="secondary" className="text-xs">
                            v{hello.hostVersion}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {target.ssh.username}@{target.ssh.host}:{target.ssh.port} → :{target.ssh.remoteHostPort}
                      </p>
                      {isProbing && (
                        <p className="text-xs text-muted-foreground mt-1">探测中...</p>
                      )}
                      {error && (
                        <p className="text-xs text-destructive mt-1">{error}</p>
                      )}
                      {hello && (
                        <div className="flex gap-2 mt-2 flex-wrap">
                          {hello.runtimes.map((rt) => (
                            <Badge
                              key={rt.runtimeKind}
                              variant={rt.available ? 'default' : 'outline'}
                              className="text-xs"
                            >
                              {runtimeLabels[rt.runtimeKind] ?? rt.runtimeKind}
                              {rt.available ? ` v${rt.version}` : ' 不可用'}
                            </Badge>
                          ))}
                          {hello.deployment.mode === 'unsafe-dev-same-uid' && (
                            <Badge variant="destructive" className="text-xs gap-1">
                              <AlertTriangle className="w-3 h-3" />
                              非生产模式
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 ml-2 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleProbe(target.id)}
                        title="探测"
                        disabled={isProbing}
                      >
                        <RefreshCw className={`w-4 h-4 ${isProbing ? 'animate-spin' : ''}`} />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => openEdit(target)} title="编辑">
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(target.id)} title="删除">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </SettingsCard>
              )
            })}
          </div>
        )}
      </SettingsSection>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑连接' : '新建 Remote Host 连接'}</DialogTitle>
            <DialogDescription>
              通过 SSH Tunnel 连接 Debian 上的 Proma Remote Host 服务。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <SettingsInput
              label="连接名称"
              value={form.name}
              onChange={(v) => set('name', v)}
              placeholder="我的 Debian 服务器"
              required
            />

            <div className="grid grid-cols-2 gap-3">
              <SettingsInput
                label="SSH 主机"
                value={form.sshHost}
                onChange={(v) => set('sshHost', v)}
                placeholder="192.168.1.100"
                required
              />
              <SettingsInput
                label="SSH 端口"
                value={form.sshPort}
                onChange={(v) => set('sshPort', v)}
                placeholder="22"
              />
            </div>

            <SettingsInput
              label="SSH 用户名"
              value={form.sshUsername}
              onChange={(v) => set('sshUsername', v)}
              placeholder="root"
              required
            />

            <SettingsInput
              label="Remote Host 端口"
              value={form.remoteHostPort}
              onChange={(v) => set('remoteHostPort', v)}
              placeholder="9754"
            />

            <SettingsSecretInput
              label="SSH 密码（可选，推荐使用密钥）"
              value={form.sshPassword}
              onChange={(v) => set('sshPassword', v)}
              placeholder="SSH 登录密码"
            />

            <SettingsSecretInput
              label="Bearer Token"
              value={form.bearerToken}
              onChange={(v) => set('bearerToken', v)}
              placeholder="从 Remote Host pair 命令获取"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !form.name || !form.sshHost || !form.sshUsername}
            >
              {saving ? '保存中...' : editingId ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Host Key Challenge Dialog */}
      <Dialog open={!!hostKeyChallenge} onOpenChange={() => setHostKeyChallenge(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>SSH 主机指纹确认</DialogTitle>
            <DialogDescription>
              首次连接到该 SSH 主机，请确认指纹正确后再信任。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <SettingsCard>
              <p className="text-sm font-mono break-all">
                {hostKeyChallenge?.fingerprint}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                主机：{hostKeyChallenge?.host}:{hostKeyChallenge?.port}
              </p>
            </SettingsCard>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHostKeyChallenge(null)}>
              拒绝
            </Button>
            <Button onClick={handleConfirmHostKey}>
              信任并继续
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
