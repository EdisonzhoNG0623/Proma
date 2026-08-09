import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getConfigDir } from '../config-paths'

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

export interface HermesMaterializedAttachment {
  localPath: string
  name: string
  mimeType: string
  size: number
}

function decodeDataUrl(dataUrl: string): { bytes: Buffer; mimeType: string } {
  const match = /^data:([^;,]*)(?:;[^;,=]+=[^;,]+)*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim())
  if (!match) throw new Error('Hermes 附件响应不是有效的 base64 data URL')
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64')
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Hermes 附件大小必须在 1 到 ${MAX_ATTACHMENT_BYTES} 字节之间`)
  }
  return { bytes, mimeType: match[1] || 'application/octet-stream' }
}

function safeName(input: string): string {
  const leaf = basename(input.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return leaf && leaf !== '.' && leaf !== '..' ? leaf.slice(0, 180) : 'attachment.bin'
}

/**
 * 将远端真源返回的 data URL 物化为可删除、可重建的本地预览缓存。
 * 缓存不参与历史身份或消息恢复；删除后下次点击会重新从 Hermes 拉取。
 */
export function materializeHermesAttachment(input: {
  cacheIdentity: string
  dataUrl: string
  name: string
}): HermesMaterializedAttachment {
  const { bytes, mimeType } = decodeDataUrl(input.dataUrl)
  const name = safeName(input.name)
  const digest = createHash('sha256').update(input.cacheIdentity).update('\0').update(bytes).digest('hex')
  const dir = join(getConfigDir(), 'cache', 'hermes-attachments')
  mkdirSync(dir, { recursive: true })
  const localPath = join(dir, `${digest.slice(0, 24)}-${name}`)
  if (!existsSync(localPath)) {
    const tempPath = `${localPath}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(tempPath, bytes, { flag: 'wx', mode: 0o600 })
      renameSync(tempPath, localPath)
    } finally {
      rmSync(tempPath, { force: true })
    }
  }
  return { localPath, name, mimeType, size: bytes.length }
}
