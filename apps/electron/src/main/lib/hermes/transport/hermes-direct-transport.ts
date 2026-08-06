/**
 * Hermes Direct Transport
 *
 * 通过 Direct URL（http/https）访问远端 Hermes：
 * - HTTP JSON 请求（fetch + AbortController 超时）
 * - SSE 流读取（text/event-stream）
 * - WebSocket 连接（Bun / Node 22+ 全局 WebSocket）
 *
 * 安全约束：
 * - `redirect: 'error'` 拒绝跨 origin 重定向（防 SSRF/凭据泄漏）；
 * - TLS 证书错误映射为 `tls` 错误码；
 * - 错误消息统一脱敏后抛出 HermesError。
 */

import { HermesError } from '../hermes-errors'
import type { HermesErrorCode } from '../hermes-errors'
import type {
  HermesJsonResponse,
  HermesRequestOptions,
  HermesSseEvent,
  HermesSseHandle,
  HermesSseOptions,
  HermesTransport,
  HermesWsOpenResult,
} from './hermes-transport'

/** fetch 函数类型（mock 友好，避免依赖 typeof fetch 的静态属性） */
export type HermesFetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** Direct Transport 构造选项（测试可注入 fetch 实现） */
export interface HermesDirectTransportOptions {
  /** 自定义 fetch 实现（默认全局 fetch） */
  fetchImpl?: HermesFetchFn
  /** 自定义 WebSocket 构造器（默认全局 WebSocket） */
  WebSocketImpl?: typeof WebSocket
}

/** 默认超时 */
const DEFAULT_TIMEOUT_MS = 8_000

/** TLS 错误特征码 */
const TLS_ERROR_MARKERS: ReadonlyArray<string> = [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE',
]

/**
 * 归一化 baseUrl：保证以 / 结尾，供路径拼接使用。
 */
export function normalizeBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '') + '/'
  return url.toString()
}

/**
 * 拼接路径与 baseUrl，query 参数直接附加。
 *
 * path 以 / 开头时替换根路径；否则拼在 baseUrl 之后。
 */
export function joinPath(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl)
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path
  }
  if (path.startsWith('/')) {
    const parsed = new URL(base)
    const queryIndex = path.indexOf('?')
    if (queryIndex >= 0) {
      parsed.pathname = path.slice(0, queryIndex)
      parsed.search = path.slice(queryIndex + 1)
    } else {
      parsed.pathname = path
    }
    return parsed.toString()
  }
  return base + path
}

/**
 * 将 fetch 异常映射为 HermesError。
 */
export function mapFetchError(
  error: unknown,
  timeoutMs: number,
): HermesError {
  if (error instanceof HermesError) {
    return error
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new HermesError(`连接超时（超过 ${timeoutMs}ms）`, 'timeout')
  }
  const cause = error instanceof Error ? error : new Error(String(error))
  const raw = `${cause.name}: ${cause.message}`
  const causeMessage = cause.cause instanceof Error ? cause.cause.message : ''
  const causeCode = cause.cause instanceof Error && 'code' in cause.cause
    ? String((cause.cause as Error & { code?: unknown }).code)
    : ''
  const tlsMarker = TLS_ERROR_MARKERS.find(
    (marker) =>
      raw.includes(marker) || causeMessage.includes(marker) || causeCode.includes(marker),
  )
  if (tlsMarker) {
    return new HermesError(`TLS 证书校验失败（${tlsMarker}）`, 'tls')
  }
  return new HermesError(`无法连接远端 Hermes: ${cause.message}`, 'network')
}

/**
 * 解析 SSE 文本流（纯函数，便于测试）。
 *
 * SSE 规范：事件以空行分隔；`data:` 可多行拼接（以 \n 连接）；`event:` 为类型；
 * `id:` 为事件 ID；以 `:` 开头的行为注释（忽略）。
 */
export function parseSseBuffer(
  buffer: string,
  onEvent: (event: HermesSseEvent) => void,
): void {
  let dataLines: string[] = []
  let eventType = 'message'
  let eventId: string | undefined

  const flush = (): void => {
    if (dataLines.length === 0) {
      return
    }
    onEvent({
      id: eventId,
      event: eventType === 'message' ? undefined : eventType,
      data: dataLines.join('\n'),
    })
    dataLines = []
    eventType = 'message'
    eventId = undefined
  }

  for (const line of buffer.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith(':')) {
      continue // 注释行
    }
    const colonIndex = line.indexOf(':')
    const field = colonIndex < 0 ? line : line.slice(0, colonIndex)
    // data 值前的单个空格会被去掉
    let value = ''
    if (colonIndex >= 0) {
      value = line.slice(colonIndex + 1)
      if (value.startsWith(' ')) {
        value = value.slice(1)
      }
    }
    switch (field) {
      case 'data':
        dataLines.push(value)
        break
      case 'event':
        eventType = value
        break
      case 'id':
        eventId = value
        break
      default:
        break // 忽略未知字段
    }
  }
  // 流结束时 flush 最后一段（无尾随空行的情况）
  flush()
}

/**
 * Direct Transport 实现。
 */
export class HermesDirectTransport implements HermesTransport {
  readonly baseUrl: string
  private readonly fetchImpl: HermesFetchFn
  private readonly WebSocketImpl: typeof WebSocket

  constructor(baseUrl: string, options: HermesDirectTransportOptions = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket
  }

  async requestJson(
    path: string,
    options: HermesRequestOptions = {},
  ): Promise<HermesJsonResponse> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const url = joinPath(this.baseUrl, path)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal: options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal,
      })
      const text = await response.text()
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          // 非 JSON 响应视为协议不兼容（HTML 或纯文本）
          throw new HermesError(
            `远端返回非 JSON 响应（HTTP ${response.status}）`,
            'protocol-incompatible',
            response.status,
          )
        }
      }
      return { status: response.status, body }
    } catch (error) {
      throw mapFetchError(error, timeoutMs)
    } finally {
      clearTimeout(timer)
    }
  }

  async openSse(path: string, options: HermesSseOptions): Promise<HermesSseHandle> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const url = joinPath(this.baseUrl, path)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const externalAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', externalAbort, { once: true })

    // 先等待 HTTP 响应与状态检查，失败时在此抛出（openSse 直接 reject）
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...(options.headers ?? {}) },
        redirect: 'error',
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', externalAbort)
      throw mapFetchError(error, timeoutMs)
    }
    if (!response.ok) {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', externalAbort)
      throw new HermesError(
        `SSE 请求失败（HTTP ${response.status}）`,
        response.status === 401 ? 'unauthorized' : 'network',
        response.status,
      )
    }
    if (!response.body) {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', externalAbort)
      throw new HermesError('远端未返回响应体', 'invalid-response')
    }

    // 响应就绪：启动异步读取循环，不阻塞调用方
    let settled = false
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', externalAbort)
      resolveDone()
    }

    const run = (async (): Promise<void> => {
      try {
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done: readerDone, value } = await reader.read()
          if (readerDone) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          parseSseBuffer(lines.join('\n'), options.onEvent)
        }
        if (buffer) {
          parseSseBuffer(buffer, options.onEvent)
        }
        options.onEnd?.()
      } catch (error) {
        // 流中途断线/中止：不抛给调用方，通过 done 结束；上层可感知连接终止
        console.warn('[Hermes Direct] SSE 流中断:', error instanceof Error ? error.message : String(error))
      } finally {
        finish()
      }
    })()

    return {
      abort: () => controller.abort(),
      done: done.then(() => run.catch(() => undefined)),
    }
  }

  async connectWebSocket(
    path: string,
    options: HermesRequestOptions = {},
  ): Promise<HermesWsOpenResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let url = joinPath(this.baseUrl, path)
    if (url.startsWith('https://')) {
      url = url.replace('https://', 'wss://')
    } else if (url.startsWith('http://')) {
      url = url.replace('http://', 'ws://')
    }

    return new Promise<HermesWsOpenResult>((resolve) => {
      let settled = false
      const finish = (
        result: HermesWsOpenResult,
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = (): void => {
        socket.close()
        finish({
          socket: null,
          errorCode: 'timeout' as HermesErrorCode,
          errorMessage: 'WebSocket 连接已取消',
        })
      }

      let socket: WebSocket
      try {
        socket = new this.WebSocketImpl(url)
      } catch (error) {
        finish({
          socket: null,
          errorCode: 'network',
          errorMessage: `WebSocket 构造失败: ${error instanceof Error ? error.message : String(error)}`,
        })
        return
      }

      const timer = setTimeout(() => {
        socket.close()
        finish({
          socket: null,
          errorCode: 'timeout',
          errorMessage: `WebSocket 连接超时（超过 ${timeoutMs}ms）`,
        })
      }, timeoutMs)

      options.signal?.addEventListener('abort', onAbort, { once: true })

      socket.addEventListener('open', () => {
        // 打开成功：移除超时监听与信号监听，交给调用方管理 socket
        finish({ socket, errorCode: null, errorMessage: null })
      })
      socket.addEventListener('error', () => {
        finish({
          socket: null,
          errorCode: 'network',
          errorMessage: 'WebSocket 连接失败',
        })
      })
    })
  }

  dispose(): void {
    // Direct Transport 无长期持有的连接；由调用方管理各请求/流生命周期
  }
}
