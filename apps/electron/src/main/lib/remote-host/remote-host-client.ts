import { createHash } from 'node:crypto'
import type {
  RemoteHostHello,
  RemoteHostTarget as RemoteHostTargetDTO,
  RemoteProjectListResponse,
  CreateRemoteProjectInput,
  CreateRemoteProjectResponse,
  RemoteProjectTreeResponse,
  RemoteTextFileResponse,
  SaveRemoteTextFileInput,
  SaveRemoteTextFileResponse,
  RemoteGitStatusResponse,
  RemoteGitDiffInput,
  RemoteGitDiffResponse,
  RemoteSessionListResponse,
  CreateRemoteSessionInput,
  CreateRemoteSessionResponse,
  RemoteSnapshotResponse,
  RemoteTurnRequest,
  RemoteTurnStatus,
  RemoteInteractionRequest,
  RespondToRemoteInteractionInput,
  RemoteInteractionResponse,
  RemoteHostEvent,
  RemoteHostError,
} from '@proma/shared'
import { REMOTE_HOST_PROTOCOL_VERSION, REMOTE_HOST_PROJECTS_ROOT } from '@proma/shared'
import { remoteHostCredentialStore } from './remote-host-credential-store'

export interface RemoteHostClientOptions {
  baseUrl: string
  bearerToken?: string
  targetId: string
  timeoutMs?: number
}

export class RemoteHostClientError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(error: RemoteHostError) {
    super(error.message)
    this.name = 'RemoteHostClientError'
    this.code = error.code
    this.retryable = error.retryable
    this.details = error.details
  }
}

async function request<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController()
  const timeout = options.timeoutMs ?? 30_000
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.text()
      let error: RemoteHostError
      try {
        error = JSON.parse(body) as RemoteHostError
      } catch {
        error = {
          code: `http_${response.status}`,
          message: body || `HTTP ${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
        }
      }
      throw new RemoteHostClientError(error)
    }
    return (await response.json()) as T
  } catch (err) {
    if (err instanceof RemoteHostClientError) throw err
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new RemoteHostClientError({
        code: 'timeout',
        message: `请求超时 (${timeout}ms)`,
        retryable: true,
      })
    }
    throw new RemoteHostClientError({
      code: 'network_error',
      message: err instanceof Error ? err.message : '网络错误',
      retryable: true,
    })
  } finally {
    clearTimeout(timer)
  }
}

function authHeaders(bearerToken?: string): Record<string, string> {
  if (!bearerToken) return {}
  return { Authorization: `Bearer ${bearerToken}` }
}

export class RemoteHostClient {
  private readonly baseUrl: string
  private readonly targetId: string
  private bearerToken?: string
  private readonly timeoutMs: number

  constructor(options: RemoteHostClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.targetId = options.targetId
    this.bearerToken = options.bearerToken
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  /** Load bearer from credential store */
  loadCredential(): void {
    this.bearerToken = remoteHostCredentialStore.getOwnedCredential(this.targetId, 'bearer-token') ?? undefined
  }

  // ── Health & Hello ──

  async healthz(): Promise<void> {
    await request(`${this.baseUrl}/healthz`, {
      headers: authHeaders(this.bearerToken),
      timeoutMs: this.timeoutMs,
    })
  }

  async hello(): Promise<RemoteHostHello> {
    const hello = await request<RemoteHostHello>(`${this.baseUrl}/v1/hello`, {
      headers: authHeaders(this.bearerToken),
      timeoutMs: this.timeoutMs,
    })
    // Validate protocol compatibility
    if (hello.protocol.min > REMOTE_HOST_PROTOCOL_VERSION || hello.protocol.max < REMOTE_HOST_PROTOCOL_VERSION) {
      throw new RemoteHostClientError({
        code: 'protocol_incompatible',
        message: `不支持的协议版本: host 要求 ${hello.protocol.min}-${hello.protocol.max}, client=${REMOTE_HOST_PROTOCOL_VERSION}`,
        retryable: false,
      })
    }
    if (hello.projectRoot !== REMOTE_HOST_PROJECTS_ROOT) {
      throw new RemoteHostClientError({
        code: 'project_root_mismatch',
        message: `host projectRoot 不匹配: 期望 ${REMOTE_HOST_PROJECTS_ROOT}, 实际 ${hello.projectRoot}`,
        retryable: false,
      })
    }
    return hello
  }

  // ── Projects ──

  async listProjects(): Promise<RemoteProjectListResponse> {
    return request<RemoteProjectListResponse>(`${this.baseUrl}/v1/projects`, {
      headers: authHeaders(this.bearerToken),
      timeoutMs: this.timeoutMs,
    })
  }

  async createProject(input: CreateRemoteProjectInput): Promise<CreateRemoteProjectResponse> {
    return request<CreateRemoteProjectResponse>(`${this.baseUrl}/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(this.bearerToken) },
      body: JSON.stringify(input),
      timeoutMs: this.timeoutMs,
    })
  }

  async getProjectTree(projectId: string, path?: string): Promise<RemoteProjectTreeResponse> {
    const params = path ? `?path=${encodeURIComponent(path)}` : ''
    return request<RemoteProjectTreeResponse>(
      `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/tree${params}`,
      { headers: authHeaders(this.bearerToken), timeoutMs: this.timeoutMs },
    )
  }

  async readFile(projectId: string, path: string): Promise<RemoteTextFileResponse> {
    return request<RemoteTextFileResponse>(
      `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`,
      { headers: authHeaders(this.bearerToken), timeoutMs: this.timeoutMs },
    )
  }

  async saveFile(projectId: string, input: SaveRemoteTextFileInput): Promise<SaveRemoteTextFileResponse> {
    return request<SaveRemoteTextFileResponse>(
      `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/file`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(this.bearerToken) },
        body: JSON.stringify(input),
        timeoutMs: this.timeoutMs,
      },
    )
  }

  async getGitStatus(projectId: string): Promise<RemoteGitStatusResponse> {
    return request<RemoteGitStatusResponse>(
      `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/git/status`,
      { headers: authHeaders(this.bearerToken), timeoutMs: this.timeoutMs },
    )
  }

  async getGitDiff(projectId: string, input?: RemoteGitDiffInput): Promise<RemoteGitDiffResponse> {
    const params = input?.path ? `?path=${encodeURIComponent(input.path)}` : ''
    return request<RemoteGitDiffResponse>(
      `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/git/diff${params}`,
      { headers: authHeaders(this.bearerToken), timeoutMs: this.timeoutMs },
    )
  }

  // ── Sessions ──

  async listSessions(params?: {
    projectId?: string
    runtimeKind?: string
  }): Promise<RemoteSessionListResponse> {
    const qs = new URLSearchParams()
    if (params?.projectId) qs.set('projectId', params.projectId)
    if (params?.runtimeKind) qs.set('runtimeKind', params.runtimeKind)
    const query = qs.toString()
    return request<RemoteSessionListResponse>(
      `${this.baseUrl}/v1/sessions${query ? `?${query}` : ''}`,
      { headers: authHeaders(this.bearerToken), timeoutMs: this.timeoutMs },
    )
  }

  async createSession(input: CreateRemoteSessionInput): Promise<CreateRemoteSessionResponse> {
    return request<CreateRemoteSessionResponse>(`${this.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(this.bearerToken) },
      body: JSON.stringify(input),
      timeoutMs: this.timeoutMs,
    })
  }

  async getSession(sessionId: string): Promise<{ session: import('@proma/shared').RemoteSessionRecord }> {
    return request<{ session: import('@proma/shared').RemoteSessionRecord }>(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
      { headers: authHeaders(this.bearerToken), timeoutMs: this.timeoutMs },
    )
  }

  async getSnapshot(sessionId: string): Promise<RemoteSnapshotResponse> {
    return request<RemoteSnapshotResponse>(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      { headers: authHeaders(this.bearerToken), timeoutMs: this.timeoutMs },
    )
  }

  async getTurnByClientId(
    sessionId: string,
    clientTurnId: string,
  ): Promise<RemoteTurnStatus> {
    return request<RemoteTurnStatus>(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/turns/by-client-id/${encodeURIComponent(clientTurnId)}`,
      { headers: authHeaders(this.bearerToken), timeoutMs: this.timeoutMs },
    )
  }

  // ── Turns ──

  async submitTurn(sessionId: string, input: RemoteTurnRequest): Promise<RemoteTurnStatus> {
    return request<RemoteTurnStatus>(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(this.bearerToken) },
        body: JSON.stringify(input),
        timeoutMs: this.timeoutMs,
      },
    )
  }

  async interruptSession(sessionId: string): Promise<void> {
    await request(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      {
        method: 'POST',
        headers: authHeaders(this.bearerToken),
        timeoutMs: this.timeoutMs,
      },
    )
  }

  // ── Interactions ──

  async respondToInteraction(
    interactionId: string,
    input: RespondToRemoteInteractionInput,
  ): Promise<RemoteInteractionResponse> {
    return request<RemoteInteractionResponse>(
      `${this.baseUrl}/v1/interactions/${encodeURIComponent(interactionId)}/respond`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(this.bearerToken) },
        body: JSON.stringify(input),
        timeoutMs: this.timeoutMs,
      },
    )
  }

  // ── WebSocket events ──

  openEventStream(sessionId: string, cursor?: string): WebSocket {
    const url = new URL(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      'ws://localhost',
    )
    url.protocol = this.baseUrl.startsWith('https') ? 'wss:' : 'ws:'
    if (cursor) url.searchParams.set('cursor', cursor)
    if (this.bearerToken) url.searchParams.set('token', this.bearerToken)
    const ws = new WebSocket(url.toString())
    return ws
  }

  openProjectEventStream(projectId: string, cursor?: string): WebSocket {
    const url = new URL(
      `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/events`,
      'ws://localhost',
    )
    url.protocol = this.baseUrl.startsWith('https') ? 'wss:' : 'ws:'
    if (cursor) url.searchParams.set('cursor', cursor)
    if (this.bearerToken) url.searchParams.set('token', this.bearerToken)
    const ws = new WebSocket(url.toString())
    return ws
  }

  // ── Blobs ──

  async uploadBlob(
    data: Uint8Array,
    metadata: { name: string; mimeType: string },
  ): Promise<import('@proma/shared').RemoteBlobUploadResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-Blob-Name': metadata.name,
      'X-Blob-Mime-Type': metadata.mimeType,
      ...authHeaders(this.bearerToken),
    }
    return request<import('@proma/shared').RemoteBlobUploadResponse>(`${this.baseUrl}/v1/blobs`, {
      method: 'POST',
      headers,
      body: data as unknown as BodyInit,
      timeoutMs: 120_000,
    })
  }
}

/** Create a remote host client connected via SSH-tunneled localhost */
export function createRemoteHostClient(options: {
  targetId: string
  localPort: number
  timeoutMs?: number
}): RemoteHostClient {
  return new RemoteHostClient({
    baseUrl: `http://127.0.0.1:${options.localPort}`,
    targetId: options.targetId,
    timeoutMs: options.timeoutMs,
  })
}
