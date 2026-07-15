import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentEvent,
  AgentGuideRequest,
  AgentStartRequest,
  ChatEvent,
  ChatStartRequest,
  CodeRunRequest,
  CommandEvent,
  CommandRequest,
  ModelConfig,
  ComfyWorkflow,
  ImageGenerationEvent,
  ImageGenerationRequest,
  TerminalCreateRequest,
  TerminalDataEvent
} from '../shared/types'

function bufferedEvents<
  T extends { requestId: string; type: string; content?: string }
>(
  channel: string,
  callback: (event: T) => void,
  streamingTypes: Set<string>
): () => void {
  const buffers = new Map<string, T[]>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const flush = (requestId: string): void => {
    const timer = timers.get(requestId)
    if (timer) clearTimeout(timer)
    timers.delete(requestId)
    const events = buffers.get(requestId) ?? []
    buffers.delete(requestId)
    events.forEach(callback)
  }
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => {
    if (!streamingTypes.has(payload.type)) {
      flush(payload.requestId)
      callback(payload)
      return
    }
    const events = buffers.get(payload.requestId) ?? []
    const last = events[events.length - 1]
    if (last?.type === payload.type) {
      last.content = `${last.content ?? ''}${payload.content ?? ''}`
    } else {
      events.push({ ...payload })
    }
    buffers.set(payload.requestId, events)
    if (!timers.has(payload.requestId)) {
      timers.set(payload.requestId, setTimeout(() => flush(payload.requestId), 24))
    }
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
    timers.forEach(clearTimeout)
    timers.clear()
    buffers.clear()
  }
}

const api = {
  workspace: {
    open: () => ipcRenderer.invoke('workspace:open'),
    tree: (root: string) => ipcRenderer.invoke('workspace:tree', root),
    rename: (root: string, nextName: string) =>
      ipcRenderer.invoke('workspace:rename', root, nextName),
    watch: (root: string) => ipcRenderer.invoke('workspace:watch', root),
    unwatch: (root: string) => ipcRenderer.invoke('workspace:unwatch', root),
    onChanged: (callback: (payload: { root: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { root: string }): void =>
        callback(payload)
      ipcRenderer.on('workspace:changed', listener)
      return () => {
        ipcRenderer.removeListener('workspace:changed', listener)
      }
    }
  },
  files: {
    read: (root: string, filePath: string) => ipcRenderer.invoke('files:read', root, filePath),
    write: (
      root: string,
      filePath: string,
      content: string,
      metadata?: { source?: 'user'; revision?: number }
    ) => ipcRenderer.invoke('files:write', root, filePath, content, metadata),
    search: (root: string, query: string) => ipcRenderer.invoke('files:search', root, query),
    rename: (root: string, filePath: string, nextName: string) =>
      ipcRenderer.invoke('files:rename', root, filePath, nextName),
    delete: (root: string, filePath: string) =>
      ipcRenderer.invoke('files:delete', root, filePath),
    create: (
      root: string,
      parentPath: string,
      name: string,
      kind: 'file' | 'directory'
    ) => ipcRenderer.invoke('files:create', root, parentPath, name, kind),
    duplicate: (root: string, filePath: string) =>
      ipcRenderer.invoke('files:duplicate', root, filePath),
    reveal: (filePath: string) => ipcRenderer.invoke('files:reveal', filePath),
    openExternal: (filePath: string) => ipcRenderer.invoke('files:openExternal', filePath)
  },
  app: {
    openConversationCache: () => ipcRenderer.invoke('app:openConversationCache') as Promise<string>,
    openExternal: (url: string) =>
      ipcRenderer.invoke('app:openExternal', url) as Promise<boolean>
  },
  model: {
    test: (model: ModelConfig) => ipcRenderer.invoke('model:test', model),
    discover: () => ipcRenderer.invoke('model:discover'),
    context: (model: ModelConfig) => ipcRenderer.invoke('model:context', model)
  },
  credentials: {
    getKimiCodeApiKey: () =>
      ipcRenderer.invoke('credentials:getKimiCodeApiKey') as Promise<string>,
    setKimiCodeApiKey: (apiKey: string) =>
      ipcRenderer.invoke('credentials:setKimiCodeApiKey', apiKey) as Promise<boolean>,
    getModelApiKey: (connectionId: string) =>
      ipcRenderer.invoke('credentials:getModelApiKey', connectionId) as Promise<string>,
    setModelApiKey: (connectionId: string, apiKey: string) =>
      ipcRenderer.invoke('credentials:setModelApiKey', connectionId, apiKey) as Promise<boolean>
  },
  skills: {
    import: () => ipcRenderer.invoke('skills:import')
  },
  comfy: {
    discoverWorkflows: () =>
      ipcRenderer.invoke('comfy:discoverWorkflows') as Promise<ComfyWorkflow[]>,
    inspect: (baseUrl: string, workflow: ComfyWorkflow) =>
      ipcRenderer.invoke('comfy:inspect', baseUrl, workflow),
    free: (baseUrl: string) => ipcRenderer.invoke('comfy:free', baseUrl)
  },
  images: {
    open: (source: string) => ipcRenderer.invoke('images:open', source),
    reveal: (source: string) => ipcRenderer.invoke('images:reveal', source),
    saveAs: (source: string, suggestedName: string) =>
      ipcRenderer.invoke('images:saveAs', source, suggestedName)
  },
  image: {
    start: (request: ImageGenerationRequest) => ipcRenderer.invoke('image:start', request),
    stop: (requestId: string, baseUrl: string) =>
      ipcRenderer.invoke('image:stop', requestId, baseUrl),
    onEvent: (callback: (event: ImageGenerationEvent) => void) =>
      bufferedEvents('image:event', callback, new Set(['chunk', 'reasoning']))
  },
  chat: {
    start: (request: ChatStartRequest) => ipcRenderer.invoke('chat:start', request),
    stop: (requestId: string) => ipcRenderer.invoke('chat:stop', requestId),
    onEvent: (callback: (event: ChatEvent) => void) =>
      bufferedEvents('chat:event', callback, new Set(['chunk', 'reasoning']))
  },
  agent: {
    start: (request: AgentStartRequest) => ipcRenderer.invoke('agent:start', request),
    guide: (request: AgentGuideRequest) => ipcRenderer.invoke('agent:guide', request),
    noteUserFileEdit: (
      root: string,
      filePath: string,
      revision: number,
      startLine: number,
      endLine: number
    ) => ipcRenderer.send('agent:userFileEdit', root, filePath, revision, startLine, endLine),
    stop: (requestId: string) => ipcRenderer.invoke('agent:stop', requestId),
    approve: (requestId: string, approvalId: string, approved: boolean) =>
      ipcRenderer.invoke('agent:approve', requestId, approvalId, approved),
    onEvent: (callback: (event: AgentEvent) => void) =>
      bufferedEvents('agent:event', callback, new Set(['chunk', 'reasoning']))
  },
  command: {
    run: (request: CommandRequest) => ipcRenderer.invoke('command:run', request),
    stop: (id: string) => ipcRenderer.invoke('command:stop', id),
    onEvent: (callback: (event: CommandEvent) => void) => {
      ipcRenderer.on('command:event', (_event, payload: CommandEvent) => callback(payload))
    }
  },
  code: {
    run: (request: CodeRunRequest) => ipcRenderer.invoke('code:run', request)
  },
  terminal: {
    create: (request: TerminalCreateRequest) => ipcRenderer.invoke('terminal:create', request),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', id, cols, rows),
    close: (id: string) => ipcRenderer.invoke('terminal:close', id),
    onEvent: (callback: (event: TerminalDataEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void =>
        callback(payload)
      ipcRenderer.on('terminal:event', listener)
      return () => {
        ipcRenderer.removeListener('terminal:event', listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('localAgent', api)

export type LocalAgentApi = typeof api
