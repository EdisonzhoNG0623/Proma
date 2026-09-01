/**
 * Hermes 消息里的图片渲染（Hermes → Proma 收图）。
 *
 * - data: URL → 直接显示
 * - 远端路径/URL → 经主进程 /api/media 拉取（复用 dashboard 认证）→ data URL 显示
 */
import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, ImageOff } from 'lucide-react'
import { extractHermesMedia, type HermesMediaRef } from '@/lib/hermes-media-extract'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { ImageLightbox } from '@/components/ui/image-lightbox'

function HermesMediaImage({ mediaRef, targetId }: { mediaRef: HermesMediaRef; targetId?: string }): React.ReactElement | null {
  const [dataUrl, setDataUrl] = React.useState<string | undefined>(mediaRef.dataUrl)
  const [failed, setFailed] = React.useState(false)
  const [lightboxOpen, setLightboxOpen] = React.useState(false)

  React.useEffect(() => {
    if (mediaRef.dataUrl) {
      setDataUrl(mediaRef.dataUrl)
      return
    }
    if (!mediaRef.remotePath || !targetId) {
      setFailed(true)
      return
    }
    let cancelled = false
    setDataUrl(undefined)
    setFailed(false)
    window.electronAPI.hermes
      .fetchMedia(targetId, mediaRef.remotePath)
      .then((result) => {
        if (cancelled) return
        if (result?.dataUrl) {
          setDataUrl(result.dataUrl)
        } else {
          setFailed(true)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [mediaRef.dataUrl, mediaRef.remotePath, targetId])

  if (failed) {
    return (
      <div className="flex h-24 w-24 items-center justify-center rounded-md border border-dashed border-border bg-muted/30 text-muted-foreground">
        <ImageOff size={16} />
      </div>
    )
  }
  if (!dataUrl) {
    return (
      <div className="flex h-24 w-24 items-center justify-center rounded-md border border-border bg-muted/30">
        <Loader2 size={16} className="animate-spin text-muted-foreground" />
      </div>
    )
  }
  const filename = mediaRef.remotePath?.replace(/\\/g, '/').split('/').pop() || `Hermes-image.${mediaRef.ext ?? 'png'}`
  return (
    <>
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        className="block max-w-full cursor-zoom-in overflow-hidden rounded-md border border-border transition-colors hover:border-primary/50"
        title="点击查看大图"
      >
        <img src={dataUrl} alt={filename} className="max-h-64 max-w-full object-contain" loading="lazy" />
      </button>
      <ImageLightbox
        src={dataUrl}
        alt={filename}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </>
  )
}

/**
 * 扫描 Hermes 消息文本，渲染其中嵌入的图片。
 * 需在 Hermes 会话（isHermesRemoteSession）的消息渲染处挂载。
 */
export function HermesMediaBlock({ text, sessionId }: { text: string; sessionId?: string }): React.ReactElement | null {
  const sessions = useAtomValue(agentSessionsAtom)
  const effectiveSessionId = sessionId
  const targetId = React.useMemo(() => {
    return sessions.find((s) => s.id === effectiveSessionId)?.hermesTargetId
  }, [sessions, effectiveSessionId])

  const refs = React.useMemo(() => extractHermesMedia(text), [text])
  if (refs.length === 0 || !targetId) {
    // 无 target（非 Hermes 会话）时不渲染；data: URL 也可在非 Hermes 下显示（保守起见仅 target 存在时）
    if (refs.length === 0) return null
  }
  if (refs.length === 0) return null

  return (
    <div className="my-1.5 flex flex-wrap gap-2">
      {refs.map((mediaRef, i) => (
        <HermesMediaImage
          key={`${i}-${mediaRef.remotePath ?? mediaRef.dataUrl?.slice(0, 40) ?? ''}`}
          mediaRef={mediaRef}
          targetId={targetId}
        />
      ))}
    </div>
  )
}
