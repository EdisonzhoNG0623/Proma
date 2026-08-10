/**
 * Proma Remote Host 客户端类型定义
 *
 * Proma Desktop 通过 SSH Tunnel 连接 Debian Remote Host，管理远端项目
 * 并运行/恢复 Pi、Claude Code 与 Codex Agent 会话。
 * Remote Host 是独立 external runtime（'remote-host'），不伪装成 Local Pi。
 */

// ── 基础原语 ──

export type RemoteRuntimeKind = 'pi' | 'claude-code' | 'codex'
export type RemoteAdapterMode = 'pi-sdk' | 'claude-agent-sdk' | 'codex-app-server'
export type RemoteHostDeploymentMode = 'production' | 'unsafe-dev-same-uid'

/** Renderer-safe public target (no credential refs) */
export interface RemoteHostPublicTarget {
  id: string
  name: string
  ssh: { host: string; port: number; username: string; remoteHostPort: number }
  hasBearerCredential: boolean
  lastHello?: RemoteHostHello
  createdAt: number
  updatedAt: number
}

// ── Target 与传输层 ──

export interface RemoteHostSshConfig {
  host: string
  port: number
  username: string
  remoteHostPort: number
}

export interface RemoteHostTargetCreateInput {
  name: string
  ssh: RemoteHostSshConfig
}

export interface RemoteHostTargetUpdateInput {
  name?: string
  ssh?: RemoteHostSshConfig
  lastHello?: RemoteHostHello | null
}

export interface RemoteHostTarget {
  id: string
  name: string
  transport: 'ssh'
  ssh: RemoteHostSshConfig
  hasBearerCredential: boolean
  lastHello?: RemoteHostHello
  createdAt: number
  updatedAt: number
}

// ── Hello 与能力探测 ──

export interface RemoteRuntimeFeatureSet {
  history: boolean
  streaming: boolean
  approvals: boolean
  questions: boolean
  interrupt: boolean
  imageInput: boolean
  fileInput: boolean
}

export interface RemoteRuntimeCapability {
  runtimeKind: RemoteRuntimeKind
  adapterMode: RemoteAdapterMode
  version: string
  digest: string
  available: boolean
  unavailableReason?: string
  features: RemoteRuntimeFeatureSet
}

export interface RemoteHostHello {
  protocol: { min: 1; max: 1 }
  hostVersion: string
  protocolSchemaSha256: string
  minReaderVersion: string
  instanceId: string
  bootId: string
  platform: { os: 'linux'; arch: 'x64' | 'arm64'; node: string; libc?: string }
  deployment: { mode: RemoteHostDeploymentMode; productionReady: boolean }
  projectRoot: '/opt/ai/projects'
  runtimes: RemoteRuntimeCapability[]
  limits: {
    maxAttachmentBytes: number
    maxTurnAttachmentBytes: number
    maxTextFileBytes: number
    replayEvents: number
  }
}

// ── 项目 ──

export interface RemoteProject {
  id: string
  name: string
}

export interface RemoteProjectListResponse {
  projects: RemoteProject[]
}

export interface CreateRemoteProjectInput {
  name: string
}

export interface CreateRemoteProjectResponse {
  project: RemoteProject
}

export interface RemoteProjectTreeEntry {
  path: string
  kind: 'file' | 'directory'
}

export interface RemoteProjectTreeResponse {
  entries: RemoteProjectTreeEntry[]
}

// ── 文件 ──

export interface RemoteTextFile {
  path: string
  text: string
  sha256: string
  size: number
}

export interface RemoteTextFileResponse {
  file: RemoteTextFile
}

export interface SaveRemoteTextFileInput {
  path: string
  text: string
  ifMatchSha256: string
}

export interface SavedRemoteTextFile {
  path: string
  sha256: string
  size: number
}

export interface SaveRemoteTextFileResponse {
  file: SavedRemoteTextFile
}

// ── Git ──

export interface RemoteGitStatusResponse {
  porcelainV2: string
}

export interface RemoteGitDiffInput {
  path?: string
}

export interface RemoteGitDiffResponse {
  patch: string
}

// ── 会话 ──

export interface RemoteSessionBinding {
  targetId: string
  runtimeKind: RemoteRuntimeKind
  adapterMode: RemoteAdapterMode
  projectId: string
  hostSessionId: string
}

export interface RemoteSessionRecord {
  hostSessionId: string
  projectId: string
  runtimeKind: RemoteRuntimeKind
  adapterMode: RemoteAdapterMode
  state: 'idle' | 'active' | 'unknown'
  createdAt: string
  updatedAt: string
}

export interface RemoteSessionListResponse {
  sessions: RemoteSessionRecord[]
}

export interface CreateRemoteSessionInput {
  projectId: string
  runtimeKind: RemoteRuntimeKind
  adapterMode: RemoteAdapterMode
}

export interface CreateRemoteSessionResponse {
  session: RemoteSessionRecord
}

// ── Turn ──

export interface RemoteTurnAttachment {
  blobId: string
  kind: 'image' | 'file'
  name: string
  mimeType: string
  size: number
  sha256: string
}

export interface RemoteTurnRequest {
  clientTurnId: string
  requestDigest: string
  text: string
  attachments: RemoteTurnAttachment[]
}

export type RemoteTurnState =
  | 'prepared'
  | 'accepted'
  | 'dispatching'
  | 'started'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown'

export interface RemoteTurnStatus {
  clientTurnId: string
  turnId: string
  state: RemoteTurnState
  requestDigest: string
  updatedAt: string
  error?: RemoteHostError
}

// ── Blob ──

export interface RemoteUploadedBlob {
  blobId: string
  name: string
  mimeType: string
  size: number
  sha256: string
  expiresAt: string
}

export interface RemoteBlobUploadResponse {
  blob: RemoteUploadedBlob
}

// ── Interaction ──

export interface RemoteInteractionOption {
  id: string
  label: string
  description?: string
}

export interface RemoteInteractionRequest {
  interactionId: string
  sessionId: string
  turnId: string
  workerGeneration: number
  kind: 'approval' | 'question' | 'permission'
  prompt: string
  options: RemoteInteractionOption[]
  requestedAt: string
}

export type RemoteInteractionStatus = 'allowed' | 'denied' | 'answered' | 'stale' | 'timed_out'

export interface RemoteInteractionResponse {
  interactionId: string
  workerGeneration: number
  status: RemoteInteractionStatus
  optionId?: string
  answer?: string
  respondedAt: string
}

export interface RespondToRemoteInteractionInput {
  workerGeneration: number
  status: 'allowed' | 'denied' | 'answered'
  optionId?: string
  answer?: string
}

// ── Snapshot ──

export type RemoteSnapshotItem =
  | { kind: 'user'; id: string; turnId: string; text: string }
  | { kind: 'assistant'; id: string; turnId: string; text: string }
  | { kind: 'thinking'; id: string; turnId: string; text: string }
  | {
      kind: 'tool'
      id: string
      turnId: string
      name: string
      state: 'started' | 'running' | 'completed' | 'failed'
      input?: unknown
      output?: unknown
      isError?: boolean
    }
  | { kind: 'interaction'; id: string; turnId: string; interaction: RemoteInteractionRequest }
  | { kind: 'diagnostic'; id: string; severity: 'info' | 'warning' | 'error'; code: string; message: string }

export interface RemoteSessionSnapshot {
  schemaVersion: 1
  minReaderVersion: string
  sessionId: string
  runtimeKind: RemoteRuntimeKind
  projectId: string
  items: RemoteSnapshotItem[]
  pendingInteractions: RemoteInteractionRequest[]
  turns: RemoteTurnStatus[]
  updatedAt: string
}

export interface RemoteSnapshotResponse {
  snapshot: RemoteSessionSnapshot
  tailCursor: string
}

// ── 事件 ──

export interface SessionEventBase {
  protocolVersion: 1
  scope: 'session'
  sessionId: string
  turnId?: string
  cursor: string
  eventId: string
  occurredAt: string
}

export type TurnLifecycleEvent = SessionEventBase & {
  type: 'turn.accepted' | 'turn.started' | 'turn.completed' | 'turn.interrupted'
  payload: RemoteTurnStatus
}

export type TurnFailedEvent = SessionEventBase & {
  type: 'turn.failed'
  payload: RemoteHostError
}

export type TextDeltaEvent = SessionEventBase & {
  type: 'assistant.delta' | 'thinking.delta'
  payload: { itemId: string; delta: string }
}

export type TextCompletedEvent = SessionEventBase & {
  type: 'assistant.completed' | 'thinking.completed'
  payload: { itemId: string; text: string }
}

export type ToolLifecycleEvent = SessionEventBase & {
  type: 'tool.started' | 'tool.progress' | 'tool.completed'
  payload: {
    itemId: string
    name: string
    state: 'started' | 'running' | 'completed' | 'failed'
    input?: unknown
    output?: unknown
    isError?: boolean
  }
}

export type InteractionRequestedEvent = SessionEventBase & {
  type: 'interaction.requested'
  payload: RemoteInteractionRequest
}

export type InteractionResolvedEvent = SessionEventBase & {
  type: 'interaction.resolved'
  payload: RemoteInteractionResponse
}

export type PlanUpdatedEvent = SessionEventBase & {
  type: 'plan.updated'
  payload: { items: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] }
}

export type UsageUpdatedEvent = SessionEventBase & {
  type: 'usage.updated'
  payload: { inputTokens: number; outputTokens: number; costUsd?: number }
}

export type DiagnosticEvent = SessionEventBase & {
  type: 'diagnostic'
  payload: { severity: 'info' | 'warning' | 'error'; code: string; message: string }
}

export interface ProjectChangedEvent {
  protocolVersion: 1
  scope: 'project'
  projectId: string
  cursor: string
  eventId: string
  occurredAt: string
  type: 'project.changed'
  payload: { paths: string[]; overflow: boolean }
}

export type RemoteHostEvent =
  | TurnLifecycleEvent
  | TurnFailedEvent
  | TextDeltaEvent
  | TextCompletedEvent
  | ToolLifecycleEvent
  | InteractionRequestedEvent
  | InteractionResolvedEvent
  | PlanUpdatedEvent
  | UsageUpdatedEvent
  | DiagnosticEvent
  | ProjectChangedEvent

// ── 错误 ──

export interface RemoteHostError {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

// ── 常量 ──

export const REMOTE_HOST_IPC_CHANNELS = {
  LIST_TARGETS: 'remote-host:list-targets',
  GET_TARGET: 'remote-host:get-target',
  CREATE_TARGET: 'remote-host:create-target',
  UPDATE_TARGET: 'remote-host:update-target',
  DELETE_TARGET: 'remote-host:delete-target',
  SET_BEARER_TOKEN: 'remote-host:set-bearer-token',
  HAS_BEARER_TOKEN: 'remote-host:has-bearer-token',
  CLEAR_BEARER_TOKEN: 'remote-host:clear-bearer-token',
  SET_SSH_PASSWORD: 'remote-host:set-ssh-password',
  SET_SSH_PRIVATE_KEY: 'remote-host:set-ssh-private-key',
  HAS_SSH_CREDENTIAL: 'remote-host:has-ssh-credential',
  PROBE_TARGET: 'remote-host:probe-target',
  CONFIRM_HOST_KEY: 'remote-host:confirm-host-key',
  CONNECT_TARGET: 'remote-host:connect-target',
  DISCONNECT_TARGET: 'remote-host:disconnect-target',
  LIST_PROJECTS: 'remote-host:list-projects',
  CREATE_PROJECT: 'remote-host:create-project',
  GET_PROJECT_TREE: 'remote-host:get-project-tree',
  READ_FILE: 'remote-host:read-file',
  SAVE_FILE: 'remote-host:save-file',
  GET_GIT_STATUS: 'remote-host:get-git-status',
  GET_GIT_DIFF: 'remote-host:get-git-diff',
  LIST_SESSIONS: 'remote-host:list-sessions',
  CREATE_SESSION: 'remote-host:create-session',
  GET_SESSION_SNAPSHOT: 'remote-host:get-session-snapshot',
  SUBMIT_TURN: 'remote-host:submit-turn',
  INTERRUPT_SESSION: 'remote-host:interrupt-session',
  RESPOND_TO_INTERACTION: 'remote-host:respond-to-interaction',
} as const
