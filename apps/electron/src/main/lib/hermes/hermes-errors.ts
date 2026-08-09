/**
 * Hermes 类型化错误与诊断
 *
 * 统一 Hermes 连接/协议错误码，供 UI 渲染不同提示与诊断面板。
 * 安全约束：任何错误消息在进入 UI/日志前必须经过脱敏，不得包含凭据。
 */

/** Hermes 错误码分类 */
export type HermesErrorCode =
  | 'ssh'                 // SSH 连接/认证/隧道失败
  | 'tls'                 // TLS 校验失败
  | 'service-not-found'   // 服务不存在（连接被拒 / DNS 失败）
  | 'unauthorized'        // 401 认证失败
  | 'rate-limited'        // 429 尝试过多
  | 'provider-unavailable'// 503 认证 provider 不可用
  | 'protocol-incompatible' // 服务存在但协议不兼容
  | 'timeout'             // 超时
  | 'network'             // 网络错误（断线等）
  | 'invalid-response'    // 响应格式不合法
  | 'unknown'

/** Hermes 错误（主进程内抛出，消息已脱敏） */
export class HermesError extends Error {
  readonly code: HermesErrorCode
  readonly statusCode?: number
  /** 是否需要用户重新登录（401/会话过期） */
  readonly needsAuth: boolean

  constructor(
    message: string,
    code: HermesErrorCode,
    statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(redactSecrets(message), options)
    this.name = 'HermesError'
    this.code = code
    this.statusCode = statusCode
    this.needsAuth = code === 'unauthorized'
  }
}

export class HermesRpcError extends HermesError {
  readonly rpcCode?: number
  readonly requestId: number | string
  readonly method: string

  constructor(message: string, input: { rpcCode?: number; requestId: number | string; method: string }) {
    super(message, 'unknown')
    this.name = 'HermesRpcError'
    this.rpcCode = input.rpcCode
    this.requestId = input.requestId
    this.method = input.method
  }
}

/**
 * 从 HTTP 状态码映射 Hermes 错误码。
 *
 * 404 无法区分「服务不存在」与「接口路径不存在」——由调用方决定使用
 * service-not-found 还是 protocol-incompatible。
 */
export function hermesErrorFromHttpStatus(
  statusCode: number,
  fallbackMessage: string,
): HermesError {
  switch (statusCode) {
    case 401:
      return new HermesError('Hermes 认证失败，请重新登录', 'unauthorized', statusCode)
    case 429:
      return new HermesError('Hermes 登录尝试过多，请稍后再试', 'rate-limited', statusCode)
    case 503:
      return new HermesError('Hermes 认证服务暂不可用', 'provider-unavailable', statusCode)
    case 404:
      return new HermesError(fallbackMessage || 'Hermes 服务不存在', 'service-not-found', statusCode)
    default:
      return new HermesError(
        fallbackMessage || `Hermes 请求失败 (${statusCode})`,
        statusCode >= 500 ? 'provider-unavailable' : 'network',
        statusCode,
      )
  }
}

/**
 * 脱敏：从错误消息中移除常见凭据形态，防止凭据泄漏到 UI/日志。
 *
 * 覆盖形态：
 * - Authorization/Bearer 头
 * - Cookie 头（session token）
 * - API key（sk- 前缀）
 * - URL userinfo（user:pass@）
 * - 长随机 token（≥ 16 字符无空格）
 */
export function redactSecrets(message: string): string {
  return message
    // Authorization / Bearer / Cookie 头值
    .replace(/(authorization|bearer|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]')
    // URL userinfo
    .replace(/\/\/([^/@\s]+)@/g, '//[REDACTED]@')
    // sk- 风格 API key
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    // 形如 token=xxx / key=xxx / password=xxx 的查询参数
    .replace(/([?&](?:token|key|password|ticket|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    // 长随机 token（16+ 位无空格字符）
    .replace(/(?<![A-Za-z0-9])([A-Za-z0-9_-]{16,})(?![A-Za-z0-9])/g, '[REDACTED]')
}

/**
 * 连接诊断数据模型（UI 诊断面板使用）
 */
export interface HermesDiagnostics {
  /** 时间戳 */
  at: number
  /** target 标识 */
  targetId: string
  /** 错误码（无错误时为 null） */
  lastErrorCode: HermesErrorCode | null
  /** 最近错误消息（已脱敏） */
  lastErrorMessage: string | null
  /** 最近成功延迟 ms */
  latencyMs: number | null
  /** 连接尝试次数 */
  attemptCount: number
  /** 最近重连时间戳 */
  lastReconnectAt: number | null
}
