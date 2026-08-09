/**
 * 从 Hermes 消息文本中提取图片引用（Hermes → Proma 收图）。
 *
 * Hermes 历史/流式消息把图片以多种形式嵌入文本：
 *  1. data: URL（_coerce_message_text 把 image_url data: 追加进文本）
 *  2. MEDIA:<path-or-url> 显式 token（hermes-agent 媒体交付协议）
 *  3. 绝对路径（Hermes 生成图片路径，如 /home/ai/.hermes/images/xxx.png）
 *  4. http(s) URL（如 /api/media?path= 或完整图片 URL）
 */

export interface HermesMediaRef {
  /** 图片扩展名（用于展示/下载） */
  ext?: string
  /** data: URL（直接显示） */
  dataUrl?: string
  /** 远端路径或 URL（需经主进程 /api/media 拉取） */
  remotePath?: string
}

export interface HermesFileRef {
  name: string
  remotePath: string
}

const DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi
// Hermes 持久化消息的附件指令。file 支持 Hermes formatRefValue 的三种引号。
const HERMES_IMAGE_DIRECTIVE_RE = /@image:([^\s\n]+)/gi
const HERMES_FILE_DIRECTIVE_RE = /@file:(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|(\S+))/gi
const MEDIA_TOKEN_RE = /MEDIA:[ \t]*(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|(\S+))/gi
// 绝对路径图片：/foo/bar.png（整行或内联，图片扩展名结尾）
const IMAGE_PATH_RE = /(?:^|[\s(\[])((\/[^\s)\]"'`]+)\.(png|jpe?g|gif|webp|svg|bmp|avif))(?=[\s)\]"'`.,;:!?]|$)/gi
// http(s) 图片 URL
const HTTP_IMAGE_URL_RE = /(https?:\/\/[^\s)\]"'`]+\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?[^\s)\]"'`]*)?)/gi

const IMAGE_EXT_SET = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])

export function isImagePathLike(input: string): boolean {
  const clean = input.split('?')[0] ?? input
  const dot = clean.lastIndexOf('.')
  if (dot < 0) return false
  const ext = clean.slice(dot + 1).toLowerCase()
  return IMAGE_EXT_SET.has(ext)
}

export function extractHermesFiles(text: string): HermesFileRef[] {
  if (!text) return []
  const files: HermesFileRef[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(HERMES_FILE_DIRECTIVE_RE)) {
    const remotePath = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim()
    if (!remotePath || seen.has(remotePath)) continue
    seen.add(remotePath)
    const normalized = remotePath.replace(/\\/g, '/')
    files.push({ name: normalized.split('/').pop() || '附件', remotePath })
  }
  return files.slice(0, 8)
}

/** 去掉展示专用附件指令；媒体/文件由独立块渲染，不把远端路径暴露成正文。 */
export function stripHermesAttachmentDirectives(text: string): string {
  const hasImageDirective = /@image:/i.test(text)
  const cleaned = text
    .replace(HERMES_IMAGE_DIRECTIVE_RE, '')
    .replace(HERMES_FILE_DIRECTIVE_RE, '')
    // file.attach expands binary/text context for the model inside the persisted
    // user row. It is execution context, not user-authored chat text.
    .replace(/(?:^|\n)\s*-{3}\s*Attached Context\s*-{3}[\s\S]*$/i, '')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // Hermes adds this presentation sentinel to image-only persisted user rows.
  // The actual image block already communicates it; rendering the label is noise.
  return hasImageDirective
    ? cleaned.replace(/^\s*\[screenshot\]\s*$/gim, '').replace(/\n{3,}/g, '\n\n').trim()
    : cleaned
}

export function extractHermesMedia(text: string): HermesMediaRef[] {
  if (!text) return []
  const refs: HermesMediaRef[] = []
  const seen = new Set<string>()

  const push = (ref: HermesMediaRef, key: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    refs.push(ref)
  }

  // 0. @image:<path> 指令（Hermes 持久化 user/assistant 消息的标准图片引用）
  for (const m of text.matchAll(HERMES_IMAGE_DIRECTIVE_RE)) {
    const raw = m[1]!.trim()
    if (!raw) continue
    if (raw.startsWith('data:image/')) {
      push({ dataUrl: raw, ext: (raw.match(/image\/([a-z0-9.+-]+)/i)?.[1] ?? 'png').replace('jpeg', 'jpg') }, raw)
    } else if (isImagePathLike(raw) || raw.includes('/')) {
      push({ remotePath: raw, ext: raw.split('?')[0]?.split('.').pop()?.toLowerCase() ?? 'png' }, raw)
    }
  }

  // 1. data: URL
  for (const m of text.matchAll(DATA_URL_RE)) {
    push({ dataUrl: m[0], ext: (m[0].match(/image\/([a-z0-9.+-]+)/i)?.[1] ?? 'png').replace('jpeg', 'jpg') }, m[0])
  }

  // 2. MEDIA: token
  for (const m of text.matchAll(MEDIA_TOKEN_RE)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (!raw) continue
    if (raw.startsWith('data:image/')) {
      push({ dataUrl: raw, ext: (raw.match(/image\/([a-z0-9.+-]+)/i)?.[1] ?? 'png').replace('jpeg', 'jpg') }, raw)
    } else if (isImagePathLike(raw)) {
      push({ remotePath: raw, ext: raw.split('?')[0]?.split('.').pop()?.toLowerCase() ?? 'png' }, raw)
    }
  }

  // 3. 绝对路径（排除 data: 与 http: 已处理部分；避免与 URL 重叠）
  for (const m of text.matchAll(IMAGE_PATH_RE)) {
    const raw = m[1]!
    const path = raw.trim()
    if (!path || path.startsWith('data:') || path.startsWith('http')) continue
    push({ remotePath: path, ext: m[3]?.toLowerCase() ?? 'png' }, path)
  }

  // 4. http(s) 图片 URL（含 /api/media?path= 形式的媒体 URL）
  for (const m of text.matchAll(HTTP_IMAGE_URL_RE)) {
    const raw = m[1]!
    // /api/media?path= 或图片 URL → 远端拉取
    push({ remotePath: raw, ext: m[2]?.toLowerCase() ?? 'png' }, raw)
  }

  // 限制数量，避免消息里大量路径导致渲染卡顿
  return refs.slice(0, 8)
}
