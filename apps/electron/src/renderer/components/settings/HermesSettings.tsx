/**
 * HermesSettings - Hermes Remote 设置面板
 *
 * 管理远端 Hermes 连接（target）：
 * - 连接列表（Direct / SSH Tunnel，状态、版本、能力展示）
 * - 创建/编辑表单（连接信息 + 认证配置）
 * - 连接测试与能力探测
 *
 * 安全约束：密码 / API key 只经 IPC 交给主进程加密存储，本地 state 中
 * 不保存明文（输入框为受控密码框，提交后立即清空）。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Plus, RefreshCw, Trash2, Pencil, PlugZap, Server, KeyRound } from 'lucide-react'
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
import { SettingsSelect } from './primitives/SettingsSelect'
import { SettingsSegmentedControl } from './primitives/SettingsSegmentedControl'
import { SettingsSection } from './primitives/SettingsSection'
import { hermesTargetsAtom, activeHermesTargetIdAtom } from '@/atoms/hermes-atoms'
import {
  loadHermesTargets,
  createHermesTarget,
  updateHermesTarget,
  deleteHermesTarget,
} from '@/atoms/hermes-atoms'
import type {
  HermesTarget,
  HermesCapabilities,
  HermesConnectionTestResult,
} from '@proma/shared'

interface HermesFormState {
  name: string
  mode: 'direct' | 'ssh-tunnel'
  remoteUrl: string
  sshHost: string
  sshPort: string
  sshUsername: string
  dashboardProvider: string
  username: string
  password: string
  apiServerKey: string
  sshPassword: string
}

const EMPTY_FORM: HermesFormState = {
  name: '',
  mode: 'direct',
  remoteUrl: '',
  sshHost: '',
  sshPort: '22',
  sshUsername: '',
  dashboardProvider: 'basic',
  username: '',
  password: '',
  apiServerKey: '',
  sshPassword: '',
}

function targetToForm(target: HermesTarget): HermesFormState {
  return {
    name: target.name,
    mode: target.mode,
    remoteUrl: target.remoteUrl ?? '',
    sshHost: target.ssh?.host ?? '',
    sshPort: String(target.ssh?.port ?? 22),
    sshUsername: target.ssh?.username ?? '',
    dashboardProvider: target.auth.dashboardProvider ?? 'basic',
    username: '',
    password: '',
    apiServerKey: '',
    sshPassword: '',
  }
}

/** 单个 target 卡片 */
function TargetCard({
  target,
  onEdit,
  onDelete,
  onTest,
  onActivate,
}: {
  target: HermesTarget
  onEdit: () => void
  onDelete: () => void
  onTest: () => void
  onActivate: () => void
}): React.ReactElement {
  const snapshot = target.lastCapabilitySnapshot
  const host = target.mode === 'direct'
    ? (target.remoteUrl ?? '')
    : `${target.ssh?.username ?? ''}@${target.ssh?.host ?? ''}:${target.ssh?.port ?? 22}`

  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{target.name}</span>
          <Badge variant={target.mode === 'direct' ? 'secondary' : 'outline'}>
            {target.mode === 'direct' ? 'Direct' : 'SSH'}
          </Badge>
          {snapshot && (
            <Badge variant="outline" className="text-xs">
              v{snapshot.version ?? '?'} · {serviceClassLabel(snapshot.serviceClass)}
            </Badge>
          )}
        </div>
        <div className="mt-1 truncate text-sm text-muted-foreground">{host}</div>
        {snapshot?.dashboard?.authRequired && (
          <div className="mt-1 text-xs text-muted-foreground">
            认证：{snapshot.dashboard.authFlows.join(' / ') || '已开启'}
            {snapshot.dashboard.supportsPassword && ' · 支持密码登录'}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon" title="测试连接" onClick={onTest}>
          <PlugZap size={16} />
        </Button>
        <Button variant="ghost" size="icon" title="设为当前" onClick={onActivate}>
          <Server size={16} />
        </Button>
        <Button variant="ghost" size="icon" title="编辑" onClick={onEdit}>
          <Pencil size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="删除"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 size={16} />
        </Button>
      </div>
    </div>
  )
}

function serviceClassLabel(serviceClass: HermesCapabilities['serviceClass']): string {
  switch (serviceClass) {
    case 'both':
      return 'Dashboard + API'
    case 'dashboard-only':
      return 'Dashboard'
    case 'api-only':
      return 'API Server'
    case 'protocol-incompatible':
      return '协议不兼容'
    case 'unreachable':
      return '不可达'
    default:
      return '未探测'
  }
}

/** 创建/编辑表单弹层 */
function HermesTargetForm({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: HermesTarget | null
  onClose: () => void
  onSaved: () => void
}): React.ReactElement | null {
  const [form, setForm] = React.useState<HermesFormState>(EMPTY_FORM)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [testResult, setTestResult] = React.useState<HermesConnectionTestResult | null>(null)
  const [testing, setTesting] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setForm(editing ? targetToForm(editing) : EMPTY_FORM)
      setError(null)
      setTestResult(null)
    }
  }, [open, editing])

  if (!open) return null

  const set = <K extends keyof HermesFormState>(key: K, value: HermesFormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const isDirect = form.mode === 'direct'
      const input = {
        name: form.name,
        mode: form.mode,
        ...(isDirect ? { remoteUrl: form.remoteUrl } : {}),
        ...(!isDirect
          ? {
              ssh: {
                host: form.sshHost,
                port: Number(form.sshPort) || 22,
                username: form.sshUsername,
              },
            }
          : {}),
      }
      // 创建或更新 target
      let target: HermesTarget
      if (editing) {
        target = await updateHermesTarget(editing.id, input)
      } else {
        target = await createHermesTarget(input)
      }
      // 保存凭据（仅用户填写时）
      if (form.password) {
        await window.electronAPI.hermes.setDashboardPassword({
          targetId: target.id,
          provider: form.dashboardProvider || 'basic',
          username: form.username,
          password: form.password,
        })
      }
      if (form.apiServerKey) {
        await window.electronAPI.hermes.setApiServerKey({
          targetId: target.id,
          secret: form.apiServerKey,
        })
      }
      if (!isDirect && form.sshPassword) {
        await window.electronAPI.hermes.setSshPassword({
          targetId: target.id,
          secret: form.sshPassword,
        })
      }
      // 探测能力
      await window.electronAPI.hermes.probeTarget(target.id)
      // 清空密码 state
      setForm((prev) => ({ ...prev, password: '', apiServerKey: '', sshPassword: '' }))
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setError(null)
    try {
      // 测试使用当前表单临时创建的 target 或现有 target
      let targetId = editing?.id
      if (!targetId) {
        const input = {
          name: form.name || '连接测试',
          mode: form.mode,
          ...(form.mode === 'direct' ? { remoteUrl: form.remoteUrl } : {}),
          ...(form.mode === 'ssh-tunnel'
            ? {
                ssh: {
                  host: form.sshHost,
                  port: Number(form.sshPort) || 22,
                  username: form.sshUsername,
                },
              }
            : {}),
        }
        const temp = await createHermesTarget(input)
        targetId = temp.id
      }
      const result = await window.electronAPI.hermes.testConnection(targetId!)
      setTestResult(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(openChange) => !openChange && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑 Hermes 连接' : '新建 Hermes 连接'}</DialogTitle>
          <DialogDescription>
            连接局域网 / VPS 上既有的 Hermes Agent（Dashboard 或 API Server）。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <SettingsSection title="连接信息">
            <SettingsInput
              label="连接名称"
              value={form.name}
              onChange={(v) => set('name', v)}
              placeholder="例如：实验室 Hermes"
              required
            />
            <SettingsSegmentedControl
              label="连接方式"
              options={[
                { value: 'direct', label: 'Direct URL' },
                { value: 'ssh-tunnel', label: 'SSH Tunnel' },
              ]}
              value={form.mode}
              onValueChange={(v) => set('mode', v as HermesFormState['mode'])}
            />
            {form.mode === 'direct' ? (
              <SettingsInput
                label="远端 URL"
                value={form.remoteUrl}
                onChange={(v) => set('remoteUrl', v)}
                placeholder="https://hermes.example.com 或 http://127.0.0.1:9119"
                required
              />
            ) : (
              <>
                <SettingsInput
                  label="SSH 主机"
                  value={form.sshHost}
                  onChange={(v) => set('sshHost', v)}
                  placeholder="vps.example.com"
                  required
                />
                <SettingsInput
                  label="SSH 端口"
                  value={form.sshPort}
                  onChange={(v) => set('sshPort', v)}
                  placeholder="22"
                />
                <SettingsInput
                  label="SSH 用户名"
                  value={form.sshUsername}
                  onChange={(v) => set('sshUsername', v)}
                  placeholder="deploy"
                  required
                />
              </>
            )}
          </SettingsSection>

          <SettingsSection title="Dashboard 认证">
            <SettingsInput
              label="登录 Provider"
              value={form.dashboardProvider}
              onChange={(v) => set('dashboardProvider', v)}
              placeholder="basic"
            />
            <SettingsInput
              label="用户名"
              value={form.username}
              onChange={(v) => set('username', v)}
              placeholder="admin"
            />
            <SettingsSecretInput
              label="密码"
              value={form.password}
              onChange={(v) => set('password', v)}
              placeholder="仅用于登录，加密存储"
            />
          </SettingsSection>

          <SettingsSection title="API Server（可选）">
            <SettingsSecretInput
              label="API Server Key"
              value={form.apiServerKey}
              onChange={(v) => set('apiServerKey', v)}
              placeholder="Bearer key，用于 API Server 协议"
            />
          </SettingsSection>

          {form.mode === 'ssh-tunnel' && (
            <SettingsSection title="SSH 密码（可选）">
              <SettingsSecretInput
                label="SSH 密码"
                value={form.sshPassword}
                onChange={(v) => set('sshPassword', v)}
                placeholder="不使用密钥时填写"
              />
            </SettingsSection>
          )}

          {testResult && (
            <div className="rounded-md border p-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant={testResult.ok ? 'default' : 'destructive'}>
                  {testResult.ok ? '连接成功' : '连接失败'}
                </Badge>
                {testResult.version && <span>v{testResult.version}</span>}
              </div>
              {testResult.ok ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {serviceClassLabel(testResult.serviceClass!)}
                  {testResult.authRequired && ' · 需要认证'}
                  {testResult.supportsPassword && ' · 支持密码登录'}
                </div>
              ) : (
                <div className="mt-1 text-xs text-destructive">{testResult.error}</div>
              )}
            </div>
          )}

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleTest} disabled={testing || saving}>
            {testing ? '测试中...' : '测试连接'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Hermes 设置主面板 */
export function HermesSettings(): React.ReactElement {
  const [targets, setTargets] = useAtom(hermesTargetsAtom)
  const [activeTargetId, setActiveTargetId] = useAtom(activeHermesTargetIdAtom)
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<HermesTarget | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  const refresh = React.useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      setTargets(await loadHermesTargets())
    } finally {
      setRefreshing(false)
    }
  }, [setTargets])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const handleNew = (): void => {
    setEditing(null)
    setFormOpen(true)
  }

  const handleEdit = (target: HermesTarget): void => {
    setEditing(target)
    setFormOpen(true)
  }

  const handleDelete = async (target: HermesTarget): Promise<void> => {
    if (!window.confirm(`确定删除 Hermes 连接「${target.name}」？关联凭据将一并清理。`)) {
      return
    }
    await deleteHermesTarget(target.id)
    if (activeTargetId === target.id) {
      setActiveTargetId(null)
    }
    void refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Hermes 远程连接</h2>
          <p className="text-sm text-muted-foreground">
            以客户端身份连接远端 Hermes Agent，会话与 Proma 本地完全隔离。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw size={16} className="mr-1" />
            刷新
          </Button>
          <Button size="sm" onClick={handleNew}>
            <Plus size={16} className="mr-1" />
            新建连接
          </Button>
        </div>
      </div>

      {targets.length === 0 ? (
        <SettingsCard>
          <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <KeyRound size={24} />
            <p>还没有 Hermes 连接。点击「新建连接」添加远端 Hermes。</p>
          </div>
        </SettingsCard>
      ) : (
        <SettingsCard>
          {targets.map((target) => (
            <TargetCard
              key={target.id}
              target={target}
              onEdit={() => handleEdit(target)}
              onDelete={() => void handleDelete(target)}
              onTest={async () => {
                const result = await window.electronAPI.hermes.testConnection(target.id)
                if (result.ok) {
                  window.alert(`连接成功：${serviceClassLabel(result.serviceClass!)}${result.authRequired ? '（需认证）' : ''}`)
                } else {
                  window.alert(`连接失败：${result.error}`)
                }
                void refresh()
              }}
              onActivate={() => setActiveTargetId(target.id)}
            />
          ))}
        </SettingsCard>
      )}

      <HermesTargetForm
        open={formOpen}
        editing={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => void refresh()}
      />
    </div>
  )
}
