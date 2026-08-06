/**
 * Hermes Dashboard WebSocket JSON-RPC 客户端
 *
 * 实现 Hermes Dashboard `/api/ws` 的 JSON-RPC 2.0 客户端：
 * - 带 id 的请求/响应（pending map，超时控制）
 * - 无 id 的 notification（事件流）分发
 * - 断线处理：监听 close 并通知上层
 *
 * 消息形态：
 *   request:  { jsonrpc: '2.0', id, method, params }
 *   response: { jsonrpc: '2.0', id, result } | { jsonrpc: '2.0', id, error: { code, message } }
 *   notify:   { jsonrpc: '2.0', method, params }
 */

import { HermesError, redactSecrets } from './hermes-errors'

/** WS 消息形态 */
export interface HermesWsMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

/** 请求超时选项 */
export interface HermesWsRequestOptions {
  /** 超时毫秒（默认 30s；prompt.submit 类长请求可放宽） */
  timeoutMs?: number
}

/** 通知处理器签名 */
export type HermesWsNotificationHandler = (method: string, params: unknown) => void

/** 连接打开结果（复用 transport 的 WS 打开约定） */
export interface HermesWsConnectResult {
  socket: WebSocket | null
  errorCode: string | null
  errorMessage: string | null
}

/** socket 连接器：由 transport 提供 */
export type HermesWsConnector = (url: string) => Promise<HermesWsConnectResult>

/** JSON-RPC 请求响应类型 */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 默认请求超时 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Dashboard WS 客户端
 */
export class HermesDashboardWsClient {
  private socket: WebSocket | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationHandlers = new Set<HermesWsNotificationHandler>()
  private nextId = 1
  private closed = false

  constructor(
    private readonly connector: HermesWsConnector,
    private readonly onClose?: (reason: string) => void,
  ) {}

  get isConnected(): boolean {
    return this.socket !== null && !this.closed
  }

  /**
   * 建立连接。
   *
   * @throws HermesError：连接失败（network/timeout）
   */
  async connect(url: string, timeoutMs = 10_000): Promise<void> {
    if (this.isConnected) {
      return
    }
    this.closed = false
    const result = await this.connector(url)
    if (!result.socket || result.errorCode) {
      throw new HermesError(
        result.errorMessage ?? 'WebSocket 连接失败',
        (result.errorCode as 'network' | 'timeout') ?? 'network',
      )
    }
    this.socket = result.socket
    this.socket.addEventListener('message', (event) => {
      this.handleMessage(event)
    })
    this.socket.addEventListener('close', () => {
      const reason = 'connection closed'
      this.socket = null
      this.rejectAllPending(new HermesError('Hermes WebSocket 连接已断开', 'network'))
      this.onClose?.(reason)
    })
  }

  /** 发送 JSON-RPC 请求并等待响应 */
  request<T = unknown>(method: string, params: unknown, options: HermesWsRequestOptions = {}): Promise<T> {
    if (!this.socket) {
      return Promise.reject(new HermesError('Hermes WebSocket 未连接', 'network'))
    }
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HermesError(`Hermes 请求超时（${method}）`, 'timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      const message: HermesWsMessage = { jsonrpc: '2.0', id, method, params }
      this.socket?.send(JSON.stringify(message))
    })
  }

  /** 注册 notification 处理器；返回取消函数 */
  onNotification(handler: HermesWsNotificationHandler): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  /** 关闭连接 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket?.close()
    this.socket = null
    this.rejectAllPending(new HermesError('Hermes WebSocket 已关闭', 'network'))
  }

  private handleMessage(event: MessageEvent): void {
    let message: HermesWsMessage
    try {
      message = JSON.parse(String(event.data)) as HermesWsMessage
    } catch {
      // 非 JSON 消息（心跳等）忽略
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(Number(message.id))
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(Number(message.id))
      if (message.error) {
        const text = message.error.message ?? '未知错误'
        pending.reject(new HermesError(redactSecrets(text), 'network'))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method) {
      for (const handler of this.notificationHandlers) {
        try {
          handler(message.method, message.params)
        } catch (error) {
          console.warn('[Hermes Dashboard] 通知处理器异常:', error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  private rejectAllPending(error: HermesError): void {
    for (const [, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
