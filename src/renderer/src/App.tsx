import { useEffect, useState } from 'react'
import { Info, X } from 'lucide-react'
import type {
  AgentEvent,
  AgentExecutionBlock,
  AgentStep,
  ChatEvent,
  ImageGenerationEvent,
  ChatMessage
} from '../../shared/types'
import { ActivityBar } from './components/ActivityBar'
import { ChatPanel } from './components/ChatPanel'
import { FileWorkspace } from './components/FileWorkspace'
import { ProjectSidebar } from './components/ProjectSidebar'
import { SearchPanel } from './components/SearchPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { useAppStore } from './store'

function isToolResultEvent(event: AgentEvent): boolean {
  return (
    event.type === 'tool' &&
    Boolean(
      event.title?.includes('已返回') ||
        event.title?.endsWith(' · 成功') ||
        event.title?.endsWith(' · 失败')
    )
  )
}

function toolResultFailed(event: AgentEvent): boolean {
  return Boolean(
    event.title?.endsWith(' · 失败') || event.content?.trimStart().startsWith('工具执行失败：')
  )
}

function updateAgentTimeline(message: ChatMessage, event: AgentEvent): AgentStep[] {
  const now = Date.now()
  const current = message.agentSteps ?? []
  if (isToolResultEvent(event)) {
    let updated = false
    return [...current].reverse().map((step) => {
      if (
        !updated &&
        (step.toolName === event.toolName || step.title === '等待确认') &&
        (step.status === 'running' || step.status === 'waiting')
      ) {
        updated = true
        return {
          ...step,
          title: event.title || step.title,
          status: toolResultFailed(event) ? ('error' as const) : ('done' as const),
          detail: event.content,
          completedAt: now
        }
      }
      return step
    }).reverse()
  }
  if (event.type === 'status' || event.type === 'tool' || event.type === 'approval') {
    const status = event.type === 'approval' || event.title === '等待确认' ? 'waiting' : 'running'
    const completed = current.map((step) =>
      step.status === 'running'
        ? { ...step, status: 'done' as const, completedAt: now }
        : step
    )
    return [
      ...completed,
      {
        id: crypto.randomUUID(),
        title: event.title || event.toolName || '处理中',
        detail: event.content || event.approval?.description,
        toolName: event.toolName,
        status,
        startedAt: now
      }
    ]
  }
  if (event.type === 'done' || event.type === 'error') {
    return current.map((step) =>
      step.status === 'running' || step.status === 'waiting'
        ? {
            ...step,
            status: event.type === 'error' ? ('error' as const) : ('done' as const),
            completedAt: now
          }
        : step
    )
  }
  return current
}

function settleExecutionBlocks(
  blocks: AgentExecutionBlock[] | undefined,
  nextStatus: 'done' | 'error' = 'done',
  completedAt = Date.now()
): AgentExecutionBlock[] | undefined {
  if (!blocks?.length) return blocks
  return blocks.map((block) => {
    if (block.type === 'thinking' && block.status !== 'done') {
      return { ...block, status: 'done' as const, updatedAt: completedAt }
    }
    if (
      block.type === 'operation' &&
      (block.status === 'running' || block.status === 'waiting')
    ) {
      return { ...block, status: nextStatus, completedAt }
    }
    return block
  })
}

function updateAgentBlocks(message: ChatMessage, event: AgentEvent): AgentExecutionBlock[] {
  const now = Date.now()
  const current = message.agentBlocks ?? []
  const settleOpenBlocks = (
    blocks: AgentExecutionBlock[],
    nextStatus: 'done' | 'error' = 'done'
  ): AgentExecutionBlock[] =>
    blocks.map((block) => {
      if (
        block.type === 'operation' &&
        (block.status === 'running' || block.status === 'waiting')
      ) {
        return { ...block, status: nextStatus, completedAt: now }
      }
      if (block.type === 'thinking' && block.status !== 'done') {
        return { ...block, status: 'done' as const, updatedAt: now }
      }
      return block
    })
  const settleThinkingBlocks = (blocks: AgentExecutionBlock[]): AgentExecutionBlock[] =>
    blocks.map((block) =>
      block.type === 'thinking' && block.status !== 'done'
        ? { ...block, status: 'done' as const, updatedAt: now }
        : block
    )

  if (event.type === 'reasoning' && event.content?.trim()) {
    const last = current[current.length - 1]
    if (last?.type === 'thinking' && last.status !== 'done') {
      return current.map((block, index) =>
        index === current.length - 1 && block.type === 'thinking'
          ? {
              ...block,
              content: `${block.content}${event.content}`,
              updatedAt: now
            }
          : block
      )
    }
    return [
      ...current,
      {
        id: crypto.randomUUID(),
        type: 'thinking',
        content: event.content,
        status: 'running',
        createdAt: now,
        updatedAt: now
      }
    ]
  }

  if (event.type === 'guidance' && event.content?.trim()) {
    return [
      ...settleThinkingBlocks(current),
      {
        id: crypto.randomUUID(),
        type: 'guidance',
        content: event.content,
        createdAt: now
      }
    ]
  }

  if (event.type === 'tasks' && event.tasks) {
    const settled = settleThinkingBlocks(current)
    const existingIndex = settled.findIndex((block) => block.type === 'tasks')
    if (existingIndex >= 0) {
      return settled.map((block, index) =>
        index === existingIndex && block.type === 'tasks'
          ? { ...block, items: event.tasks!, updatedAt: now }
          : block
      )
    }
    return [
      ...settled,
      {
        id: crypto.randomUUID(),
        type: 'tasks',
        title: '任务清单',
        items: event.tasks,
        createdAt: now,
        updatedAt: now
      }
    ]
  }

  if (isToolResultEvent(event)) {
    let updated = false
    return [...settleThinkingBlocks(current)].reverse().map((block) => {
      if (
        !updated &&
        block.type === 'operation' &&
        (block.toolName === event.toolName || block.title === '等待确认') &&
        (block.status === 'running' || block.status === 'waiting')
      ) {
        updated = true
        return {
          ...block,
          title: event.title || block.title,
          status: toolResultFailed(event) ? ('error' as const) : ('done' as const),
          detail: event.content || block.detail,
          completedAt: now
        }
      }
      return block
    }).reverse()
  }

  if (event.type === 'message' && event.content?.trim()) {
    return [
      ...settleOpenBlocks(current),
      {
        id: crypto.randomUUID(),
        type: 'response',
        content: event.content,
        createdAt: now
      }
    ]
  }

  if (event.type === 'chunk' && event.content) {
    return appendStreamingResponseBlock(message, event.content) ?? current
  }

  if (event.type === 'status' || event.type === 'tool' || event.type === 'approval') {
    const status = event.type === 'approval' || event.title === '等待确认' ? 'waiting' : 'running'
    const completed = settleOpenBlocks(current)
    return [
      ...completed,
      {
        id: crypto.randomUUID(),
        type: 'operation',
        title: event.title || event.toolName || '处理中',
        detail: event.content || event.approval?.description,
        toolName: event.toolName,
        status,
        startedAt: now
      }
    ]
  }

  if (event.type === 'error') {
    const completed = settleOpenBlocks(current, 'error')
    if (!event.content?.trim()) return completed
    return [
      ...completed,
      {
        id: crypto.randomUUID(),
        type: 'response',
        content: event.content,
        createdAt: now
      }
    ]
  }

  if (event.type === 'done') {
    const completed = settleOpenBlocks(current).map((block) =>
      event.title === '任务完成' && block.type === 'tasks'
        ? {
            ...block,
            items: block.items.map((item) => ({ ...item, status: 'completed' as const })),
            updatedAt: now
          }
        : block
    )
    if (completed.some((block) => block.type === 'response')) return completed
    return [
      ...completed,
      {
        id: crypto.randomUUID(),
        type: 'response',
        content: event.content || event.title || '任务已完成。',
        createdAt: now
      }
    ]
  }

  return current
}

function appendStreamingResponseBlock(
  message: ChatMessage,
  content: string
): AgentExecutionBlock[] | undefined {
  if (!message.agentBlocks?.length || !content) return message.agentBlocks
  const now = Date.now()
  const current = message.agentBlocks
  const last = current[current.length - 1]
  if (!content.trim() && last?.type !== 'response') return current
  if (last?.type === 'response') {
    return current.map((block, index) =>
      index === current.length - 1 && block.type === 'response'
        ? { ...block, content: `${block.content}${content}` }
        : block
    )
  }
  return [
    ...current.map((block) => {
      if (block.type === 'operation' && block.status === 'running') {
        return { ...block, status: 'done' as const, completedAt: now }
      }
      if (block.type === 'thinking' && block.status !== 'done') {
        return { ...block, status: 'done' as const, updatedAt: now }
      }
      return block
    }),
    {
      id: crypto.randomUUID(),
      type: 'response',
      content,
      createdAt: now
    }
  ]
}

type StreamEvent = { requestId: string; type: string; content?: string }
type BufferedStreamEvent<T extends StreamEvent> = {
  event: T
  contentParts: string[]
}

function enqueueStreamEvent<T extends StreamEvent>(
  queue: BufferedStreamEvent<T>[],
  event: T
): void {
  const last = queue[queue.length - 1]
  if (last?.event.type === event.type) {
    if (event.content) last.contentParts.push(event.content)
    return
  }
  queue.push({
    event,
    contentParts: event.content ? [event.content] : []
  })
}

function materializeStreamEvents<T extends StreamEvent>(
  queue: BufferedStreamEvent<T>[]
): T[] {
  return queue.map(({ event, contentParts }) => ({
    ...event,
    content: contentParts.join('')
  }))
}

function applyChatStreamEvents(message: ChatMessage, events: ChatEvent[]): ChatMessage {
  return events.reduce((current, event) => {
    if (event.type === 'chunk') {
      return {
        ...current,
        content: `${current.content}${event.content ?? ''}`,
        agentBlocks: appendStreamingResponseBlock(current, event.content ?? '')
      }
    }
    if (event.type === 'reasoning') {
      return {
        ...current,
        meta: event.title || event.content || current.meta,
        agentBlocks: updateAgentBlocks(current, {
          requestId: event.requestId,
          type: 'reasoning',
          title: event.title,
          content: event.content
        })
      }
    }
    return current
  }, message)
}

function applyAgentStreamEvents(message: ChatMessage, events: AgentEvent[]): ChatMessage {
  return events.reduce((current, event) => {
    const agentBlocks = updateAgentBlocks(current, event)
    if (event.type === 'chunk') {
      return {
        ...current,
        content: `${current.content}${event.content ?? ''}`,
        agentBlocks
      }
    }
    if (event.type === 'reasoning') {
      return {
        ...current,
        meta: event.title || '思考',
        agentBlocks
      }
    }
    return current
  }, message)
}

function applyImageStreamEvents(
  message: ChatMessage,
  events: ImageGenerationEvent[]
): ChatMessage {
  return events.reduce((current, event) => {
    if (event.type === 'reasoning') {
      return {
        ...current,
        agentBlocks: updateAgentBlocks(current, {
          requestId: event.requestId,
          type: 'reasoning',
          content: event.content
        })
      }
    }
    if (event.type === 'chunk') {
      return {
        ...current,
        content: `${current.content}${event.content ?? ''}`,
        agentBlocks: updateAgentBlocks(current, {
          requestId: event.requestId,
          type: 'chunk',
          content: event.content
        })
      }
    }
    return current
  }, message)
}

function LeftPanel({
  onOpenFile
}: {
  onOpenFile: (path: string, line?: number) => Promise<void>
}): React.JSX.Element {
  const section = useAppStore((state) => state.activeSection)
  if (section === 'explorer') return <ProjectSidebar onOpenFile={onOpenFile} />
  if (section === 'search') return <SearchPanel onOpenFile={onOpenFile} />
  return <ProjectSidebar onOpenFile={onOpenFile} />
}

export default function App(): React.JSX.Element {
  const workspaceRoot = useAppStore((state) => state.workspaceRoot)
  const workspaceRoots = useAppStore((state) => state.workspaceRoots)
  const settingsOpen = useAppStore((state) => state.settingsOpen)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [projectWidth, setProjectWidth] = useState(() =>
    Number(localStorage.getItem('layout-project-width') || 260)
  )
  const [chatWidth, setChatWidth] = useState(() =>
    Number(localStorage.getItem('layout-chat-width') || 420)
  )

  const beginResize = (
    target: 'project' | 'chat',
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = target === 'project' ? projectWidth : chatWidth
    document.body.classList.add('is-resizing')

    const move = (pointerEvent: PointerEvent): void => {
      const delta = pointerEvent.clientX - startX
      if (target === 'project') {
        setProjectWidth(Math.max(180, Math.min(460, startWidth + delta)))
      } else {
        setChatWidth(Math.max(320, Math.min(720, startWidth + delta)))
      }
    }
    const stop = (): void => {
      document.body.classList.remove('is-resizing')
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
  }

  useEffect(() => {
    localStorage.setItem('layout-project-width', String(projectWidth))
  }, [projectWidth])

  useEffect(() => {
    localStorage.setItem('layout-chat-width', String(chatWidth))
  }, [chatWidth])

  const openFile = async (filePath: string, line?: number): Promise<void> => {
    const state = useAppStore.getState()
    const fileRoot = [...state.workspaceRoots]
      .sort((left, right) => right.length - left.length)
      .find(
        (root) =>
          filePath === root ||
          filePath.startsWith(`${root}\\`) ||
          filePath.startsWith(`${root}/`)
      )
    if (!fileRoot) return
    const existing = state.openFiles.find((file) => file.path === filePath)
    if (existing) {
      state.openFile({ ...existing, revealLine: line })
      return
    }
    try {
      const content = await window.localAgent.files.read(fileRoot, filePath)
      state.openFile({
        path: filePath,
        name: filePath.split(/[\\/]/).pop() ?? filePath,
        content,
        savedContent: content,
        revealLine: line
      })
    } catch (error) {
      console.error(error)
    }
  }

  useEffect(() => {
    useAppStore.getState().settleInterruptedConversations()
    const state = useAppStore.getState()
    if (state.model.preset === 'kimi-code' && !state.model.apiKey) {
      void window.localAgent.credentials.getKimiCodeApiKey().then((apiKey) => {
        const latest = useAppStore.getState()
        if (apiKey && latest.model.preset === 'kimi-code' && !latest.model.apiKey) {
          latest.setModel({ ...latest.model, apiKey })
        }
      })
    } else if (state.model.connectionId && !state.model.apiKey) {
      const connectionId = state.model.connectionId
      void window.localAgent.credentials.getModelApiKey(connectionId).then((apiKey) => {
        const latest = useAppStore.getState()
        if (
          apiKey &&
          latest.model.connectionId === connectionId &&
          !latest.model.apiKey
        ) {
          latest.setModel({ ...latest.model, apiKey })
        }
      })
    }
  }, [])

  useEffect(() => {
    if (!workspaceRoots.length) return
    workspaceRoots.forEach((root) => {
      void window.localAgent.workspace.watch(root)
      void window.localAgent.workspace
        .tree(root)
        .then((tree) => useAppStore.getState().setFileTreeForRoot(root, tree))
        .catch(() => undefined)
    })
    return () => {
      workspaceRoots.forEach((root) => void window.localAgent.workspace.unwatch(root))
    }
  }, [workspaceRoots.join('|')])

  useEffect(() => {
    return window.localAgent.workspace.onChanged((payload) => {
      const state = useAppStore.getState()
      if (!state.workspaceRoots.includes(payload.root)) return
      void window.localAgent.workspace
        .tree(payload.root)
        .then((tree) => useAppStore.getState().setFileTreeForRoot(payload.root, tree))
      const cleanOpenFiles = state.openFiles.filter(
        (file) =>
          file.content === file.savedContent &&
          (file.path === payload.root ||
            file.path.startsWith(`${payload.root}\\`) ||
            file.path.startsWith(`${payload.root}/`))
      )
      for (const file of cleanOpenFiles) {
        void window.localAgent.files
          .read(payload.root, file.path)
          .then((content) => {
            const latest = useAppStore.getState()
            const current = latest.openFiles.find((item) => item.path === file.path)
            if (!current || current.content !== current.savedContent) return
            if (current.content === content && current.savedContent === content) return
            latest.updateFileContent(file.path, content)
            latest.markFileSaved(file.path)
          })
          .catch(() => undefined)
      }
    })
  }, [])

  useEffect(() => {
    const chatStreamQueues = new Map<string, BufferedStreamEvent<ChatEvent>[]>()
    const agentStreamQueues = new Map<string, BufferedStreamEvent<AgentEvent>[]>()
    const imageStreamQueues = new Map<
      string,
      BufferedStreamEvent<ImageGenerationEvent>[]
    >()
    let streamFlushTimer: number | undefined

    const flushChatRequest = (requestId: string): void => {
      const events = chatStreamQueues.get(requestId)
      if (!events?.length) return
      chatStreamQueues.delete(requestId)
      const state = useAppStore.getState()
      const request = state.pending[requestId]
      if (!request) return
      state.updateMessage(request.conversationId, request.assistantId, (message) =>
        applyChatStreamEvents(message, materializeStreamEvents(events))
      )
    }

    const flushAgentRequest = (requestId: string): void => {
      const events = agentStreamQueues.get(requestId)
      if (!events?.length) return
      agentStreamQueues.delete(requestId)
      const state = useAppStore.getState()
      const request = state.pending[requestId]
      if (!request) return
      state.updateMessage(request.conversationId, request.assistantId, (message) =>
        applyAgentStreamEvents(message, materializeStreamEvents(events))
      )
    }

    const flushImageRequest = (requestId: string): void => {
      const events = imageStreamQueues.get(requestId)
      if (!events?.length) return
      imageStreamQueues.delete(requestId)
      const state = useAppStore.getState()
      const request = state.pending[requestId]
      if (!request) return
      state.updateMessage(request.conversationId, request.assistantId, (message) =>
        applyImageStreamEvents(message, materializeStreamEvents(events))
      )
    }

    const flushStreamQueues = (): void => {
      streamFlushTimer = undefined
      for (const requestId of [...chatStreamQueues.keys()]) flushChatRequest(requestId)
      for (const requestId of [...agentStreamQueues.keys()]) flushAgentRequest(requestId)
      for (const requestId of [...imageStreamQueues.keys()]) flushImageRequest(requestId)
    }

    const scheduleStreamFlush = (): void => {
      if (streamFlushTimer !== undefined) return
      streamFlushTimer = window.setTimeout(flushStreamQueues, 120)
    }

    const unsubscribeChat = window.localAgent.chat.onEvent((event) => {
      if (event.type === 'chunk' || event.type === 'reasoning') {
        const queue = chatStreamQueues.get(event.requestId) ?? []
        enqueueStreamEvent(queue, event)
        chatStreamQueues.set(event.requestId, queue)
        scheduleStreamFlush()
        return
      }
      flushChatRequest(event.requestId)
      const state = useAppStore.getState()
      const request = state.pending[event.requestId]
      if (!request) return
      if (event.type === 'context' && event.contextMemory) {
        state.setConversationContextMemory(request.conversationId, event.contextMemory)
      }
      state.updateMessage(request.conversationId, request.assistantId, (message) => {
        if (event.type === 'status' || event.type === 'tool') {
          const agentBlocks = updateAgentBlocks(
            message,
            {
              requestId: event.requestId,
              type: event.type,
              title: event.title,
              content: event.content,
              toolName: event.toolName,
              toolArgs: event.toolArgs
            }
          )
          return {
            ...message,
            meta: event.title || event.content || message.meta,
            agentBlocks
          }
        }
        if (event.type === 'context') {
          return {
            ...message,
            contextState: event.contextState ?? message.contextState,
            usage: event.usage ?? message.usage
          }
        }
        if (event.type === 'error') {
          const completedAt = Date.now()
          return {
            ...message,
            status: 'error',
            content: message.content || event.content || '请求失败',
            completedAt,
            agentBlocks: settleExecutionBlocks(message.agentBlocks, 'error', completedAt)
          }
        }
        const completedAt = Date.now()
        return {
          ...message,
          status: 'done',
          meta: event.content || message.meta,
          completedAt,
          usage: event.usage ?? message.usage,
          agentBlocks: settleExecutionBlocks(message.agentBlocks, 'done', completedAt)
        }
      })
      if (event.usage && !event.usage.estimated) {
        state.addTokenUsageRecord({
          id: `chat:${event.requestId}`,
          timestamp: Date.now(),
          model: request.model,
          provider: request.provider,
          kind: 'chat',
          ...event.usage
        })
      }
      if (event.type === 'done' || event.type === 'error') state.clearPending(event.requestId)
    })

    const unsubscribeAgent = window.localAgent.agent.onEvent((event) => {
      if (event.type === 'chunk' || event.type === 'reasoning') {
        const queue = agentStreamQueues.get(event.requestId) ?? []
        enqueueStreamEvent(queue, event)
        agentStreamQueues.set(event.requestId, queue)
        scheduleStreamFlush()
        return
      }
      flushAgentRequest(event.requestId)
      const state = useAppStore.getState()
      const request = state.pending[event.requestId]
      if (!request) return
      if (event.type === 'file_change' && event.changes?.length) {
        state.applyLiveAgentChanges(event.changes)
        const affectedRoots = new Set(
          event.changes
            .map((change) =>
              [...state.workspaceRoots]
                .sort((left, right) => right.length - left.length)
                .find(
                  (root) =>
                    change.path === root ||
                    change.path.startsWith(`${root}\\`) ||
                    change.path.startsWith(`${root}/`)
                )
            )
            .filter((root): root is string => Boolean(root))
        )
        for (const root of affectedRoots) {
          void window.localAgent.workspace
            .tree(root)
            .then((tree) => useAppStore.getState().setFileTreeForRoot(root, tree))
        }
        return
      }
      const checkpointId =
        event.type === 'done' && event.changes?.length ? crypto.randomUUID() : undefined
      if (event.type === 'approval' && event.approval) {
        state.setAgentApproval(event.approval)
      }
      if (event.type === 'context' && event.contextMemory) {
        state.setConversationContextMemory(request.conversationId, event.contextMemory)
      }
      state.updateMessage(request.conversationId, request.assistantId, (message) => {
        const agentSteps = updateAgentTimeline(message, event)
        const agentBlocks = updateAgentBlocks(message, event)
        if (event.type === 'message') {
          return {
            ...message,
            content: [message.content, event.content].filter(Boolean).join('\n\n'),
            agentSteps,
            agentBlocks
          }
        }
        if (event.type === 'context') {
          return {
            ...message,
            contextState: event.contextState ?? message.contextState,
            usage: event.usage ?? message.usage,
            agentSteps,
            agentBlocks
          }
        }
        if (event.type === 'status') {
          return {
            ...message,
            meta: event.title || event.content || '处理中',
            agentSteps,
            agentBlocks
          }
        }
        if (event.type === 'tool') {
          return {
            ...message,
            meta: event.toolName ? `工具：${event.toolName}` : event.title,
            agentSteps,
            agentBlocks
          }
        }
        if (event.type === 'approval') {
          return {
            ...message,
            meta: '等待确认',
            agentSteps,
            agentBlocks
          }
        }
        if (event.type === 'tasks') {
          return {
            ...message,
            meta: '任务清单已更新',
            agentSteps,
            agentBlocks
          }
        }
        if (event.type === 'guidance') {
          return {
            ...message,
            meta: '已接收运行中引导',
            agentSteps,
            agentBlocks
          }
        }
        if (event.type === 'error') {
          return {
            ...message,
            status: 'error',
            content: [message.content, event.content || '任务失败'].filter(Boolean).join('\n\n'),
            meta: event.title,
            completedAt: Date.now(),
            agentSteps,
            agentBlocks,
            checkpointId: checkpointId ?? message.checkpointId,
            usage: event.usage ?? message.usage
          }
        }
        return {
          ...message,
          status: 'done',
          meta: event.title || '任务完成',
          content: message.content || '任务已完成。',
          completedAt: Date.now(),
          agentSteps,
          agentBlocks,
          checkpointId: checkpointId ?? message.checkpointId,
          usage: event.usage ?? message.usage
        }
      })

      if (event.type === 'done' || event.type === 'error') {
        state.clearPending(event.requestId)
        if (state.agentApproval?.requestId === event.requestId) {
          state.setAgentApproval(null)
        }
      }
      if (event.usage && !event.usage.estimated) {
        state.addTokenUsageRecord({
          id: `agent:${event.requestId}`,
          timestamp: Date.now(),
          model: request.model,
          provider: request.provider,
          kind: 'agent',
          ...event.usage
        })
      }
      if (event.type === 'done' && event.changes?.length) {
        state.addAgentCheckpoint({
          id: checkpointId!,
          conversationId: request.conversationId,
          messageId: request.assistantId,
          changes: event.changes,
          createdAt: Date.now()
        })
        if (state.workspaceRoot) {
          void window.localAgent.workspace
            .tree(state.workspaceRoot)
            .then((tree) => useAppStore.getState().setFileTree(tree))
        }
      }
    })

    const unsubscribeImage = window.localAgent.image.onEvent((event) => {
      if (event.type === 'chunk' || event.type === 'reasoning') {
        const queue = imageStreamQueues.get(event.requestId) ?? []
        enqueueStreamEvent(queue, event)
        imageStreamQueues.set(event.requestId, queue)
        scheduleStreamFlush()
        return
      }
      flushImageRequest(event.requestId)
      const state = useAppStore.getState()
      const request = state.pending[event.requestId]
      if (!request) return
      state.updateMessage(request.conversationId, request.assistantId, (message) => {
        if (event.type === 'status') {
          if (event.content?.includes('图片队列')) {
            return message
          }
          const title = event.content?.includes('扩写')
            ? '扩写英文 Prompt'
            : event.content?.includes('卸载')
              ? '切换图片模型'
              : event.content?.includes('队列')
                ? '图片生成队列'
                : '准备图片生成'
          return {
            ...message,
            meta: event.content || message.meta,
            agentBlocks: updateAgentBlocks(message, {
              requestId: event.requestId,
              type: 'status',
              title,
              content: event.content
            })
          }
        }
        if (event.type === 'progress') {
          const now = Date.now()
          const blocks = message.agentBlocks ?? []
          let runningIndex = -1
          for (let index = blocks.length - 1; index >= 0; index -= 1) {
            const block = blocks[index]
            if (block.type === 'operation' && block.status === 'running') {
              runningIndex = index
              break
            }
          }
          return {
            ...message,
            meta: event.content || message.meta,
            agentBlocks:
              runningIndex >= 0
                ? blocks.map((block, index) =>
                    index === runningIndex && block.type === 'operation'
                      ? { ...block, title: '生成图片', detail: event.content }
                      : block
                  )
                : [
                    ...blocks,
                    {
                      id: crypto.randomUUID(),
                      type: 'operation' as const,
                      title: '生成图片',
                      detail: event.content,
                      status: 'running' as const,
                      startedAt: now
                    }
                  ]
          }
        }
        if (event.type === 'prompt') {
          return {
            ...message,
            meta: event.content || '英文 Prompt 已生成',
            content: message.content || event.enhancedPrompt || '',
            usage: event.usage
          }
        }
        if (event.type === 'error') {
          return {
            ...message,
            status: 'error',
            meta: event.content || '图片生成失败',
            content:
              message.content ||
              (event.enhancedPrompt
                ? `**英文 Prompt**\n\n${event.enhancedPrompt}`
                : event.content || '图片生成失败'),
            completedAt: Date.now(),
            agentBlocks: settleExecutionBlocks(message.agentBlocks, 'error')
          }
        }
        const completedAt = Date.now()
        const settledBlocks = settleExecutionBlocks(
          message.agentBlocks,
          'done',
          completedAt
        ) ?? []
        return {
          ...message,
          status: 'done',
          meta: event.content || '图片生成完成',
          content: [
            event.content ? `**生成配置**：${event.content}` : '',
            event.enhancedPrompt ? `**英文 Prompt**\n\n${event.enhancedPrompt}` : message.content
          ]
            .filter(Boolean)
            .join('\n\n'),
          attachments: event.images ?? [],
          completedAt,
          usage: event.usage,
          agentBlocks: event.images?.length
            ? [
                ...settledBlocks,
                {
                  id: crypto.randomUUID(),
                  type: 'image' as const,
                  images: event.images,
                  title: '生成图片',
                  createdAt: completedAt
                }
              ]
            : settledBlocks
        }
      })
      if (event.type === 'done' || event.type === 'error') {
        state.clearPending(event.requestId)
      }
      if (event.usage && !event.usage.estimated) {
        state.addTokenUsageRecord({
          id: `image:${event.requestId}`,
          timestamp: Date.now(),
          model: request.model,
          provider: request.provider,
          kind: 'image',
          ...event.usage
        })
      }
    })
    return () => {
      if (streamFlushTimer !== undefined) window.clearTimeout(streamFlushTimer)
      flushStreamQueues()
      unsubscribeChat()
      unsubscribeAgent()
      unsubscribeImage()
    }
  }, [])

  useEffect(() => {
    const handleKeys = (event: KeyboardEvent): void => {
      const state = useAppStore.getState()
      if (event.ctrlKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        state.createConversation()
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        state.setSection('search')
      }
      if (event.key === 'Escape' && state.settingsOpen) {
        state.setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeys)
    return () => window.removeEventListener('keydown', handleKeys)
  }, [])

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="titlebar-brand">
          <span className="brand-glyph">SA</span>
          <strong>星伴 AI</strong>
          <span className="titlebar-workspace">
            {workspaceRoot ? `— ${workspaceRoot.split(/[\\/]/).pop()}` : '— 个人工作台'}
          </span>
        </div>
        <button
          className="titlebar-about"
          type="button"
          onClick={() => setAboutOpen(true)}
          title="关于星伴 AI"
        >
          <Info size={13} /> About
        </button>
      </header>
      <div
        className="app-content"
        style={{
          gridTemplateColumns: `54px ${projectWidth}px 4px ${chatWidth}px 4px minmax(360px, 1fr)`
        }}
      >
        <ActivityBar />
        <aside className="left-panel">
          <LeftPanel onOpenFile={openFile} />
        </aside>
        <div
          className="resize-handle vertical"
          onPointerDown={(event) => beginResize('project', event)}
          title="拖动调整项目栏宽度"
        />
        <aside className="chat-column">
          <ChatPanel />
        </aside>
        <div
          className="resize-handle vertical"
          onPointerDown={(event) => beginResize('chat', event)}
          title="拖动调整聊天栏宽度"
        />
        <FileWorkspace />
      </div>
      <footer className="statusbar">
        <span className="status-item">
          <i className="status-dot online" />
          本地模式
        </span>
        <span className="status-center">
          {workspaceRoot || '未打开工作区'}
        </span>
        <span className="status-item">数据仅保存在本机</span>
      </footer>
      {settingsOpen && (
        <div
          className="settings-modal-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              useAppStore.getState().setSettingsOpen(false)
            }
          }}
        >
          <SettingsPanel onClose={() => useAppStore.getState().setSettingsOpen(false)} />
        </div>
      )}
      {aboutOpen && (
        <div
          className="about-modal-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setAboutOpen(false)
          }}
        >
          <section className="about-modal" role="dialog" aria-modal="true" aria-label="关于星伴 AI">
            <button
              className="about-close"
              type="button"
              onClick={() => setAboutOpen(false)}
              title="关闭"
            >
              <X size={15} />
            </button>
            <span className="about-logo">SA</span>
            <h2>星伴 AI</h2>
            <p>你的本地 AI 工作伙伴</p>
            <dl>
              <div><dt>版本</dt><dd>0.7.95</dd></div>
              <div><dt>运行方式</dt><dd>本地优先</dd></div>
              <div><dt>数据存储</dt><dd>仅保存在本机</dd></div>
            </dl>
          </section>
        </div>
      )}
    </div>
  )
}
