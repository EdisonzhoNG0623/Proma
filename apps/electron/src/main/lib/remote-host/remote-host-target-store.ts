import { randomUUID } from 'node:crypto'
import type { RemoteHostTarget, RemoteHostTargetCreateInput, RemoteHostTargetUpdateInput } from '@proma/shared'
import { DEFAULT_REMOTE_HOST_PORT, DEFAULT_REMOTE_HOST_SSH_PORT } from '@proma/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'

const REMOTE_HOST_TARGETS_VERSION = 1

interface RemoteHostTargetsConfig {
  version: number
  targets: RemoteHostTarget[]
}

function defaultPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRemoteHostTargetsPath } = require('../config-paths') as typeof import('../config-paths')
  return getRemoteHostTargetsPath()
}

function validateSshConfig(ssh: RemoteHostTargetCreateInput['ssh']): RemoteHostTarget['ssh'] {
  const host = ssh.host.trim()
  const username = ssh.username.trim()
  if (!host) throw new Error('SSH 主机不能为空')
  if (!username) throw new Error('SSH 用户名不能为空')
  if (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535) {
    throw new Error('SSH 端口必须在 1-65535 之间')
  }
  const remoteHostPort = ssh.remoteHostPort ?? DEFAULT_REMOTE_HOST_PORT
  if (!Number.isInteger(remoteHostPort) || remoteHostPort < 1 || remoteHostPort > 65535) {
    throw new Error('Remote Host 端口必须在 1-65535 之间')
  }
  return {
    host,
    port: ssh.port ?? DEFAULT_REMOTE_HOST_SSH_PORT,
    username,
    remoteHostPort,
  }
}

export function normalizeRemoteHostTargetCreateInput(
  input: RemoteHostTargetCreateInput,
  now: number = Date.now(),
): RemoteHostTarget {
  const name = input.name.trim()
  if (!name) throw new Error('Remote Host 连接名称不能为空')
  const ssh = validateSshConfig(input.ssh)
  return {
    id: randomUUID(),
    name,
    transport: 'ssh',
    ssh,
    hasBearerCredential: false,
    createdAt: now,
    updatedAt: now,
  }
}

function decodeConfig(value: unknown): RemoteHostTargetsConfig {
  if (!value || typeof value !== 'object') throw new Error('remote-host-targets.json 结构不合法')
  const data = value as { version?: unknown; targets?: unknown }
  if (!Array.isArray(data.targets)) throw new Error('remote-host-targets.json 结构不合法（targets 必须为数组）')
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    targets: data.targets as RemoteHostTarget[],
  }
}

export class RemoteHostTargetStore {
  constructor(private readonly filePath: string = defaultPath()) {}

  private readConfig(): RemoteHostTargetsConfig {
    return readJsonFileSafe<RemoteHostTargetsConfig>(this.filePath)
      ?? { version: REMOTE_HOST_TARGETS_VERSION, targets: [] }
  }

  private writeConfig(config: RemoteHostTargetsConfig): void {
    writeJsonFileAtomic(this.filePath, {
      version: REMOTE_HOST_TARGETS_VERSION,
      targets: config.targets,
    })
  }

  listTargets(): RemoteHostTarget[] {
    return [...this.readConfig().targets].sort((a, b) => a.createdAt - b.createdAt)
  }

  getTarget(id: string): RemoteHostTarget | null {
    return this.readConfig().targets.find((t) => t.id === id) ?? null
  }

  createTarget(input: RemoteHostTargetCreateInput): RemoteHostTarget {
    const target = normalizeRemoteHostTargetCreateInput(input)
    const config = this.readConfig()
    config.targets.push(target)
    this.writeConfig(config)
    console.log(`[Remote Host] 已创建连接: ${target.name}`)
    return target
  }

  updateTarget(id: string, input: RemoteHostTargetUpdateInput): RemoteHostTarget {
    const config = this.readConfig()
    const index = config.targets.findIndex((t) => t.id === id)
    if (index < 0) throw new Error(`Remote Host Target 不存在: ${id}`)
    const current = config.targets[index]!
    const name = input.name?.trim() || current.name
    if (!name) throw new Error('Remote Host 连接名称不能为空')
    const ssh = input.ssh ? validateSshConfig(input.ssh) : current.ssh
    const updated: RemoteHostTarget = {
      ...current,
      name,
      ssh,
      lastHello: input.lastHello !== undefined ? (input.lastHello ?? undefined) : current.lastHello,
      updatedAt: Date.now(),
    }
    config.targets[index] = updated
    this.writeConfig(config)
    console.log(`[Remote Host] 已更新连接: ${updated.name}`)
    return updated
  }

  deleteTarget(id: string): RemoteHostTarget | null {
    const config = this.readConfig()
    const index = config.targets.findIndex((t) => t.id === id)
    if (index < 0) return null
    const [removed] = config.targets.splice(index, 1)
    this.writeConfig(config)
    console.log(`[Remote Host] 已删除连接: ${removed?.name}`)
    return removed ?? null
  }
}

export const remoteHostTargetStore = new RemoteHostTargetStore()
