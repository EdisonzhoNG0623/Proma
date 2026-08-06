/**
 * Hermes Transport 接口
 *
 * Transport 是传输层抽象：Direct URL 与 SSH Tunnel 都实现同一接口，
 * 上层 Adapter 不感知底层是直连还是隧道。
 */

import type { HermesErrorCode } from '../hermes-errors'

/** HTTP JSON 请求选项 */
export interface HermesRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** 请求头（认证头 / Cookie 由调用方注入） */
  headers?: Record<string, string>
  /** JSON 请求体（自动序列化） */
  body?: unknown
  /** 超时毫秒，默认 8000 */
  timeoutMs?: number
  /** 外部中止信号 */
  signal?: AbortSignal
}

/** JSON 响应（body 为解析后的 JSON） */
export interface HermesJsonResponse {
  status: number
  body: unknown
}

/** SSE 事件（解析后的单个事件） */
export interface HermesSseEvent {
  id?: string
  event?: string
  data: string
}

/** SSE 流选项 */
export interface HermesSseOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  /** 每个事件回调 */
  onEvent: (event: HermesSseEvent) => void
  /** 流结束回调（可选） */
  onEnd?: () => void
}

/** SSE 流句柄 */
export interface HermesSseHandle {
  /** 主动中止流 */
  abort(): void
  /** 流结束（正常或 abort）后的 Promise */
  done: Promise<void>
}

/** WebSocket 打开等待结果 */
export interface HermesWsOpenResult {
  /** 已打开的 WebSocket；失败时为 null */
  socket: WebSocket | null
  /** 错误码（失败时） */
  errorCode: HermesErrorCode | null
  /** 错误消息（已脱敏） */
  errorMessage: string | null
}

/**
 * Transport 接口
 *
 * 实现约定：
 * - 所有错误抛出 HermesError（见 hermes-errors.ts），消息已脱敏；
 * - baseUrl 为归一化后的根地址（如 https://hermes.example.com/ 或 http://127.0.0.1:PORT/）。
 */
export interface HermesTransport {
  readonly baseUrl: string
  /** 发送 HTTP JSON 请求，返回状态码与解析后的 JSON body */
  requestJson(path: string, options?: HermesRequestOptions): Promise<HermesJsonResponse>
  /** 打开 SSE 流（GET），逐事件回调 */
  openSse(path: string, options: HermesSseOptions): Promise<HermesSseHandle>
  /**
   * 建立 WebSocket 连接（认证走 query 参数：?token= / ?ticket=）。
   *
   * @returns 打开成功时 socket 非空；失败时返回错误码与消息
   */
  connectWebSocket(path: string, options?: HermesRequestOptions): Promise<HermesWsOpenResult>
  /** 释放传输层资源（Direct 无状态；SSH Tunnel 关闭隧道） */
  dispose(): void
}
