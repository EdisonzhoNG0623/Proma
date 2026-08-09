import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** 主配置与 backup 都不可解析时抛出，调用方必须停止写入。 */
export class HermesConfigCorruptError extends Error {
  constructor(filePath: string) {
    super(`Hermes 配置损坏且无法从备份恢复: ${filePath}`)
    this.name = 'HermesConfigCorruptError'
  }
}

function readAndDecode<T>(filePath: string, decode: (value: unknown) => T): T {
  const raw = readFileSync(filePath, 'utf8')
  return decode(JSON.parse(raw) as unknown)
}

/** 读取主配置；主文件损坏时只读 backup，两者都损坏则 fail closed。 */
export function readJsonWithBackup<T>(
  filePath: string,
  decode: (value: unknown) => T,
): T | null {
  const backupPath = `${filePath}.bak`
  if (!existsSync(filePath)) {
    return existsSync(backupPath) ? readAndDecode(backupPath, decode) : null
  }
  try {
    return readAndDecode(filePath, decode)
  } catch (primaryError) {
    if (existsSync(backupPath)) {
      try {
        return readAndDecode(backupPath, decode)
      } catch {
        // 统一抛下面的结构化错误，避免把配置正文带入日志。
      }
    }
    void primaryError
    throw new HermesConfigCorruptError(filePath)
  }
}

/** 小型 JSON 配置的原子写：先写 tmp/fsync，再备份旧文件并替换。 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tempPath = `${filePath}.tmp`
  const backupPath = `${filePath}.bak`
  const serialized = JSON.stringify(value, null, 2)

  writeFileSync(tempPath, serialized, 'utf8')
  const fd = openSync(tempPath, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  if (existsSync(filePath)) {
    copyFileSync(filePath, backupPath)
  }

  try {
    renameSync(tempPath, filePath)
  } catch (error) {
    // Windows 某些文件系统不允许 rename 覆盖；旧文件已有 backup，安全回退。
    if (existsSync(filePath)) rmSync(filePath)
    try {
      renameSync(tempPath, filePath)
    } catch {
      rmSync(tempPath, { force: true })
      throw error
    }
  }
}
