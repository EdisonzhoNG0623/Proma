import path from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { HermesError } from './hermes-errors'
import { HermesSshConnection } from './transport/hermes-ssh-connection'

export const HERMES_REMOTE_TEXT_MAX_BYTES = 5 * 1024 * 1024
const FILE_TYPE_MASK = 0o170000
const DIRECTORY_MODE = 0o040000
const REGULAR_MODE = 0o100000
const SYMLINK_MODE = 0o120000

export interface HermesSftpAuth {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface HermesRemoteFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

interface SftpAttrs { size: number; mtime: number; mode: number }

export function assertSafeProjectName(name: string): string {
  const trimmed = name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new HermesError('远端项目名仅允许 1-64 位字母、数字、点、下划线和短横线', 'invalid-response')
  }
  return trimmed
}

export function assertContainedPosixPath(rootPath: string, remotePath: string): string {
  const root = path.posix.resolve('/', rootPath)
  const requested = remotePath.startsWith('/')
    ? path.posix.resolve('/', remotePath)
    : path.posix.resolve(root, remotePath)
  if (requested !== root && !requested.startsWith(`${root}/`)) {
    throw new HermesError('远端路径越出允许的项目根目录', 'invalid-response')
  }
  return requested
}

export function decodeUtf8Text(data: Buffer): string {
  if (data.includes(0)) throw new HermesError('远端文件是二进制文件，拒绝作为文本读取', 'invalid-response')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new HermesError('远端文件不是有效 UTF-8 文本', 'invalid-response')
  }
}

function promisifyAttrs(
  invoke: (callback: (error: Error | undefined, attrs?: SftpAttrs) => void) => void,
): Promise<SftpAttrs> {
  return new Promise((resolve, reject) => invoke((error, attrs) => {
    if (error || !attrs) reject(error ?? new Error('missing attrs'))
    else resolve(attrs)
  }))
}

/** Hardened explicit SFTP browser. No recursive local-directory synchronization. */
export class HermesRemoteSftp {
  private sftp: SFTPWrapper | null = null
  private ownedConnection: HermesSshConnection | null = null

  constructor(private readonly sharedConnection?: HermesSshConnection) {}

  async connect(auth?: HermesSftpAuth): Promise<void> {
    if (this.sftp) return
    if (this.sharedConnection) {
      this.sftp = await this.sharedConnection.openSftp()
      return
    }
    if (!auth) throw new HermesError('SFTP 缺少 SSH 认证', 'ssh')
    this.ownedConnection = await HermesSshConnection.connect(auth, { endpoints: {} })
    this.sftp = await this.ownedConnection.openSftp()
  }

  private realpath(remotePath: string): Promise<string> {
    const sftp = this.requireSftp()
    return new Promise((resolve, reject) => sftp.realpath(remotePath, (error, resolved) => {
      if (error) reject(error)
      else resolve(path.posix.normalize(resolved))
    }))
  }

  private async canonicalRoot(rootPath: string): Promise<string> {
    // ssh2 realpath expands ~ on the remote host; all later checks use canonical absolute paths.
    return path.posix.normalize(await this.realpath(rootPath))
  }

  private async containedExistingPath(rootPath: string, remotePath: string): Promise<{ root: string; resolved: string }> {
    const root = await this.canonicalRoot(rootPath)
    const lexical = assertContainedPosixPath(root, remotePath)
    const resolved = await this.realpath(lexical)
    assertContainedPosixPath(root, resolved)
    return { root, resolved }
  }

  async listDir(rootPath: string, remotePath: string): Promise<HermesRemoteFileEntry[]> {
    const { root, resolved } = await this.containedExistingPath(rootPath, remotePath)
    const attrs = await this.lstat(resolved)
    if ((attrs.mode & FILE_TYPE_MASK) === SYMLINK_MODE) throw new HermesError('默认拒绝浏览符号链接', 'invalid-response')
    if ((attrs.mode & FILE_TYPE_MASK) !== DIRECTORY_MODE) throw new HermesError('远端路径不是目录', 'invalid-response')
    const entries = await new Promise<Array<{ filename: string; attrs: SftpAttrs }>>((resolve, reject) => {
      this.requireSftp().readdir(resolved, (error, list) => error ? reject(error) : resolve(list))
    })
    return entries.flatMap((entry) => {
      const mode = entry.attrs.mode & FILE_TYPE_MASK
      if (mode === SYMLINK_MODE) return []
      const entryPath = assertContainedPosixPath(root, path.posix.join(resolved, entry.filename))
      return [{
        name: entry.filename,
        path: entryPath,
        isDirectory: mode === DIRECTORY_MODE,
        size: entry.attrs.size,
        mtimeMs: entry.attrs.mtime * 1000,
      }]
    })
  }

  async readFile(rootPath: string, remotePath: string, maxBytes = HERMES_REMOTE_TEXT_MAX_BYTES): Promise<string> {
    const cap = Math.max(1, Math.min(maxBytes, HERMES_REMOTE_TEXT_MAX_BYTES))
    const { resolved } = await this.containedExistingPath(rootPath, remotePath)
    const attrs = await this.lstat(resolved)
    const mode = attrs.mode & FILE_TYPE_MASK
    if (mode === SYMLINK_MODE) throw new HermesError('默认拒绝读取符号链接', 'invalid-response')
    if (mode !== REGULAR_MODE) throw new HermesError('远端路径不是普通文件', 'invalid-response')
    if (attrs.size > cap) throw new HermesError(`远端文件超过 ${cap} 字节读取上限`, 'invalid-response')
    const data = await new Promise<Buffer>((resolve, reject) => {
      this.requireSftp().readFile(resolved, (error, buffer) => error ? reject(error) : resolve(buffer))
    })
    if (data.length > cap) throw new HermesError(`远端文件超过 ${cap} 字节读取上限`, 'invalid-response')
    return decodeUtf8Text(data)
  }

  async createProject(rootPath: string, name: string): Promise<string> {
    const safeName = assertSafeProjectName(name)
    const root = await this.canonicalRoot(rootPath)
    const child = assertContainedPosixPath(root, path.posix.join(root, safeName))
    await new Promise<void>((resolve, reject) => {
      this.requireSftp().mkdir(child, (error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'EEXIST') reject(error)
        else resolve()
      })
    })
    const resolved = await this.realpath(child)
    assertContainedPosixPath(root, resolved)
    return resolved
  }

  private lstat(remotePath: string): Promise<SftpAttrs> {
    return promisifyAttrs((callback) => this.requireSftp().lstat(remotePath, callback))
  }

  close(): void {
    try { this.sftp?.end() } catch { /* ignore close race */ }
    this.sftp = null
    if (this.ownedConnection) void this.ownedConnection.close()
    this.ownedConnection = null
  }

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) throw new HermesError('SFTP 未连接', 'ssh')
    return this.sftp
  }
}
