export type AppSection = 'explorer' | 'search' | 'settings'

export type FileNode = {
  name: string
  path: string
  kind: 'file' | 'directory'
  children?: FileNode[]
}

export type SearchResult = {
  path: string
  line: number
  preview: string
  matches?: string[]
}

export type ModelProvider = 'ollama' | 'openai'

export type ModelPreset = 'kimi-code'

export type ThinkingMode = 'auto' | 'on' | 'off'

export type ModelConfig = {
  provider: ModelProvider
  baseUrl: string
  model: string
  apiKey?: string
  preset?: ModelPreset
  connectionId?: string
  contextLength?: number
  maxContextLength?: number
  thinkingMode?: ThinkingMode
}

export type SkillDefinition = {
  id: string
  name: string
  description: string
  instructions: string
  enabled: boolean
  sourcePath?: string
}

export type ModelOption = {
  id: string
  name: string
  provider: ModelProvider
  baseUrl: string
  source: 'Ollama' | 'LM Studio' | 'llama.cpp' | 'Kimi Code' | '自定义'
  preset?: ModelPreset
  connectionId?: string
  contextLength?: number
  maxContextLength?: number
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type AgentPermissionMode = 'read-only' | 'read-write-manual' | 'read-write-auto'

export type AgentStep = {
  id: string
  title: string
  detail?: string
  toolName?: string
  status: 'running' | 'waiting' | 'done' | 'error'
  startedAt: number
  completedAt?: number
}

export type AgentTask = {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentExecutionBlock =
  | {
      id: string
      type: 'operation'
      title: string
      detail?: string
      toolName?: string
      status: 'running' | 'waiting' | 'done' | 'error'
      startedAt: number
      completedAt?: number
    }
  | {
      id: string
      type: 'thinking'
      content: string
      status?: 'running' | 'done'
      createdAt: number
      updatedAt: number
    }
  | {
      id: string
      type: 'response'
      content: string
      createdAt: number
    }
  | {
      id: string
      type: 'tasks'
      title: string
      items: AgentTask[]
      createdAt: number
      updatedAt: number
    }
  | {
      id: string
      type: 'guidance'
      content: string
      createdAt: number
    }
  | {
      id: string
      type: 'image'
      images: ChatAttachment[]
      title?: string
      createdAt: number
    }

export type TokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens?: number
  estimated?: boolean
  generationDurationMs?: number
  tokensPerSecond?: number
}

export type ContextWindowState = {
  usedTokens: number
  limitTokens: number
  estimated?: boolean
  compressed: boolean
  updatedAt: number
}

export type ContextCompressionMemory = {
  summary: string
  compressedMessageCount: number
  compressedNonSystemIndexes?: number[]
}

export type TokenUsageRecord = TokenUsage & {
  id: string
  timestamp: number
  model: string
  provider: ModelProvider
  kind: 'chat' | 'agent' | 'image'
}

export type ConversationMode = 'chat' | 'agent' | 'image'

export type ComfyWorkflowNode = {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export type ComfyWorkflow = {
  id: string
  name: string
  sourcePath: string
  workflow: Record<string, ComfyWorkflowNode>
  promptNodeId: string
  promptInputName: string
  stepsNodeId: string
  stepsInputName: string
  widthNodeId?: string
  widthInputName?: string
  heightNodeId?: string
  heightInputName?: string
  sizeMode?: 'dimensions' | 'aspect_ratio' | 'workflow'
  aspectRatioNodeId?: string
  aspectRatioInputName?: string
  aspectRatioNodeClass?: string
  megapixelsNodeId?: string
  megapixelsInputName?: string
  multipleNodeId?: string
  multipleInputName?: string
  aspectRatioOptions?: string[]
  modelNodeId: string
  modelInputName: string
  modelNodeClass: string
  defaultSteps: number
  defaultWidth?: number
  defaultHeight?: number
  defaultAspectRatio?: string
  defaultMegapixels?: number
  defaultMultiple?: number
  defaultModel: string
  selectedSteps?: number
  selectedWidth?: number
  selectedHeight?: number
  selectedAspectRatio?: string
  selectedMegapixels?: number
  selectedMultiple?: number
  selectedModel?: string
}

export type ComfyWorkflowInspection = {
  connected: boolean
  message: string
  models: string[]
  aspectRatios?: string[]
}

export type ImageGenerationRequest = {
  requestId: string
  model: ModelConfig
  baseUrl: string
  workflow: ComfyWorkflow
  prompt: string
  contextMessages: ChatContextMessage[]
  historyArchive?: ChatContextMessage[]
  steps: number
  width: number
  height: number
  aspectRatio?: string
  megapixels?: number
  multiple?: number
  checkpoint: string
}

export type ImageGenerationEvent = {
  requestId: string
  type: 'status' | 'reasoning' | 'chunk' | 'prompt' | 'progress' | 'done' | 'error'
  content?: string
  enhancedPrompt?: string
  progress?: number
  images?: ChatAttachment[]
  usage?: TokenUsage
}

export type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  status?: 'streaming' | 'done' | 'error'
  meta?: string
  startedAt?: number
  completedAt?: number
  agentSteps?: AgentStep[]
  agentBlocks?: AgentExecutionBlock[]
  checkpointId?: string
  usage?: TokenUsage
  contextState?: ContextWindowState
  stoppedByUser?: boolean
  attachments?: Array<{
    name: string
    kind: 'image' | 'text' | 'file'
    mimeType: string
    size: number
    thumbnail?: string
    data?: string
    text?: string
  }>
}

export type ChatAttachment = {
  name: string
  kind: 'image' | 'text' | 'file'
  mimeType: string
  size: number
  data?: string
  text?: string
  thumbnail?: string
}

export type ChatContextMessage = Pick<ChatMessage, 'role' | 'content'> & {
  images?: string[]
}

export type ChatStartRequest = {
  requestId: string
  model: ModelConfig
  instructions: string
  attachments: ChatAttachment[]
  webSearch: boolean
  forceWebSearch?: boolean
  messages: ChatContextMessage[]
  historyArchive?: ChatContextMessage[]
  contextMemory?: string
}

export type ChatEvent = {
  requestId: string
  type: 'chunk' | 'reasoning' | 'status' | 'tool' | 'context' | 'done' | 'error'
  title?: string
  content?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  contextState?: ContextWindowState
  contextMemory?: ContextCompressionMemory
  usage?: TokenUsage
}

export type AgentStartRequest = {
  requestId: string
  model: ModelConfig
  objective: string
  workspaceRoot: string
  instructions: string
  skills: SkillDefinition[]
  attachments: ChatAttachment[]
  permissionMode: AgentPermissionMode
  confirmCreateDelete?: boolean
  contextMessages: ChatContextMessage[]
  historyArchive?: ChatContextMessage[]
  contextMemory?: string
}

export type AgentGuideRequest = {
  requestId: string
  content: string
  displayContent: string
  attachments: ChatAttachment[]
}

export type AgentChange = {
  path: string
  before: string
  after: string
  beforeExists?: boolean
  afterExists?: boolean
}

export type AgentApproval = {
  requestId: string
  approvalId: string
  title: string
  description: string
  toolName: string
  toolArgs: Record<string, unknown>
  risk: 'write' | 'create' | 'delete' | 'command'
  changes?: AgentChange[]
}

export type AgentEvent = {
  requestId: string
  type:
    | 'status'
    | 'reasoning'
    | 'chunk'
    | 'message'
    | 'tool'
    | 'file_change'
    | 'tasks'
    | 'guidance'
    | 'context'
    | 'approval'
    | 'done'
    | 'error'
  title?: string
  content?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  changes?: AgentChange[]
  approval?: AgentApproval
  tasks?: AgentTask[]
  contextState?: ContextWindowState
  contextMemory?: ContextCompressionMemory
  usage?: TokenUsage
}

export type CommandRequest = {
  id: string
  command: string
  cwd: string
}

export type CommandEvent = {
  id: string
  type: 'stdout' | 'stderr' | 'exit' | 'error'
  content: string
}

export type CodeRunRequest = {
  language: string
  code: string
  cwd: string
}

export type CodeRunResult = {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export type TerminalCreateRequest = {
  id: string
  cwd: string
  cols: number
  rows: number
}

export type TerminalDataEvent = {
  id: string
  type: 'data' | 'exit'
  data: string
}

export type PersistedConversation = {
  id: string
  title: string
  mode: ConversationMode
  model?: ModelConfig
  thinkingMode?: ThinkingMode
  messages: ChatMessage[]
  contextMemory?: {
    summary: string
    throughMessageId: string
    updatedAt: number
  }
  createdAt: number
  updatedAt: number
}
