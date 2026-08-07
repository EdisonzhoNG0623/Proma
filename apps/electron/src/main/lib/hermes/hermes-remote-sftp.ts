/**
 * Hermes Remote SFTP 服务
 *
 * 通过 SSH/SFTP 与远端 Hermes 主机进行文件传输，支持：
 * - 目录/文件浏览与 stat
 * - 文件上传/下载（文本与二进制）
 * - 项目目录递归同步（增量：对比 mtime/size）
 *
 * 凭据安全：SSH 密码/私钥来自 CredentialStore（safeStorage 加密），
 * 不在命令行或日志中出现。
 */

import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { statSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { HermesError } from './hermes-errors'

/** SFTP 连接配置 */
export interface HermesSftpAuth {
  host: string
  port: number
  username: string
  /** SSH 密码（可选；与 privateKey 二选一） */
  password?: string
  /** SSH 私钥内容（可选） */
  privateKey?: string
}

/** 远端文件条目 */
export interface HermesRemoteFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

/** 同步结果 */
export interface HermesSyncResult {
  uploaded: number
  skipped: number
  failed: number
  /** 失败的路径 */
  errors: string[]
}

/**
 * 判断本地文件是否需要上传（增量对比：远端不存在、大小不同、或 mtime 差异 > 1s）。
 * 纯函数，便于测试。
 */
export function shouldUploadFile(
  remoteStat: HermesRemoteFileEntry | null,
  localStat: { size: number; mtimeMs: number },
): boolean {
  if (!remoteStat) return true
  if (remoteStat.size !== localStat.size) return true
  return Math.abs(remoteStat.mtimeMs - localStat.mtimeMs) > 1000
}

/**
 * Remote SFTP 服务
 */
export class HermesRemoteSftp {
  private connection: Client | null = null
  private sftp: SFTPWrapper | null = null

  /** 建立 SSH + SFTP 连接 */
  async connect(auth: HermesSftpAuth): Promise<void> {
    if (this.connection) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      const connection = new Client()
      connection.on('error', (error) => {
        reject(new HermesError(`SSH 连接失败: ${error.message}`, 'ssh'))
      })
      connection.on('ready', () => {
        connection.sftp((error: Error | undefined, sftp?: SFTPWrapper) => {
          if (error || !sftp) {
            reject(new HermesError(`SFTP 初始化失败: ${error?.message ?? 'unknown'}`, 'ssh'))
            return
          }
          this.connection = connection
          this.sftp = sftp
          resolve()
        })
      })
      connection.connect({
        host: auth.host,
        port: auth.port,
        username: auth.username,
        ...(auth.password ? { password: auth.password } : {}),
        ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
        readyTimeout: 10_000,
      } as ConnectConfig)
    })
  }

  /** 列出远端目录 */
  async listDir(remotePath: string): Promise<HermesRemoteFileEntry[]> {
    const sftp = this.requireSftp()
    const entries = await new Promise<Array<{ filename: string; longname: string; attrs: { size: number; mtime: number; mode: number } }>>((resolve, reject) => {
      sftp.readdir(remotePath, (error, list) => {
        if (error) reject(error)
        else resolve(list)
      })
    })
    return entries.map((entry) => ({
      name: entry.filename,
      path: join(remotePath, entry.filename),
      isDirectory: (entry.attrs.mode & 0o170000) === 0o040000,
      size: entry.attrs.size,
      mtimeMs: entry.attrs.mtime * 1000,
    }))
  }

  /** stat 远端路径（不存在返回 null） */
  async stat(remotePath: string): Promise<HermesRemoteFileEntry | null> {
    const sftp = this.requireSftp()
    try {
      const attrs = await new Promise<{ size: number; mtime: number; mode: number }>((resolve, reject) => {
        sftp.stat(remotePath, (error, stats) => {
          if (error) reject(error)
          else resolve(stats)
        })
      })
      return {
        name: basename(remotePath),
        path: remotePath,
        isDirectory: (attrs.mode & 0o170000) === 0o040000,
        size: attrs.size,
        mtimeMs: attrs.mtime * 1000,
      }
    } catch {
      return null
    }
  }

  /** 递归创建远端目录 */
  async mkdirp(remotePath: string): Promise<void> {
    const sftp = this.requireSftp()
    const parts = remotePath.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current = `${current}/${part}`
      const existing = await this.stat(current)
      if (existing?.isDirectory) continue
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (error) => {
          // EEXIST 视为成功
          if (error && (error as NodeJS.ErrnoException).code !== 'EEXIST') reject(error)
          else resolve()
        })
      })
    }
  }

  /** 上传单个文件（覆盖远端） */
  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const sftp = this.requireSftp()
    const data = readFileSync(localPath)
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, data, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /** 读取远端文本文件 */
  async readFile(remotePath: string): Promise<string> {
    const sftp = this.requireSftp()
    const data = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(remotePath, (error, buffer) => {
        if (error) reject(error)
        else resolve(buffer)
      })
    })
    return data.toString('utf-8')
  }

  /**
   * 同步本地目录到远端（增量：对比 mtime/size）。
   *
   * @param localDir 本地目录
   * @param remoteDir 远端目标目录
   * @param options.filter 过滤函数（返回 false 跳过文件）
   * @param options.skipDelete 是否跳过删除远端多余文件（默认 true 安全）
   */
  async syncDir(
    localDir: string,
    remoteDir: string,
    options: { filter?: (relativePath: string) => boolean; skipDelete?: boolean } = {},
  ): Promise<HermesSyncResult> {
    await this.mkdirp(remoteDir)
    const result: HermesSyncResult = { uploaded: 0, skipped: 0, failed: 0, errors: [] }

    const walk = async (localPath: string, remotePath: string, relPath: string): Promise<void> => {
      if (!existsSync(localPath)) return
      const localStat = statSync(localPath)
      if (localStat.isDirectory()) {
        await this.mkdirp(remotePath)
        for (const child of readdirSync(localPath)) {
          const childLocal = join(localPath, child)
          const childRemote = `${remotePath}/${child}`
          const childRel = relPath ? `${relPath}/${child}` : child
          if (options.filter && !options.filter(childRel)) continue
          await walk(childLocal, childRemote, childRel)
        }
        return
      }
      // 文件：对比远端 mtime/size，变化才上传
      const remoteStat = await this.stat(remotePath)
      const needsUpload = shouldUploadFile(remoteStat, {
        size: localStat.size,
        mtimeMs: localStat.mtimeMs,
      })
      if (!needsUpload) {
        result.skipped += 1
        return
      }
      try {
        await this.uploadFile(localPath, remotePath)
        result.uploaded += 1
      } catch (error) {
        result.failed += 1
        result.errors.push(relPath)
        console.error(`[Hermes SFTP] 上传失败 ${relPath}:`, error instanceof Error ? error.message : String(error))
      }
    }

    await walk(localDir, remoteDir, '')
    return result
  }

  /** 关闭连接 */
  close(): void {
    try {
      this.sftp?.end()
    } catch {
      // 忽略
    }
    this.connection?.end()
    this.connection = null
    this.sftp = null
  }

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) {
      throw new HermesError('SFTP 未连接', 'ssh')
    }
    return this.sftp
  }
}
