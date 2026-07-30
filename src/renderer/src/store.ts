import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import type {
  AgentApproval,
  AgentChange,
  AgentExecutionBlock,
  AgentPermissionMode,
  AppSection,
  ChatMessage,
  ComfyWorkflow,
  ContextCompressionMemory,
  ConversationMode,
  FileNode,
  FileEncoding,
  ModelConfig,
  PersistedConversation,
  SkillDefinition,
  ThinkingMode,
  TokenUsageRecord
} from '../../shared/types'
import type { EditorTheme } from './editorThemes'
import {
  remapWorkspaceExpandedPaths,
  removeWorkspaceExpandedPaths,
  updateWorkspacePathExpanded,
  type WorkspaceExpandedPaths
} from './utils/project-tree-state'
import { createReferenceMemoizedProjection } from './utils/reference-memo'
import { isChatScrollActive } from './utils/chat-scroll-activity'

const pendingStorageWrites = new Map<string, StorageValue<unknown>>()
const latestPersistedStateByName = new Map<string, unknown>()
const storageWriteChains = new Map<string, Promise<void>>()
let storageWriteTimer: number | undefined
let persistenceDatabase: Promise<IDBDatabase> | undefined

function openPersistenceDatabase(): Promise<IDBDatabase> {
  if (persistenceDatabase) return persistenceDatabase
  persistenceDatabase = new Promise((resolve, reject) => {
    const request = window.indexedDB.open('star-companion-persistence', 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('zustand')) {
        database.createObjectStore('zustand')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开会话数据库'))
  })
  return persistenceDatabase
}

async function readDatabaseValue(name: string): Promise<StorageValue<unknown> | null> {
  const database = await openPersistenceDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('zustand', 'readonly')
    const request = transaction.objectStore('zustand').get(name)
    request.onsuccess = () => resolve((request.result as StorageValue<unknown> | undefined) ?? null)
    request.onerror = () => reject(request.error ?? new Error('无法读取会话数据库'))
  })
}

async function writeDatabaseValue(name: string, value: StorageValue<unknown>): Promise<void> {
  const database = await openPersistenceDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('zustand', 'readwrite')
    transaction.objectStore('zustand').put(value, name)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('无法写入会话数据库'))
    transaction.onabort = () => reject(transaction.error ?? new Error('会话数据库写入已中止'))
  })
}

function queueDatabaseWrite(name: string, value: StorageValue<unknown>): void {
  const previous = storageWriteChains.get(name) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => writeDatabaseValue(name, value))
    .catch(() => {
      // 极旧环境无法使用 IndexedDB 时才回退；正常路径不在渲染线程序列化超长会话。
      window.localStorage.setItem(name, JSON.stringify(value))
    })
  storageWriteChains.set(name, next)
  void next.finally(() => {
    if (storageWriteChains.get(name) === next) storageWriteChains.delete(name)
  })
}

function flushStorageWrites(force = false): void {
  if (storageWriteTimer !== undefined) {
    window.clearTimeout(storageWriteTimer)
    storageWriteTimer = undefined
  }
  if (!force && isChatScrollActive()) {
    storageWriteTimer = window.setTimeout(flushStorageWrites, 240)
    return
  }
  for (const [name, value] of pendingStorageWrites) queueDatabaseWrite(name, value)
  pendingStorageWrites.clear()
}

const bufferedPersistStorage: PersistStorage<unknown> = {
  getItem: async (name) => {
    if (pendingStorageWrites.has(name)) return pendingStorageWrites.get(name) ?? null
    try {
      const databaseValue = await readDatabaseValue(name)
      if (databaseValue) {
        latestPersistedStateByName.set(name, databaseValue.state)
        return databaseValue
      }
    } catch {
      // 继续尝试读取旧版 localStorage 数据。
    }
    const legacyValue = window.localStorage.getItem(name)
    if (!legacyValue) return null
    try {
      const parsed = JSON.parse(legacyValue) as StorageValue<unknown>
      latestPersistedStateByName.set(name, parsed.state)
      queueDatabaseWrite(name, parsed)
      window.localStorage.removeItem(name)
      return parsed
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    if (latestPersistedStateByName.get(name) === value.state) return
    latestPersistedStateByName.set(name, value.state)
    pendingStorageWrites.set(name, value)
    if (storageWriteTimer !== undefined) window.clearTimeout(storageWriteTimer)
    storageWriteTimer = window.setTimeout(flushStorageWrites, 1200)
  },
  removeItem: (name) => {
    pendingStorageWrites.delete(name)
    latestPersistedStateByName.delete(name)
    window.localStorage.removeItem(name)
    void openPersistenceDatabase().then(
      (database) => {
        const transaction = database.transaction('zustand', 'readwrite')
        transaction.objectStore('zustand').delete(name)
      },
      () => undefined
    )
  }
}

window.addEventListener('beforeunload', () => flushStorageWrites(true))

export type OpenFile = {
  path: string
  name: string
  content: string
  savedContent: string
  encoding: FileEncoding
  revealLine?: number
}

export type EditorSelection = {
  path: string
  text: string
  startLine: number
  endLine: number
}

export type AgentCheckpoint = {
  id: string
  conversationId: string
  messageId: string
  changes: AgentChange[]
  createdAt: number
}

type PendingRequest = {
  conversationId: string
  assistantId: string
  kind: 'chat' | 'agent' | 'image'
  model: string
  provider: ModelConfig['provider']
}

type AppStore = {
  activeSection: AppSection
  settingsOpen: boolean
  workspaceRoot: string
  workspaceRoots: string[]
  workspaceTrees: Record<string, FileNode[]>
  expandedWorkspacePaths: WorkspaceExpandedPaths
  fileTree: FileNode[]
  openFiles: OpenFile[]
  activeFilePath: string
  editorSelection: EditorSelection | null
  editorTheme: EditorTheme
  model: ModelConfig
  customModels: ModelConfig[]
  modelThinkingModes: Record<string, ThinkingMode>
  globalInstructions: string
  skills: SkillDefinition[]
  agentPermissionMode: AgentPermissionMode
  confirmCreateDelete: boolean
  agentApproval: AgentApproval | null
  agentCheckpoints: AgentCheckpoint[]
  reviewCheckpointId: string
  tokenUsageRecords: TokenUsageRecord[]
  comfyBaseUrl: string
  comfyWorkflows: ComfyWorkflow[]
  selectedComfyWorkflowId: string
  conversations: PersistedConversation[]
  activeConversationId: string
  pending: Record<string, PendingRequest>
  setSection: (section: AppSection) => void
  setSettingsOpen: (open: boolean) => void
  setWorkspace: (root: string, tree: FileNode[]) => void
  setActiveWorkspace: (root: string) => void
  renameWorkspaceRoot: (sourceRoot: string, targetRoot: string, tree: FileNode[]) => void
  closeWorkspace: (root: string) => void
  setFileTree: (tree: FileNode[]) => void
  setFileTreeForRoot: (root: string, tree: FileNode[]) => void
  setWorkspacePathExpanded: (path: string, expanded: boolean) => void
  openFile: (file: OpenFile) => void
  closeFile: (path: string) => void
  closeOtherFiles: (path: string) => void
  closeAllFiles: () => void
  reorderOpenFile: (sourcePath: string, targetPath: string) => void
  setActiveFile: (path: string) => void
  setEditorSelection: (selection: EditorSelection | null) => void
  setEditorTheme: (theme: EditorTheme) => void
  updateFileContent: (path: string, content: string) => void
  setFileEncoding: (path: string, encoding: FileEncoding) => void
  markFileSaved: (path: string) => void
  renameOpenPath: (sourcePath: string, targetPath: string) => void
  removeOpenPath: (targetPath: string) => void
  applyAgentChanges: (changes: AgentChange[]) => void
  applyLiveAgentChanges: (changes: AgentChange[]) => void
  setModel: (model: ModelConfig) => void
  saveCustomModel: (model: ModelConfig) => void
  deleteCustomModel: (connectionId: string) => void
  setGlobalInstructions: (value: string) => void
  setSkills: (skills: SkillDefinition[]) => void
  setAgentPermissionMode: (mode: AgentPermissionMode) => void
  setConfirmCreateDelete: (enabled: boolean) => void
  setAgentApproval: (approval: AgentApproval | null) => void
  addAgentCheckpoint: (checkpoint: AgentCheckpoint) => void
  setReviewCheckpointId: (id: string) => void
  addTokenUsageRecord: (record: TokenUsageRecord) => void
  setComfyBaseUrl: (value: string) => void
  setComfyWorkflows: (workflows: ComfyWorkflow[]) => void
  setSelectedComfyWorkflowId: (id: string) => void
  updateComfyWorkflow: (id: string, patch: Partial<ComfyWorkflow>) => void
  createConversation: () => string
  setConversationMode: (id: string, mode: ConversationMode) => void
  setConversationSkillIds: (id: string, skillIds: string[]) => void
  setConversationThinkingMode: (id: string, modelKey: string, mode: ThinkingMode) => void
  setConversationContextMemory: (id: string, memory: ContextCompressionMemory) => void
  setActiveConversation: (id: string) => void
  deleteConversation: (id: string) => void
  addMessage: (conversationId: string, message: ChatMessage) => void
  updateMessage: (
    conversationId: string,
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage
  ) => void
  registerPending: (requestId: string, value: PendingRequest) => void
  clearPending: (requestId: string) => void
  settleInterruptedConversations: () => void
}

const uid = (): string => crypto.randomUUID()
const now = Date.now()
const initialConversation: PersistedConversation = {
  id: uid(),
  title: '新会话',
  mode: 'chat',
  thinkingMode: 'auto',
  skillIds: [],
  messages: [],
  createdAt: now,
  updatedAt: now
}

const projectPersistedState = createReferenceMemoizedProjection(
  (state: AppStore) => [
    state.workspaceRoot,
    state.workspaceRoots,
    state.expandedWorkspacePaths,
    state.editorTheme,
    state.model,
    state.customModels,
    state.modelThinkingModes,
    state.globalInstructions,
    state.skills,
    state.agentPermissionMode,
    state.confirmCreateDelete,
    state.tokenUsageRecords,
    state.comfyBaseUrl,
    state.comfyWorkflows,
    state.selectedComfyWorkflowId,
    state.conversations,
    state.activeConversationId
  ],
  (state: AppStore) => ({
    workspaceRoot: state.workspaceRoot,
    workspaceRoots: state.workspaceRoots,
    expandedWorkspacePaths: state.expandedWorkspacePaths,
    editorTheme: state.editorTheme,
    model: { ...state.model, apiKey: undefined },
    customModels: state.customModels.map((item) => ({ ...item, apiKey: undefined })),
    modelThinkingModes: state.modelThinkingModes,
    globalInstructions: state.globalInstructions,
    skills: state.skills,
    agentPermissionMode: state.agentPermissionMode,
    confirmCreateDelete: state.confirmCreateDelete,
    tokenUsageRecords: state.tokenUsageRecords,
    comfyBaseUrl: state.comfyBaseUrl,
    comfyWorkflows: state.comfyWorkflows,
    selectedComfyWorkflowId: state.selectedComfyWorkflowId,
    conversations: state.conversations,
    activeConversationId: state.activeConversationId
  })
)

const defaultModel: ModelConfig = {
  provider: 'ollama',
  baseUrl: '',
  model: ''
}

function persistedModel(model: ModelConfig): ModelConfig {
  return {
    ...model,
    apiKey: undefined,
    thinkingMode: undefined
  }
}

function restoreConversationModel(
  conversation: PersistedConversation | undefined,
  current: ModelConfig
): ModelConfig {
  const saved = conversation?.model ?? defaultModel
  const sameCredential =
    saved.preset === current.preset && saved.connectionId === current.connectionId
  return {
    ...saved,
    apiKey: sameCredential ? current.apiKey : undefined
  }
}

function blockTime(block: AgentExecutionBlock): number {
  if (block.type === 'operation') return block.completedAt ?? block.startedAt
  if (block.type === 'thinking' || block.type === 'tasks') return block.updatedAt
  return block.createdAt
}

function messageLastActivity(message: ChatMessage): number {
  const blockTimes = (message.agentBlocks ?? []).map(blockTime)
  const stepTimes = (message.agentSteps ?? []).map((step) => step.completedAt ?? step.startedAt)
  return Math.max(
    message.completedAt ?? 0,
    message.startedAt ?? 0,
    message.createdAt,
    ...blockTimes,
    ...stepTimes
  )
}

function stripLegacyToolMarkup(content: string): string {
  return content
    .replace(
      /<(current_task|turn_boundary|completed_history_input|completed_history_result)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      ''
    )
    .replace(
      /<\|channel\|>\s*(?:thought|analysis|reasoning|commentary|final)\s*(?:<\|channel\|>|<\|message\|>)?/gi,
      ''
    )
    .replace(/<\|(?:message|end_of_turn|start_of_turn)\|>/gi, '')
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi, '')
    .replace(/<function_call\b[^>]*>[\s\S]*?<\/function_call\s*>/gi, '')
    .replace(/<\|tool_calls_begin\|>[\s\S]*?<\|tool_calls_end\|>/gi, '')
    .replace(/<\|python_tag\|>[\s\S]*?(?=<\|eot_id\|>|$)/gi, '')
    .replace(/\[tool_calls\][\s\S]*$/gi, '')
    .replace(/```tool_code[\s\S]*?```/gi, '')
    .replace(/<\/?(?:think|thinking|thought|analysis|reasoning)\b[^>]*>/gi, '')
    .replace(
      /<function\s*=\s*["']?[A-Za-z_][\w.-]*["']?\s*>[\s\S]*?<\/function\s*>/gi,
      ''
    )
    .trim()
}

function compactAgentBlocks(
  blocks: AgentExecutionBlock[] | undefined
): AgentExecutionBlock[] | undefined {
  if (!blocks?.length) return blocks
  let changed = false
  const cleaned: AgentExecutionBlock[] = []
  for (const block of blocks) {
    if (block.type !== 'thinking' && block.type !== 'response') {
      cleaned.push(block)
      continue
    }
    let content = stripLegacyToolMarkup(block.content)
    if (!content) {
      changed = true
      continue
    }
    if (content !== block.content) changed = true
    cleaned.push(content === block.content ? block : { ...block, content })
  }
  return changed ? cleaned : blocks
}

function settleInterruptedMessage(message: ChatMessage): ChatMessage {
  const agentBlocks = compactAgentBlocks(message.agentBlocks)
  const blocksChanged = agentBlocks !== message.agentBlocks
  const content =
    message.role === 'assistant' ? stripLegacyToolMarkup(message.content) : message.content
  const contentChanged = content !== message.content
  const hasRunningBlock = agentBlocks?.some(
    (block) =>
      (block.type === 'operation' && (block.status === 'running' || block.status === 'waiting')) ||
      (block.type === 'thinking' && block.status !== 'done')
  )
  const hasRunningStep = message.agentSteps?.some(
    (step) => step.status === 'running' || step.status === 'waiting'
  )
  if (message.status !== 'streaming' && !hasRunningBlock && !hasRunningStep) {
    return blocksChanged || contentChanged
      ? { ...message, content, agentBlocks }
      : message
  }
  const completedAt = message.completedAt ?? messageLastActivity(message)
  return {
    ...message,
    content,
    status: message.status === 'error' ? 'error' : 'done',
    meta: message.status === 'streaming' ? '会话已中断' : message.meta,
    completedAt,
    agentBlocks: agentBlocks?.map((block) => {
      if (block.type === 'thinking' && block.status !== 'done') {
        return { ...block, status: 'done' as const, updatedAt: block.updatedAt ?? completedAt }
      }
      if (
        block.type === 'operation' &&
        (block.status === 'running' || block.status === 'waiting')
      ) {
        return { ...block, status: 'error' as const, completedAt }
      }
      return block
    }),
    agentSteps: message.agentSteps?.map((step) =>
      step.status === 'running' || step.status === 'waiting'
        ? { ...step, status: 'error' as const, completedAt }
        : step
    )
  }
}

function settleInterruptedConversations(
  conversations: PersistedConversation[] = []
): PersistedConversation[] {
  return conversations.map((conversation) => ({
    ...conversation,
    mode: conversation.mode ?? 'chat',
    messages: conversation.messages.map(settleInterruptedMessage)
  }))
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      activeSection: 'explorer',
      settingsOpen: false,
      workspaceRoot: '',
      workspaceRoots: [],
      workspaceTrees: {},
      expandedWorkspacePaths: {},
      fileTree: [],
      openFiles: [],
      activeFilePath: '',
      editorSelection: null,
      editorTheme: 'one-dark-pro',
      model: defaultModel,
      customModels: [],
      modelThinkingModes: {},
      globalInstructions: '',
      skills: [],
      agentPermissionMode: 'read-write-manual',
      confirmCreateDelete: true,
      agentApproval: null,
      agentCheckpoints: [],
      reviewCheckpointId: '',
      tokenUsageRecords: [],
      comfyBaseUrl: 'http://127.0.0.1:8188',
      comfyWorkflows: [],
      selectedComfyWorkflowId: '',
      conversations: [initialConversation],
      activeConversationId: initialConversation.id,
      pending: {},
      setSection: (activeSection) => set({ activeSection }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setWorkspace: (root, tree) =>
        set((state) => {
          const workspaceRoots = state.workspaceRoots.includes(root)
            ? state.workspaceRoots
            : [...state.workspaceRoots, root]
          const workspaceRoot = state.workspaceRoot || root
          const workspaceTrees = { ...state.workspaceTrees, [root]: tree }
          return {
            workspaceRoots,
            workspaceRoot,
            workspaceTrees,
            fileTree: workspaceRoot === root ? tree : state.fileTree
          }
        }),
      setActiveWorkspace: (workspaceRoot) =>
        set((state) => ({
          workspaceRoot,
          fileTree: state.workspaceTrees[workspaceRoot] ?? []
        })),
      renameWorkspaceRoot: (sourceRoot, targetRoot, tree) =>
        set((state) => {
          const replacePath = (value: string): string =>
            value === sourceRoot ||
            value.startsWith(`${sourceRoot}\\`) ||
            value.startsWith(`${sourceRoot}/`)
              ? `${targetRoot}${value.slice(sourceRoot.length)}`
              : value
          const workspaceTrees = { ...state.workspaceTrees }
          delete workspaceTrees[sourceRoot]
          workspaceTrees[targetRoot] = tree
          const workspaceRoot =
            state.workspaceRoot === sourceRoot ? targetRoot : state.workspaceRoot
          return {
            workspaceRoots: state.workspaceRoots.map((item) =>
              item === sourceRoot ? targetRoot : item
            ),
            workspaceTrees,
            expandedWorkspacePaths: remapWorkspaceExpandedPaths(
              state.expandedWorkspacePaths,
              sourceRoot,
              targetRoot
            ),
            workspaceRoot,
            fileTree: workspaceRoot === targetRoot ? tree : state.fileTree,
            openFiles: state.openFiles.map((file) => {
              const nextPath = replacePath(file.path)
              return {
                ...file,
                path: nextPath,
                name: nextPath.split(/[\\/]/).pop() ?? file.name
              }
            }),
            activeFilePath: replacePath(state.activeFilePath),
            editorSelection: state.editorSelection
              ? { ...state.editorSelection, path: replacePath(state.editorSelection.path) }
              : null,
            agentCheckpoints: state.agentCheckpoints.map((checkpoint) => ({
              ...checkpoint,
              changes: checkpoint.changes.map((change) => ({
                ...change,
                path: replacePath(change.path)
              }))
            }))
          }
        }),
      closeWorkspace: (root) =>
        set((state) => {
          const workspaceRoots = state.workspaceRoots.filter((item) => item !== root)
          const workspaceTrees = { ...state.workspaceTrees }
          delete workspaceTrees[root]
          const workspaceRoot =
            state.workspaceRoot === root ? workspaceRoots[0] ?? '' : state.workspaceRoot
          const removed = (value: string): boolean =>
            value === root || value.startsWith(`${root}\\`) || value.startsWith(`${root}/`)
          const openFiles = state.openFiles.filter((file) => !removed(file.path))
          return {
            workspaceRoots,
            workspaceTrees,
            expandedWorkspacePaths: removeWorkspaceExpandedPaths(
              state.expandedWorkspacePaths,
              root
            ),
            workspaceRoot,
            fileTree: workspaceTrees[workspaceRoot] ?? [],
            openFiles,
            activeFilePath: removed(state.activeFilePath)
              ? openFiles.at(-1)?.path ?? ''
              : state.activeFilePath
          }
        }),
      setFileTree: (fileTree) =>
        set((state) => ({
          fileTree,
          workspaceTrees: state.workspaceRoot
            ? { ...state.workspaceTrees, [state.workspaceRoot]: fileTree }
            : state.workspaceTrees
        })),
      setFileTreeForRoot: (root, tree) =>
        set((state) => ({
          workspaceTrees: { ...state.workspaceTrees, [root]: tree },
          fileTree: state.workspaceRoot === root ? tree : state.fileTree
        })),
      setWorkspacePathExpanded: (path, expanded) =>
        set((state) => ({
          expandedWorkspacePaths: updateWorkspacePathExpanded(
            state.expandedWorkspacePaths,
            path,
            expanded
          )
        })),
      openFile: (file) =>
        set((state) => {
          const existing = state.openFiles.find((item) => item.path === file.path)
          return {
            openFiles: existing
              ? state.openFiles.map((item) => (item.path === file.path ? { ...item, ...file } : item))
              : [...state.openFiles, file],
            activeFilePath: file.path
          }
        }),
      closeFile: (filePath) =>
        set((state) => {
          const index = state.openFiles.findIndex((file) => file.path === filePath)
          const nextFiles = state.openFiles.filter((file) => file.path !== filePath)
          const nextActive =
            state.activeFilePath === filePath
              ? nextFiles[index]?.path ?? nextFiles[index - 1]?.path ?? ''
              : state.activeFilePath
          return { openFiles: nextFiles, activeFilePath: nextActive }
        }),
      closeOtherFiles: (filePath) =>
        set((state) => ({
          openFiles: state.openFiles.filter((file) => file.path === filePath),
          activeFilePath: filePath
        })),
      closeAllFiles: () => set({ openFiles: [], activeFilePath: '', editorSelection: null }),
      reorderOpenFile: (sourcePath, targetPath) =>
        set((state) => {
          const sourceIndex = state.openFiles.findIndex((file) => file.path === sourcePath)
          const targetIndex = state.openFiles.findIndex((file) => file.path === targetPath)
          if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return state
          const openFiles = [...state.openFiles]
          const [moved] = openFiles.splice(sourceIndex, 1)
          openFiles.splice(targetIndex, 0, moved)
          return { openFiles }
        }),
      setActiveFile: (activeFilePath) => set({ activeFilePath, editorSelection: null }),
      setEditorSelection: (editorSelection) => set({ editorSelection }),
      setEditorTheme: (editorTheme) => set({ editorTheme }),
      updateFileContent: (filePath, content) =>
        set((state) => ({
          openFiles: state.openFiles.map((file) =>
            file.path === filePath ? { ...file, content } : file
          )
        })),
      setFileEncoding: (filePath, encoding) =>
        set((state) => ({
          openFiles: state.openFiles.map((file) =>
            file.path === filePath ? { ...file, encoding } : file
          )
        })),
      markFileSaved: (filePath) =>
        set((state) => ({
          openFiles: state.openFiles.map((file) =>
            file.path === filePath ? { ...file, savedContent: file.content } : file
          )
        })),
      renameOpenPath: (sourcePath, targetPath) =>
        set((state) => {
          const replacePath = (value: string): string =>
            value === sourcePath || value.startsWith(`${sourcePath}\\`) || value.startsWith(`${sourcePath}/`)
              ? `${targetPath}${value.slice(sourcePath.length)}`
              : value
          return {
            openFiles: state.openFiles.map((file) => {
              const nextPath = replacePath(file.path)
              return {
                ...file,
                path: nextPath,
                name: nextPath.split(/[\\/]/).pop() ?? file.name
              }
            }),
            expandedWorkspacePaths: remapWorkspaceExpandedPaths(
              state.expandedWorkspacePaths,
              sourcePath,
              targetPath
            ),
            activeFilePath: replacePath(state.activeFilePath)
          }
        }),
      removeOpenPath: (targetPath) =>
        set((state) => {
          const removed = (value: string): boolean =>
            value === targetPath ||
            value.startsWith(`${targetPath}\\`) ||
            value.startsWith(`${targetPath}/`)
          const openFiles = state.openFiles.filter((file) => !removed(file.path))
          return {
            openFiles,
            expandedWorkspacePaths: removeWorkspaceExpandedPaths(
              state.expandedWorkspacePaths,
              targetPath
            ),
            activeFilePath: removed(state.activeFilePath)
              ? openFiles.at(-1)?.path ?? ''
              : state.activeFilePath
          }
        }),
      applyAgentChanges: (changes) =>
        set((state) => {
          const next = [...state.openFiles]
          for (const change of changes) {
            const existingIndex = next.findIndex((file) => file.path === change.path)
            if (change.afterExists === false) {
              if (existingIndex >= 0) next.splice(existingIndex, 1)
              continue
            }
            const value: OpenFile = {
              path: change.path,
              name: change.path.split(/[\\/]/).pop() ?? change.path,
              content: change.after,
              savedContent: change.after,
              encoding: existingIndex >= 0 ? next[existingIndex].encoding : 'utf8'
            }
            if (existingIndex >= 0) next[existingIndex] = value
            else next.push(value)
          }
          return {
            openFiles: next,
            activeFilePath:
              [...changes].reverse().find((change) => change.afterExists !== false)?.path ??
              (next.some((file) => file.path === state.activeFilePath)
                ? state.activeFilePath
                : next.at(-1)?.path ?? '')
          }
        }),
      applyLiveAgentChanges: (changes) =>
        set((state) => {
          let next = [...state.openFiles]
          for (const change of changes) {
            const existingIndex = next.findIndex((file) => file.path === change.path)
            if (change.afterExists === false) {
              if (existingIndex >= 0) next.splice(existingIndex, 1)
              continue
            }
            if (existingIndex < 0) continue
            next[existingIndex] = {
              ...next[existingIndex],
              content: change.after,
              savedContent: change.after
            }
          }
          return {
            openFiles: next,
            activeFilePath: next.some((file) => file.path === state.activeFilePath)
              ? state.activeFilePath
              : next.at(-1)?.path ?? ''
          }
        }),
      setModel: (model) =>
        set((state) => ({
          model,
          conversations: state.conversations.map((conversation) =>
            conversation.id === state.activeConversationId
              ? { ...conversation, model: persistedModel(model), updatedAt: Date.now() }
              : conversation
          )
        })),
      saveCustomModel: (model) =>
        set((state) => ({
          customModels: [
            ...state.customModels.filter(
              (item) => item.connectionId !== model.connectionId
            ),
            { ...model, apiKey: undefined }
          ]
        })),
      deleteCustomModel: (connectionId) =>
        set((state) => ({
          customModels: state.customModels.filter(
            (item) => item.connectionId !== connectionId
          ),
          model:
            state.model.connectionId === connectionId ? { ...defaultModel } : state.model
        })),
      setGlobalInstructions: (globalInstructions) => set({ globalInstructions }),
      setSkills: (skills) => set({ skills }),
      setAgentPermissionMode: (agentPermissionMode) => set({ agentPermissionMode }),
      setConfirmCreateDelete: (confirmCreateDelete) => set({ confirmCreateDelete }),
      setAgentApproval: (agentApproval) => set({ agentApproval }),
      addAgentCheckpoint: (checkpoint) =>
        set((state) => ({
          agentCheckpoints: [checkpoint, ...state.agentCheckpoints].slice(0, 20)
        })),
      setReviewCheckpointId: (reviewCheckpointId) => set({ reviewCheckpointId }),
      addTokenUsageRecord: (record) =>
        set((state) => {
          const existingIndex = state.tokenUsageRecords.findIndex(
            (item) => item.id === record.id
          )
          if (existingIndex < 0) {
            return {
              tokenUsageRecords: [...state.tokenUsageRecords, record].slice(-12000)
            }
          }
          const tokenUsageRecords = [...state.tokenUsageRecords]
          tokenUsageRecords[existingIndex] = {
            ...record,
            timestamp: tokenUsageRecords[existingIndex].timestamp
          }
          return { tokenUsageRecords }
        }),
      setComfyBaseUrl: (comfyBaseUrl) => set({ comfyBaseUrl }),
      setComfyWorkflows: (comfyWorkflows) => set({ comfyWorkflows }),
      setSelectedComfyWorkflowId: (selectedComfyWorkflowId) =>
        set({ selectedComfyWorkflowId }),
      updateComfyWorkflow: (id, patch) =>
        set((state) => ({
          comfyWorkflows: state.comfyWorkflows.map((workflow) =>
            workflow.id === id ? { ...workflow, ...patch } : workflow
          )
        })),
      createConversation: () => {
        const id = uid()
        const currentModel = get().model
        const conversation: PersistedConversation = {
          id,
          title: '新会话',
          mode: 'chat',
          model: persistedModel(currentModel),
          thinkingMode: 'auto',
          skillIds: [],
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id
        }))
        return id
      },
      setConversationMode: (id, mode) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === id
              ? { ...conversation, mode, updatedAt: Date.now() }
              : conversation
          )
        })),
      setConversationSkillIds: (id, skillIds) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === id
              ? { ...conversation, skillIds: [...new Set(skillIds)], updatedAt: Date.now() }
              : conversation
          )
        })),
      setConversationThinkingMode: (id, modelKey, thinkingMode) =>
        set((state) => ({
          modelThinkingModes: modelKey
            ? { ...state.modelThinkingModes, [modelKey]: thinkingMode }
            : state.modelThinkingModes,
          conversations: state.conversations.map((conversation) =>
            conversation.id === id
              ? { ...conversation, thinkingMode, updatedAt: Date.now() }
              : conversation
          )
        })),
      setConversationContextMemory: (id, memory) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) => {
            if (conversation.id !== id || !memory.summary.trim()) return conversation
            const previousIndex = conversation.contextMemory
              ? conversation.messages.findIndex(
                  (message) => message.id === conversation.contextMemory?.throughMessageId
                )
              : -1
            const remainingMessages = conversation.messages
              .slice(previousIndex + 1)
              .filter((message) => message.role === 'user' || message.role === 'assistant')
            const checkpoint =
              remainingMessages[
                Math.min(memory.compressedMessageCount, remainingMessages.length) - 1
              ]
            if (!checkpoint) return conversation
            return {
              ...conversation,
              contextMemory: {
                summary: memory.summary.trim(),
                throughMessageId: checkpoint.id,
                updatedAt: Date.now()
              },
              updatedAt: Date.now()
            }
          })
        })),
      setActiveConversation: (activeConversationId) =>
        set((state) => {
          const conversation = state.conversations.find(
            (item) => item.id === activeConversationId
          )
          if (!conversation) return state
          return {
            activeConversationId,
            model: restoreConversationModel(conversation, state.model)
          }
        }),
      deleteConversation: (id) => {
        const state = get()
        let remaining = state.conversations.filter((item) => item.id !== id)
        if (remaining.length === 0) {
          const newId = state.createConversation()
          remaining = get().conversations
          set({ activeConversationId: newId })
          return
        }
        const nextActiveConversationId =
          state.activeConversationId === id ? remaining[0].id : state.activeConversationId
        const nextConversation = remaining.find(
          (conversation) => conversation.id === nextActiveConversationId
        )
        set({
          conversations: remaining,
          activeConversationId: nextActiveConversationId,
          model: restoreConversationModel(nextConversation, state.model)
        })
      },
      addMessage: (conversationId, message) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) => {
            if (conversation.id !== conversationId) return conversation
            const nextMessages = [...conversation.messages, message]
            const firstUser = nextMessages.find((item) => item.role === 'user')
            return {
              ...conversation,
              title:
                conversation.title === '新会话' && firstUser
                  ? firstUser.content.slice(0, 24)
                  : conversation.title,
              messages: nextMessages,
              updatedAt: Date.now()
            }
          })
        })),
      updateMessage: (conversationId, messageId, updater) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  messages: conversation.messages.map((message) =>
                    message.id === messageId ? updater(message) : message
                  ),
                  updatedAt: Date.now()
                }
              : conversation
          )
        })),
      registerPending: (requestId, value) =>
        set((state) => ({ pending: { ...state.pending, [requestId]: value } })),
      clearPending: (requestId) =>
        set((state) => {
          const pending = { ...state.pending }
          delete pending[requestId]
          return { pending }
        }),
      settleInterruptedConversations: () =>
        set((state) => ({
          pending: {},
          conversations: settleInterruptedConversations(state.conversations)
        }))
    }),
    {
      name: 'local-agent-studio',
      version: 18,
      storage: bufferedPersistStorage,
      migrate: (persisted) => {
        const state = persisted as Partial<AppStore>
        if (state.model?.model === 'qwen3:8b') {
          state.model = { ...defaultModel }
        }
        if (state.workspaceRoot && !state.workspaceRoots?.length) {
          state.workspaceRoots = [state.workspaceRoot]
        }
        const legacyPermissionMode = state.agentPermissionMode as string | undefined
        state.agentPermissionMode =
          legacyPermissionMode === 'read-only'
            ? 'read-only'
            : legacyPermissionMode === 'auto-edit' || legacyPermissionMode === 'full-auto'
              ? 'read-write-auto'
              : legacyPermissionMode === 'read-write-auto'
                ? 'read-write-auto'
                : 'read-write-manual'
        if (!state.editorTheme) state.editorTheme = 'one-dark-pro'
        if (typeof state.confirmCreateDelete !== 'boolean') state.confirmCreateDelete = true
        if (!state.customModels) state.customModels = []
        if (!state.modelThinkingModes) state.modelThinkingModes = {}
        if (!state.expandedWorkspacePaths) state.expandedWorkspacePaths = {}
        if (!state.tokenUsageRecords) state.tokenUsageRecords = []
        if (!state.comfyBaseUrl) state.comfyBaseUrl = 'http://127.0.0.1:8188'
        if (!state.comfyWorkflows) state.comfyWorkflows = []
        if (!state.selectedComfyWorkflowId) state.selectedComfyWorkflowId = ''
        state.workspaceTrees = {}
        state.conversations = settleInterruptedConversations(state.conversations).map(
          (conversation) => ({
            ...conversation,
            model: conversation.model ?? persistedModel(state.model ?? defaultModel),
            thinkingMode: conversation.thinkingMode ?? 'auto'
          })
        )
        const activeConversation = state.conversations.find(
          (conversation) => conversation.id === state.activeConversationId
        )
        state.model = restoreConversationModel(activeConversation, state.model ?? defaultModel)
        return state as AppStore
      },
      partialize: projectPersistedState
    }
  )
)
