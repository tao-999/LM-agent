import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron'
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from 'node:child_process'
import { promises as fs, watch as watchPath, type FSWatcher } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildFileTree,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  duplicateWorkspaceEntry,
  readTextFile,
  renameWorkspaceEntry,
  renameWorkspaceRoot,
  searchWorkspace,
  writeTextFile
} from './files'
import {
  runAgent,
  runWebChat,
  searchConversationHistoryArchive,
  type AgentUserFileEditLock
} from './agent'
import {
  discoverComfyWorkflows,
  freeComfyMemory,
  inspectComfyWorkflow,
  interruptComfy,
  runComfyWorkflow
} from './comfy'
import {
  discoverLocalModels,
  inspectModelContext,
  sameModel,
  completeWithTools,
  streamChat,
  testModelConnection,
  unloadLocalModel,
  type LlmMessage,
  type ToolDefinition
} from './models'
import type {
  AgentApproval,
  AgentGuideRequest,
  AgentStartRequest,
  AgentChange,
  ChatStartRequest,
  CodeRunRequest,
  CodeRunResult,
  CommandRequest,
  ComfyWorkflow,
  ImageGenerationRequest,
  ModelConfig,
  TokenUsage,
  TerminalCreateRequest
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
const chatControllers = new Map<string, AbortController>()
const agentControllers = new Map<string, AbortController>()
const imageControllers = new Map<string, AbortController>()
const agentGuidanceQueues = new Map<string, AgentGuideRequest[]>()
const agentUserFileEditStates = new Map<
  string,
  { workspaceRoot: string; locks: Map<string, AgentUserFileEditLock> }
>()
const agentApprovalResolvers = new Map<
  string,
  { resolve: (approved: boolean) => void; cleanup: () => void }
>()
const commandProcesses = new Map<string, ChildProcess>()
const terminalProcesses = new Map<string, ChildProcessWithoutNullStreams>()
const workspaceWatchers = new Map<string, FSWatcher>()
const workspaceWatchTimers = new Map<string, NodeJS.Timeout>()
let lastRequestedModel: ModelConfig | null = null
const imageQueue: ImageGenerationRequest[] = []
let activeImageRequest: ImageGenerationRequest | null = null
let imageQueueProcessing = false

type SecureCredentials = {
  kimiCodeApiKey?: string
}

function secureCredentialsPath(): string {
  return path.join(app.getPath('userData'), 'secure-credentials.json')
}

async function readSecureCredentials(): Promise<SecureCredentials> {
  try {
    const content = await fs.readFile(secureCredentialsPath(), 'utf8')
    const stored = JSON.parse(content) as Record<string, string | undefined>
    if (!stored.kimiCodeApiKey || !safeStorage.isEncryptionAvailable()) return {}
    return {
      kimiCodeApiKey: safeStorage.decryptString(
        Buffer.from(stored.kimiCodeApiKey, 'base64')
      )
    }
  } catch {
    return {}
  }
}

async function saveKimiCodeApiKey(apiKey: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统无法启用安全凭据存储，请检查 Windows 登录凭据服务')
  }
  const trimmed = apiKey.trim()
  if (!trimmed) {
    await fs.rm(secureCredentialsPath(), { force: true })
    return
  }
  const encrypted = safeStorage.encryptString(trimmed).toString('base64')
  await fs.mkdir(path.dirname(secureCredentialsPath()), { recursive: true })
  await fs.writeFile(
    secureCredentialsPath(),
    JSON.stringify({ kimiCodeApiKey: encrypted }, null, 2),
    'utf8'
  )
}

function normalizeWorkspaceFile(root: string, filePath: string): string | null {
  const absoluteRoot = path.resolve(root)
  const absolute = path.resolve(absoluteRoot, filePath)
  const relative = path.relative(absoluteRoot, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute.toLocaleLowerCase()
}

function recordUserFileEdit(
  root: string,
  filePath: string,
  revision: number,
  startLine: number,
  endLine: number
): void {
  const normalized = normalizeWorkspaceFile(root, filePath)
  if (!normalized || !Number.isSafeInteger(revision) || revision < 1) return
  const safeStartLine = Number.isSafeInteger(startLine) && startLine >= 1 ? startLine : 1
  const safeEndLine =
    Number.isSafeInteger(endLine) && endLine >= safeStartLine ? endLine : safeStartLine
  for (const state of agentUserFileEditStates.values()) {
    if (
      path.resolve(state.workspaceRoot).toLocaleLowerCase() !==
      path.resolve(root).toLocaleLowerCase()
    ) {
      continue
    }
    const previous = state.locks.get(normalized)
    state.locks.set(normalized, {
      path: path.resolve(root, filePath),
      revision,
      startLine: Math.min(previous?.startLine ?? safeStartLine, safeStartLine),
      endLine: Math.max(previous?.endLine ?? safeEndLine, safeEndLine),
      saved: false,
      changedAt: Date.now()
    })
  }
}

function markUserFileEditSaved(root: string, filePath: string, revision: number): void {
  const normalized = normalizeWorkspaceFile(root, filePath)
  if (!normalized) return
  for (const state of agentUserFileEditStates.values()) {
    const lock = state.locks.get(normalized)
    if (!lock || lock.revision !== revision) continue
    state.locks.set(normalized, { ...lock, saved: true })
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function send(channel: string, payload: unknown): void {
  if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(channel, payload)
}

async function openExternalUrl(value: string): Promise<boolean> {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    await shell.openExternal(url.toString())
    return true
  } catch {
    return false
  }
}

function generatedImagePath(source: string): string {
  if (!source.startsWith('local-file:')) throw new Error('仅支持本地生成图片')
  return fileURLToPath(source.replace(/^local-file:/, 'file:'))
}

async function prepareSingleModelRuntime(nextModel: ModelConfig): Promise<void> {
  if (!lastRequestedModel || sameModel(lastRequestedModel, nextModel)) {
    lastRequestedModel = nextModel
    return
  }
  const previous = lastRequestedModel
  lastRequestedModel = nextModel
  const result = await unloadLocalModel(previous)
  if (!result.ok) {
    console.warn(`Model unload failed: ${result.message}`)
  } else {
    console.log(result.message)
  }
}

async function releaseLanguageModel(model: ModelConfig): Promise<void> {
  const result = await unloadLocalModel(model)
  lastRequestedModel = null
  if (!result.ok) console.warn(`Model unload failed before image generation: ${result.message}`)
}

function cleanImagePrompt(value: string): string {
  return value
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^(?:prompt|english prompt)\s*:\s*/i, '')
    .trim()
}

function isReadyEnglishImagePrompt(value: string): boolean {
  const prompt = cleanImagePrompt(value)
  const hanCount = prompt.match(/[\u3400-\u9fff]/g)?.length ?? 0
  const latinCount = prompt.match(/[A-Za-z]/g)?.length ?? 0
  const words = prompt.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0
  return words >= 4 && latinCount >= Math.max(20, hanCount * 3)
}

function hostTimeContext(): string {
  const currentTime = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  return `<host_runtime_context source="host_os_clock" authoritative="true">
宿主系统当前时间：${currentTime}（Asia/Shanghai）。
此时间由正在运行应用的本机时钟直接提供，不是模型推断结果。禁止自行猜测当前日期，禁止使用训练截止日期覆盖此值。
</host_runtime_context>`
}

function updateImageQueuePositions(): void {
  imageQueue.forEach((request, index) => {
    send('image:event', {
      requestId: request.requestId,
      type: 'status',
      content: `已进入图片队列 · 前方 ${index} 项`
    })
  })
}

async function processImageQueue(): Promise<void> {
  if (imageQueueProcessing) return
  imageQueueProcessing = true
  try {
    while (imageQueue.length) {
      const request = imageQueue.shift()!
      activeImageRequest = request
      updateImageQueuePositions()
      const controller = imageControllers.get(request.requestId)
      if (!controller || controller.signal.aborted) continue
      let enhancedPrompt = ''
      let usage: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      }
      try {
        if (isReadyEnglishImagePrompt(request.prompt)) {
          enhancedPrompt = cleanImagePrompt(request.prompt)
          send('image:event', {
            requestId: request.requestId,
            type: 'status',
            content: '检测到完整英文 Prompt，直接调用图片模型'
          })
        } else {
          if (!request.model.model || !request.model.baseUrl) {
            throw new Error('中文描述需要本地语言模型翻译，请先选择模型')
          }
          send('image:event', {
            requestId: request.requestId,
            type: 'status',
            content: '正在调用本地语言模型整理英文 Prompt'
          })
          await prepareSingleModelRuntime(request.model)
          let promptOutput = ''
          const promptMessages: LlmMessage[] = [
            {
              role: 'system',
              content:
                `/no_think\n你是图片生成 Prompt 转换器，只执行一次转换。禁止分析请求、解释规则、评价内容、自我纠错或输出计划。当前请求默认只直接携带本轮输入，不携带历史聊天原文；历史记录在本机会话历史资料库中。若本轮画面可独立理解，禁止检索历史；若本轮只给出短回复，或明确依赖更早人物、外貌、服装、关系、场景或画风，才调用 search_conversation_history 检索相关片段。继承检索结果中已确定的人物身份、外貌、服装、关系、场景与画面风格，以当前输入为最高优先级。把当前画面要求直接转换成一段完整英文 Prompt，保留主体、动作、构图、镜头、光线、材质、色彩与氛围。正文只能包含英文 Prompt，禁止标题、解释、引号、Markdown 与额外对话。`
            },
            ...request.contextMessages.map((message) => ({
              role: message.role,
              content: message.content,
              images: message.images
            })),
            {
              role: 'user',
              content: `/no_think\n${request.prompt}\n\n${hostTimeContext()}\n\n直接输出英文 Prompt。`
            }
          ]
          const onPromptChunk = (content: string): void => {
            promptOutput += content
            send('image:event', {
              requestId: request.requestId,
              type: 'chunk',
              content
            })
          }
          const onPromptReasoning = (content: string): void =>
            send('image:event', {
              requestId: request.requestId,
              type: 'reasoning',
              content
            })
          const historyTools: ToolDefinition[] = request.historyArchive?.length
            ? [
                {
                  type: 'function',
                  function: {
                    name: 'search_conversation_history',
                    description:
                      '按关键词查询本机会话历史资料库，用于补全更早确定的人物、外貌、服装、关系、场景或画风。',
                    parameters: {
                      type: 'object',
                      required: ['query'],
                      properties: {
                        query: { type: 'string' },
                        max_results: { type: 'number' }
                      }
                    }
                  }
                }
              ]
            : []
          if (historyTools.length) {
            for (let step = 0; step < 3; step += 1) {
              promptOutput = ''
              const completion = await completeWithTools(
                request.model,
                promptMessages,
                historyTools,
                controller.signal,
                'auto',
                onPromptReasoning,
                onPromptChunk
              )
              usage = {
                promptTokens: usage.promptTokens + completion.usage.promptTokens,
                completionTokens: usage.completionTokens + completion.usage.completionTokens,
                totalTokens: usage.totalTokens + completion.usage.totalTokens,
                estimated: Boolean(usage.estimated || completion.usage.estimated)
              }
              if (!completion.toolCalls.length) {
                if (!promptOutput.trim()) promptOutput = completion.content
                break
              }
              promptMessages.push(completion.rawMessage)
              const call = completion.toolCalls[0]
              const result =
                call.name === 'search_conversation_history'
                  ? searchConversationHistoryArchive(
                      request.historyArchive,
                      typeof call.arguments.query === 'string' ? call.arguments.query : request.prompt,
                      Number(call.arguments.max_results) || 4
                    )
                  : `未知工具：${call.name}`
              promptMessages.push({ role: 'tool', content: result, tool_call_id: call.id })
              send('image:event', {
                requestId: request.requestId,
                type: 'status',
                content: '已按需查询更早会话历史'
              })
            }
          } else {
            usage = await streamChat(
              request.model,
              promptMessages,
              onPromptChunk,
              controller.signal,
              onPromptReasoning,
              { disableThinking: true, maxOutputTokens: 1200 }
            )
          }
          enhancedPrompt = cleanImagePrompt(promptOutput)
          if (!enhancedPrompt) {
            enhancedPrompt = cleanImagePrompt(request.prompt)
            send('image:event', {
              requestId: request.requestId,
              type: 'status',
              content: '语言模型未返回正文，已采用原始 Prompt 继续生成'
            })
          }
        }
        send('image:event', {
          requestId: request.requestId,
          type: 'prompt',
          content: isReadyEnglishImagePrompt(request.prompt)
            ? '已直接采用英文 Prompt'
            : '英文 Prompt 已生成',
          enhancedPrompt,
          usage
        })

        send('image:event', {
          requestId: request.requestId,
          type: 'status',
          content: '正在卸载语言模型并切换到图片生成'
        })
        await releaseLanguageModel(request.model)
        const outputDirectory = path.join(app.getPath('userData'), 'generated-images')
        const images = await runComfyWorkflow(
          request.baseUrl,
          request.workflow,
          enhancedPrompt,
          request.steps,
          {
            width: request.width,
            height: request.height,
            aspectRatio: request.aspectRatio,
            megapixels: request.megapixels,
            multiple: request.multiple
          },
          request.checkpoint,
          outputDirectory,
          controller.signal,
          (content) =>
            send('image:event', {
              requestId: request.requestId,
              type: 'progress',
              content
            })
        )
        send('image:event', {
          requestId: request.requestId,
          type: 'done',
          content: `${request.workflow.name} · ${request.checkpoint} · ${request.steps} Steps`,
          enhancedPrompt,
          images,
          usage
        })
      } catch (error) {
        send('image:event', {
          requestId: request.requestId,
          type: 'error',
          content: controller.signal.aborted
            ? '图片任务已停止'
            : error instanceof Error
              ? error.message
              : String(error),
          enhancedPrompt
        })
      } finally {
        imageControllers.delete(request.requestId)
        activeImageRequest = null
      }
    }
  } finally {
    imageQueueProcessing = false
  }
}

function requestAgentApproval(
  approval: AgentApproval,
  signal: AbortSignal
): Promise<boolean> {
  send('agent:event', {
    requestId: approval.requestId,
    type: 'approval',
    title: approval.title,
    toolName: approval.toolName,
    toolArgs: approval.toolArgs,
    changes: approval.changes,
    approval
  })
  return new Promise((resolve) => {
    const key = `${approval.requestId}:${approval.approvalId}`
    const onAbort = (): void => {
      agentApprovalResolvers.delete(key)
      resolve(false)
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    agentApprovalResolvers.set(key, {
      resolve: (approved) => {
        cleanup()
        resolve(approved)
      },
      cleanup
    })
  })
}

function watchWorkspace(root: string): void {
  workspaceWatchers.get(root)?.close()
  workspaceWatchers.delete(root)
  if (!root) return
  try {
    const watcher = watchPath(root, { recursive: true }, () => {
      const currentTimer = workspaceWatchTimers.get(root)
      if (currentTimer) clearTimeout(currentTimer)
      workspaceWatchTimers.set(
        root,
        setTimeout(() => send('workspace:changed', { root }), 250)
      )
    })
    workspaceWatchers.set(root, watcher)
  } catch (error) {
    console.error(`Workspace watch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0d12',
      symbolColor: '#aeb5c2',
      height: 38
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })
  mainWindow.webContents.on('console-message', (details) => {
    console.log(`[renderer:${details.level}] ${details.message}`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`Renderer load failed: ${code} ${description}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Renderer process exited: ${details.reason}`)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL()
    if (!url || url === currentUrl) return
    event.preventDefault()
    void openExternalUrl(url)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('app:openExternal', async (_event, url: string) =>
    openExternalUrl(url)
  )
  ipcMain.handle('credentials:getKimiCodeApiKey', async () =>
    (await readSecureCredentials()).kimiCodeApiKey ?? ''
  )
  ipcMain.handle('credentials:setKimiCodeApiKey', async (_event, apiKey: string) => {
    await saveKimiCodeApiKey(apiKey)
    return true
  })
  ipcMain.handle('workspace:open', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作区'
    })
    if (result.canceled || !result.filePaths[0]) return null
    const root = result.filePaths[0]
    return { root, tree: await buildFileTree(root) }
  })

  ipcMain.handle('workspace:tree', async (_event, root: string) => buildFileTree(root))
  ipcMain.handle('workspace:rename', async (_event, root: string, nextName: string) => {
    workspaceWatchers.get(root)?.close()
    workspaceWatchers.delete(root)
    try {
      const nextRoot = await renameWorkspaceRoot(root, nextName)
      watchWorkspace(nextRoot)
      return { root: nextRoot, tree: await buildFileTree(nextRoot) }
    } catch (error) {
      watchWorkspace(root)
      throw error
    }
  })
  ipcMain.handle('workspace:watch', (_event, root: string) => {
    watchWorkspace(root)
    return true
  })
  ipcMain.handle('workspace:unwatch', (_event, root: string) => {
    workspaceWatchers.get(root)?.close()
    workspaceWatchers.delete(root)
    return true
  })
  ipcMain.handle('files:read', async (_event, root: string, filePath: string) =>
    readTextFile(root, filePath)
  )
  ipcMain.handle(
    'files:write',
    async (
      _event,
      root: string,
      filePath: string,
      content: string,
      metadata?: { source?: 'user'; revision?: number }
    ) => {
      await writeTextFile(root, filePath, content)
      if (
        metadata?.source === 'user' &&
        Number.isSafeInteger(metadata.revision) &&
        Number(metadata.revision) >= 1
      ) {
        markUserFileEditSaved(root, filePath, Number(metadata.revision))
      }
      return true
    }
  )
  ipcMain.handle('files:search', async (_event, root: string, query: string) =>
    searchWorkspace(root, query)
  )
  ipcMain.handle(
    'files:rename',
    async (_event, root: string, filePath: string, nextName: string) =>
      renameWorkspaceEntry(root, filePath, nextName)
  )
  ipcMain.handle('files:delete', async (_event, root: string, filePath: string) => {
    await deleteWorkspaceEntry(root, filePath)
    return true
  })
  ipcMain.handle(
    'files:create',
    async (
      _event,
      root: string,
      parentPath: string,
      name: string,
      kind: 'file' | 'directory'
    ) => createWorkspaceEntry(root, parentPath, name, kind)
  )
  ipcMain.handle('files:duplicate', async (_event, root: string, filePath: string) =>
    duplicateWorkspaceEntry(root, filePath)
  )
  ipcMain.handle('files:reveal', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
    return true
  })
  ipcMain.handle('files:openExternal', async (_event, filePath: string) =>
    shell.openPath(filePath)
  )
  ipcMain.handle('app:openConversationCache', async () => {
    const cacheDir = path.join(app.getPath('userData'), 'Local Storage', 'leveldb')
    await fs.mkdir(cacheDir, { recursive: true })
    const error = await shell.openPath(cacheDir)
    if (error) throw new Error(error)
    return cacheDir
  })
  ipcMain.handle('images:open', async (_event, source: string) => {
    const error = await shell.openPath(generatedImagePath(source))
    if (error) throw new Error(error)
    return true
  })
  ipcMain.handle('images:reveal', (_event, source: string) => {
    shell.showItemInFolder(generatedImagePath(source))
    return true
  })
  ipcMain.handle(
    'images:saveAs',
    async (_event, source: string, suggestedName: string) => {
      const sourcePath = generatedImagePath(source)
      const result = await dialog.showSaveDialog({
        title: '另存生成图片',
        defaultPath: suggestedName || path.basename(sourcePath)
      })
      if (result.canceled || !result.filePath) return false
      await fs.copyFile(sourcePath, result.filePath)
      return true
    }
  )

  ipcMain.handle('model:test', async (_event, model) => testModelConnection(model))
  ipcMain.handle('model:discover', async () => discoverLocalModels())
  ipcMain.handle('model:context', async (_event, model) => inspectModelContext(model))
  ipcMain.handle('skills:import', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 SKILL.md',
      properties: ['openFile'],
      filters: [{ name: 'Skill Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const sourcePath = result.filePaths[0]
    const content = await fs.readFile(sourcePath, 'utf8')
    const nameMatch = content.match(/^name:\s*["']?(.+?)["']?\s*$/m)
    const descriptionMatch = content.match(/^description:\s*["']?(.+?)["']?\s*$/m)
    return {
      sourcePath,
      name: nameMatch?.[1]?.trim() || path.basename(path.dirname(sourcePath)) || '导入的 Skill',
      description: descriptionMatch?.[1]?.trim() || '',
      instructions: content
    }
  })

  ipcMain.handle('comfy:discoverWorkflows', async () => discoverComfyWorkflows())
  ipcMain.handle(
    'comfy:inspect',
    async (_event, baseUrl: string, workflow: ComfyWorkflow) =>
      inspectComfyWorkflow(baseUrl, workflow)
  )
  ipcMain.handle('comfy:free', async (_event, baseUrl: string) => {
    if (activeImageRequest) throw new Error('当前图片仍在生成，请先停止或等待完成')
    await freeComfyMemory(baseUrl)
    return true
  })
  ipcMain.handle('image:start', (_event, request: ImageGenerationRequest) => {
    if (!request.prompt.trim()) throw new Error('图片描述不能为空')
    if (!request.workflow?.id) throw new Error('请先选择 ComfyUI 工作流')
    const controller = new AbortController()
    imageControllers.set(request.requestId, controller)
    imageQueue.push(request)
    updateImageQueuePositions()
    setImmediate(() => void processImageQueue())
    return { queued: true, position: imageQueue.length }
  })
  ipcMain.handle('image:stop', async (_event, requestId: string, baseUrl: string) => {
    const queuedIndex = imageQueue.findIndex((request) => request.requestId === requestId)
    if (queuedIndex >= 0) {
      imageQueue.splice(queuedIndex, 1)
      imageControllers.get(requestId)?.abort()
      imageControllers.delete(requestId)
      send('image:event', {
        requestId,
        type: 'error',
        content: '图片任务已从队列移除'
      })
      updateImageQueuePositions()
      return true
    }
    if (activeImageRequest?.requestId === requestId) {
      imageControllers.get(requestId)?.abort()
      await interruptComfy(baseUrl)
      return true
    }
    return false
  })

  ipcMain.handle('chat:start', async (_event, request: ChatStartRequest) => {
    await prepareSingleModelRuntime(request.model)
    const controller = new AbortController()
    chatControllers.set(request.requestId, controller)
    const messages: LlmMessage[] = []
    if (request.instructions.trim()) {
      messages.push({ role: 'system', content: request.instructions })
    }
    if (request.contextMemory?.trim()) {
      messages.push({
        role: 'system',
        content: `<compressed_context>\n${request.contextMemory.trim()}\n</compressed_context>`
      })
    }
    const latestRequestUserIndex = request.messages.reduce(
      (found, message, index) => (message.role === 'user' ? index : found),
      -1
    )
    messages.push(
      ...request.messages.map((message, index) => {
        if (index === latestRequestUserIndex || message.role === 'system') return message
        return {
          ...message,
          content:
            message.role === 'user'
              ? `<completed_history_input index="${index + 1}" status="completed">\n${message.content}\n</completed_history_input>`
              : `<completed_history_result index="${index + 1}" status="completed">\n${message.content}\n</completed_history_result>`
        }
      })
    )
    const latestUserIndex = messages.reduce(
      (found, message, index) => (message.role === 'user' ? index : found),
      -1
    )
    if (latestUserIndex >= 0) {
      messages.splice(latestUserIndex, 0, {
        role: 'system',
        content:
          '<turn_boundary>此前带 completed 标记的内容全部是已完成记录，只可提取与本轮直接相关的偏好、事实和既有结论。严禁复盘、分析、评价、总结或继续执行旧请求，也禁止为了展示过程延长思考。紧随此边界后的用户消息是唯一任务，只进行最短必要推理并直接回答。</turn_boundary>'
      })
      messages[latestUserIndex + 1] = {
        ...messages[latestUserIndex + 1],
        content: `<current_task>\n${messages[latestUserIndex + 1].content}\n</current_task>`
      }
    }
    if (request.attachments.length) {
      const latestUser = [...messages].reverse().find((message) => message.role === 'user')
      if (latestUser) {
        const textAttachments = request.attachments
          .filter((attachment) => attachment.kind === 'text' && attachment.text)
          .map(
            (attachment) =>
              `\n\n<attachment name="${attachment.name}">\n${attachment.text}\n</attachment>`
          )
          .join('')
        const fileAttachments = request.attachments
          .filter((attachment) => attachment.kind === 'file')
          .map((attachment) => `\n\n附件：${attachment.name}`)
          .join('')
        latestUser.content += textAttachments + fileAttachments
        latestUser.images = request.attachments
          .filter((attachment) => attachment.kind === 'image' && attachment.data)
          .map((attachment) => attachment.data!)
      }
    }
    const chatTask = request.webSearch
      ? runWebChat(
          request.model,
          messages,
          (content) =>
            send('chat:event', { requestId: request.requestId, type: 'chunk', content }),
          controller.signal,
          (event) => send('chat:event', { requestId: request.requestId, ...event }),
          Boolean(request.forceWebSearch),
          request.historyArchive ?? []
        )
      : streamChat(
          request.model,
          messages,
          (content) =>
            send('chat:event', { requestId: request.requestId, type: 'chunk', content }),
          controller.signal,
          (content) =>
            send('chat:event', { requestId: request.requestId, type: 'reasoning', content }),
          {
            onContextCompressed: (contextMemory) =>
              send('chat:event', {
                requestId: request.requestId,
                type: 'context',
                contextMemory
              })
          }
        )
    void chatTask
      .then((usage) =>
        send('chat:event', { requestId: request.requestId, type: 'done', usage })
      )
      .catch((error) => {
        if (controller.signal.aborted) {
          send('chat:event', {
            requestId: request.requestId,
            type: 'done',
            content: '已停止'
          })
        } else {
          send('chat:event', {
            requestId: request.requestId,
            type: 'error',
            content: error instanceof Error ? error.message : String(error)
          })
        }
      })
      .finally(() => chatControllers.delete(request.requestId))
    return true
  })

  ipcMain.handle('chat:stop', (_event, requestId: string) => {
    chatControllers.get(requestId)?.abort()
    return true
  })

  ipcMain.handle('agent:start', async (_event, request: AgentStartRequest) => {
    await prepareSingleModelRuntime(request.model)
    const controller = new AbortController()
    agentControllers.set(request.requestId, controller)
    agentGuidanceQueues.set(request.requestId, [])
    agentUserFileEditStates.set(request.requestId, {
      workspaceRoot: request.workspaceRoot,
      locks: new Map()
    })
    let latestAgentUsage: TokenUsage | undefined
    const latestAgentChanges = new Map<string, AgentChange>()
    void runAgent(
      request,
      controller.signal,
      (payload) => {
        if (payload.usage) latestAgentUsage = payload.usage
        if (payload.changes?.length) {
          for (const change of payload.changes) {
            const existing = latestAgentChanges.get(change.path)
            latestAgentChanges.set(
              change.path,
              existing
                ? {
                    ...change,
                    before: existing.before,
                    beforeExists: existing.beforeExists
                  }
                : change
            )
          }
        }
        if (payload.type === 'done' || payload.type === 'error') {
          send('agent:event', {
            ...payload,
            usage: payload.usage ?? latestAgentUsage,
            changes:
              payload.changes?.length || latestAgentChanges.size === 0
                ? payload.changes
                : [...latestAgentChanges.values()]
          })
          return
        }
        send('agent:event', payload)
      },
      (approval) => requestAgentApproval(approval, controller.signal),
      () => agentGuidanceQueues.get(request.requestId)?.splice(0) ?? [],
      (relative) => {
        const state = agentUserFileEditStates.get(request.requestId)
        const normalized = state ? normalizeWorkspaceFile(state.workspaceRoot, relative) : null
        return normalized && state ? state.locks.get(normalized) : undefined
      },
      (relative, revision) => {
        const state = agentUserFileEditStates.get(request.requestId)
        const normalized = state ? normalizeWorkspaceFile(state.workspaceRoot, relative) : null
        if (!normalized || !state) return
        const lock = state.locks.get(normalized)
        if (lock?.revision === revision) state.locks.delete(normalized)
      }
    )
      .catch((error) => {
        send('agent:event', {
          requestId: request.requestId,
          type: controller.signal.aborted ? 'done' : 'error',
          title: controller.signal.aborted ? '任务已停止' : '任务失败',
          content: error instanceof Error ? error.message : String(error),
          usage: latestAgentUsage,
          changes: [...latestAgentChanges.values()]
        })
      })
      .finally(() => {
        agentControllers.delete(request.requestId)
        agentGuidanceQueues.delete(request.requestId)
        agentUserFileEditStates.delete(request.requestId)
      })
    return true
  })

  ipcMain.handle('agent:guide', (_event, request: AgentGuideRequest) => {
    const queue = agentGuidanceQueues.get(request.requestId)
    if (!queue || !request.content.trim()) return false
    queue.push({
      ...request,
      content: request.content.slice(0, 48000),
      displayContent: request.displayContent.slice(0, 4000),
      attachments: request.attachments.slice(0, 12)
    })
    if (queue.length > 20) queue.shift()
    send('agent:event', {
      requestId: request.requestId,
      type: 'guidance',
      title: '收到运行中引导',
      content: request.displayContent
    })
    return true
  })

  ipcMain.on(
    'agent:userFileEdit',
    (
      _event,
      root: string,
      filePath: string,
      revision: number,
      startLine: number,
      endLine: number
    ) => recordUserFileEdit(root, filePath, revision, startLine, endLine)
  )

  ipcMain.handle('agent:stop', (_event, requestId: string) => {
    agentControllers.get(requestId)?.abort()
    return true
  })
  ipcMain.handle(
    'agent:approve',
    (_event, requestId: string, approvalId: string, approved: boolean) => {
      const key = `${requestId}:${approvalId}`
      const pending = agentApprovalResolvers.get(key)
      if (!pending) return false
      agentApprovalResolvers.delete(key)
      pending.resolve(approved)
      return true
    }
  )

  ipcMain.handle('command:run', async (_event, request: CommandRequest) => {
    const child = spawn(request.command, {
      cwd: request.cwd,
      shell: true,
      windowsHide: true,
      env: process.env
    })
    commandProcesses.set(request.id, child)
    child.stdout?.on('data', (chunk) =>
      send('command:event', {
        id: request.id,
        type: 'stdout',
        content: chunk.toString()
      })
    )
    child.stderr?.on('data', (chunk) =>
      send('command:event', {
        id: request.id,
        type: 'stderr',
        content: chunk.toString()
      })
    )
    child.on('error', (error) =>
      send('command:event', { id: request.id, type: 'error', content: error.message })
    )
    child.on('close', (code) => {
      commandProcesses.delete(request.id)
      send('command:event', {
        id: request.id,
        type: 'exit',
        content: `\n进程结束，退出码 ${code ?? -1}\n`
      })
    })
    return true
  })

  ipcMain.handle('command:stop', (_event, id: string) => {
    commandProcesses.get(id)?.kill()
    return true
  })

  ipcMain.handle('code:run', async (_event, request: CodeRunRequest): Promise<CodeRunResult> => {
    const language = request.language.toLocaleLowerCase()
    const runners: Record<string, { command: string; args: string[]; suffix?: string }> = {
      javascript: { command: 'node', args: ['-'] },
      js: { command: 'node', args: ['-'] },
      node: { command: 'node', args: ['-'] },
      python: { command: 'python', args: ['-'] },
      py: { command: 'python', args: ['-'] },
      powershell: {
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']
      },
      ps1: {
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']
      },
      shell: { command: 'cmd.exe', args: ['/D', '/Q'], suffix: '\r\nexit\r\n' },
      cmd: { command: 'cmd.exe', args: ['/D', '/Q'], suffix: '\r\nexit\r\n' },
      bat: { command: 'cmd.exe', args: ['/D', '/Q'], suffix: '\r\nexit\r\n' },
      bash: { command: 'bash', args: ['-s'] },
      sh: { command: 'bash', args: ['-s'] }
    }
    const runner = runners[language]
    if (!runner) throw new Error(`暂不支持直接运行 ${request.language || '未知'} 代码`)
    if (request.code.length > 200000) throw new Error('代码块超过 200000 字符，已拒绝运行')

    return new Promise((resolve) => {
      const child = spawn(runner.command, runner.args, {
        cwd: request.cwd || os.homedir(),
        windowsHide: true,
        stdio: 'pipe',
        env: process.env
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const finish = (exitCode: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          stdout: stdout.slice(0, 2 * 1024 * 1024),
          stderr: stderr.slice(0, 2 * 1024 * 1024),
          exitCode,
          timedOut
        })
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, 20000)
      child.stdout.on('data', (chunk) => {
        if (stdout.length < 2 * 1024 * 1024) stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 2 * 1024 * 1024) stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        stderr += error.message
        finish(-1)
      })
      child.on('close', (code) => finish(code ?? -1))
      child.stdin.end(`${request.code}${runner.suffix ?? ''}`)
    })
  })

  ipcMain.handle('terminal:create', (_event, request: TerminalCreateRequest) => {
    terminalProcesses.get(request.id)?.kill()
    const terminal =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/Q', '/K', 'chcp 65001>nul'], {
            cwd: request.cwd || os.homedir(),
            windowsHide: true,
            stdio: 'pipe',
            env: process.env
          })
        : spawn(process.env.SHELL || '/bin/bash', ['-i'], {
            cwd: request.cwd || os.homedir(),
            stdio: 'pipe',
            env: process.env
          })
    terminalProcesses.set(request.id, terminal)
    terminal.stdout.on('data', (chunk) =>
      send('terminal:event', {
        id: request.id,
        type: 'data',
        data: chunk.toString('utf8')
      })
    )
    terminal.stderr.on('data', (chunk) =>
      send('terminal:event', {
        id: request.id,
        type: 'data',
        data: chunk.toString('utf8')
      })
    )
    terminal.on('close', (exitCode) => {
      terminalProcesses.delete(request.id)
      send('terminal:event', {
        id: request.id,
        type: 'exit',
        data: `\r\n[终端已退出：${exitCode ?? -1}]\r\n`
      })
    })
    terminal.on('error', (error) => {
      send('terminal:event', {
        id: request.id,
        type: 'data',
        data: `\r\n[终端启动失败：${error.message}]\r\n`
      })
    })
    return true
  })

  ipcMain.handle('terminal:write', (_event, id: string, data: string) => {
    terminalProcesses.get(id)?.stdin.write(data)
    return true
  })

  ipcMain.handle('terminal:resize', () => true)

  ipcMain.handle('terminal:close', (_event, id: string) => {
    terminalProcesses.get(id)?.kill()
    terminalProcesses.delete(id)
    return true
  })

}

app.setName('星伴 AI')
if (process.platform === 'win32') app.setAppUserModelId('com.local.agent.studio')

app.whenReady().then(() => {
  protocol.handle('local-file', (request) => {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.slice(1)
    return net.fetch(pathToFileURL(filePath).toString())
  })
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  chatControllers.forEach((controller) => controller.abort())
  agentControllers.forEach((controller) => controller.abort())
  imageControllers.forEach((controller) => controller.abort())
  agentApprovalResolvers.forEach((pending) => {
    pending.cleanup()
    pending.resolve(false)
  })
  agentApprovalResolvers.clear()
  commandProcesses.forEach((child) => child.kill())
  terminalProcesses.forEach((terminal) => terminal.kill())
  workspaceWatchers.forEach((watcher) => watcher.close())
})
