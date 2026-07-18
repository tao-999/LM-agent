import { exec } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow, session, type Session } from 'electron'
import type {
  AgentApproval,
  AgentChange,
  AgentEvent,
  AgentGuideRequest,
  AgentStartRequest,
  AgentTask,
  ChatContextMessage,
  ChatEvent,
  ContextCompressionMemory,
  TokenUsage
} from '../shared/types'
import {
  buildFileTree,
  copyWorkspaceEntry,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  moveWorkspaceEntry,
  readTextFile,
  resolveInWorkspace,
  resolveSecurelyInWorkspace,
  searchWorkspace,
  workspaceEntryInfo,
  writeTextFile
} from './files'
import {
  addUsage,
  completeWithTools,
  type LlmMessage,
  type ToolDefinition
} from './models'

const execAsync = promisify(exec)

type EventSender = (event: AgentEvent) => void

function applyCompressionMemory(
  messages: LlmMessage[],
  memory?: ContextCompressionMemory
): void {
  if (!memory?.summary.trim()) return
  const indexedNonSystem = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role !== 'system')
  const explicitIndexes = memory.compressedNonSystemIndexes ?? []
  if (!explicitIndexes.length && memory.compressedMessageCount <= 0) return
  const explicitIndexSet = new Set(explicitIndexes)
  const latestUserIndex = messages.reduce(
    (found, message, index) => (message.role === 'user' ? index : found),
    -1
  )
  if (latestUserIndex < 0) return
  const historyIndexes = explicitIndexes.length
    ? indexedNonSystem
        .filter((_, nonSystemIndex) => explicitIndexSet.has(nonSystemIndex))
        .map(({ index }) => index)
    : indexedNonSystem
        .filter(({ index }) => index < latestUserIndex)
        .slice(0, memory.compressedMessageCount)
        .map(({ index }) => index)
  const removed = new Set(historyIndexes)
  const retained = messages.filter(
    (message, index) =>
      !removed.has(index) &&
      !(
        message.role === 'system' &&
        message.content.trimStart().startsWith('<compressed_context>')
      )
  )
  const firstNonSystem = retained.findIndex((message) => message.role !== 'system')
  const insertIndex = firstNonSystem < 0 ? retained.length : firstNonSystem
  retained.splice(insertIndex, 0, {
    role: 'system',
    content: `<compressed_context>\n${memory.summary.trim()}\n</compressed_context>`
  })
  messages.splice(0, messages.length, ...retained)
}
type ApprovalRequester = (approval: AgentApproval) => Promise<boolean>

export type AgentUserFileEditLock = {
  path: string
  revision: number
  startLine: number
  endLine: number
  saved: boolean
  changedAt: number
}

type RegisteredTool = {
  definition: ToolDefinition
  risk: 'read' | 'write' | 'create' | 'delete' | 'command'
  preview?: (args: Record<string, unknown>) => Promise<AgentChange[]>
  execute: (args: Record<string, unknown>, preview?: AgentChange[]) => Promise<string>
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

type LineRange = {
  path: string
  startLine: number
  endLine: number
}

function selectedCodeLineRanges(value: string): LineRange[] {
  const ranges: LineRange[] = []
  for (const match of value.matchAll(/<selected_code\b([^>]*)>/gi)) {
    const attributes = match[1]
    const pathValue = attributes.match(/\bpath\s*=\s*(["'])(.*?)\1/i)?.[2]?.trim() ?? ''
    const lineValue = attributes.match(/\blines\s*=\s*(["'])(\d+)\s*-\s*(\d+)\1/i)
    const startLine = Number(lineValue?.[2])
    const endLine = Number(lineValue?.[3])
    if (
      pathValue &&
      Number.isSafeInteger(startLine) &&
      Number.isSafeInteger(endLine) &&
      startLine >= 1 &&
      endLine >= startLine
    ) {
      ranges.push({ path: pathValue, startLine, endLine })
    }
  }
  return ranges
}

function stringifyResult(value: unknown): string {
  const output = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return output.length > 24000 ? `${output.slice(0, 24000)}\n\n[结果已截断]` : output
}

function assertCommandWithinWorkspace(command: string): void {
  const violations = [
    /(?:^|[\s"'=])(?:[a-z]:[\\/]|\\\\)/i,
    /(?:^|[\\/])\.\.(?:[\\/]|$)/,
    /(?:^|[;&|]\s*)(?:cd|chdir|pushd|popd|set-location)\b/i,
    /(?:^|[\s"'=])~[\\/]/,
    /%(?:userprofile|home|appdata|localappdata|temp|tmp)%/i,
    /\$(?:env:)?(?:userprofile|home|appdata|localappdata|temp|tmp)\b/i
  ]
  if (violations.some((pattern) => pattern.test(command))) {
    throw new Error('命令包含可能越出当前 CWD 的路径或目录切换，已拒绝执行')
  }
}

function stripHistoryTags(value: string): string {
  return value
    .replace(/<message_attachments>[\s\S]*?<\/message_attachments>/gi, '')
    .replace(/<selected_code\b[\s\S]*?<\/selected_code>/gi, '')
    .replace(/<current_file\b[\s\S]*?<\/current_file>/gi, '')
    .replace(/<file_reference\b[\s\S]*?<\/file_reference>/gi, '')
    .replace(/<file\b[\s\S]*?<\/file>/gi, '')
    .trim()
}

function historySearchTerms(query: string): string[] {
  const terms = query
    .toLocaleLowerCase()
    .split(/[\s,，。、“”"'：:；;！？!?（）()【】[\]\n\r]+/)
    .map((term) => term.trim())
    .filter(
      (term) =>
        term.length >= 2 &&
        !/^(?:帮我|请你|查询|查找|搜索|历史|记录|上文|之前|刚才|这个|这些|继续|根据|需要|内容|消息|资料|一下|什么|怎么|如何)$/.test(
          term
        )
    )
  const pairs = terms.flatMap((term) =>
    /^[\u3400-\u9fff]{4,}$/.test(term)
      ? Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))
      : []
  )
  return [...new Set([...terms, ...pairs])].slice(0, 24)
}

export function searchConversationHistoryArchive(
  archive: ChatContextMessage[] | undefined,
  queryValue: string,
  limitValue = 6
): string {
  const archiveMessages = archive ?? []
  if (!archiveMessages.length) return '会话历史资料库为空。'
  const query = queryValue.trim()
  const terms = historySearchTerms(query)
  const limit = Math.max(1, Math.min(12, limitValue || 6))
  const scored = archiveMessages.map((message, index) => {
    const content = stripHistoryTags(message.content)
    const lower = content.toLocaleLowerCase()
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0)
    return { index, message, content, score }
  })
  const pool = scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
  const selected = (pool.length ? pool : scored.slice(-limit)).slice(0, limit)
  return [
    `<conversation_history_results query="${query.replace(/"/g, '&quot;')}" total="${archiveMessages.length}" returned="${selected.length}">`,
    '说明：以下内容来自本机会话历史资料库，只可在与当前任务直接相关时引用，禁止重新执行已完成任务。',
    ...selected.map((item) => {
      const role = item.message.role === 'user' ? '用户' : 'AI'
      const snippet =
        item.content.length > 3000 ? `${item.content.slice(0, 3000)}\n[单条历史已截断]` : item.content
      return `\n===== 历史 ${item.index + 1} · ${role} · 匹配 ${item.score} =====\n${snippet}`
    }),
    '</conversation_history_results>'
  ].join('\n\n')
}

function describeToolCall(
  name: string,
  args: Record<string, unknown>
): { title: string; detail: string } {
  const pathValue = text(args.path) || text(args.source)
  const descriptions: Record<string, { title: string; detail: string }> = {
    list_files: {
      title: `list_files · ${pathValue || '工作区根目录'}`,
      detail: `正在列出 ${pathValue || '工作区根目录'} 的文件结构`
    },
    read_file: {
      title: `read_file · ${pathValue || '未指定文件'}`,
      detail: `正在读取 ${pathValue}${
        args.around_line
          ? ` 第 ${String(args.around_line)} 行上下各 ${String(args.context_lines || 50)} 行`
          : args.start_line
          ? ` 第 ${String(args.start_line)}-${String(args.end_line || '末尾')} 行`
          : ''
      }`
    },
    search_files: {
      title: `search_files · ${pathValue || '全部工作区'} · ${text(args.query) || '未指定关键词'}`,
      detail: `正在${pathValue ? `限定 ${pathValue}` : '全局'}搜索“${text(args.query)}”`
    },
    search_conversation_history: {
      title: `search_conversation_history · ${text(args.query) || '未指定关键词'}`,
      detail: `正在查询本机会话历史“${text(args.query)}”`
    },
    search_web: {
      title: `search_web · ${text(args.query) || '未指定关键词'}`,
      detail: `正在搜索“${text(args.query)}”`
    },
    fetch_webpage: {
      title: `fetch_webpage · ${text(args.url) || '未指定网址'}`,
      detail: `正在访问 ${text(args.url)}`
    },
    create_file: {
      title: `create_file · ${pathValue || '未指定文件'}`,
      detail: ''
    },
    create_directory: {
      title: `create_directory · ${pathValue || '未指定目录'}`,
      detail: ''
    },
    delete_path: {
      title: `delete_path · ${pathValue || '未指定路径'}`,
      detail: ''
    },
    move_path: {
      title: `move_path · ${text(args.source) || '未指定来源'} → ${text(args.target) || '未指定目标'}`,
      detail: ''
    },
    copy_path: {
      title: `copy_path · ${text(args.source) || '未指定来源'} → ${text(args.target) || '未指定目标'}`,
      detail: ''
    },
    file_info: {
      title: `file_info · ${pathValue || '未指定文件'}`,
      detail: `正在检查 ${pathValue}`
    },
    normalize_chinese_quotes: {
      title: `normalize_chinese_quotes · ${pathValue || '未指定文件'}`,
      detail: `正在把 ${pathValue} 中的英文单双引号确定性转换为中文引号`
    },
    replace_in_file: {
      title: `replace_in_file · ${pathValue || '未指定文件'}${
        args.__match_start_line
          ? `:${String(args.__match_start_line)}-${String(args.__match_end_line)}`
          : ''
      }`,
      detail: ''
    },
    replace_lines: {
      title: `replace_lines · ${pathValue || '未指定文件'}:${String(args.start_line || '?')}-${String(args.end_line || '?')}`,
      detail: ''
    },
    insert_lines: {
      title: `insert_lines · ${pathValue || '未指定文件'}:${String(args.line || '?')}`,
      detail: ''
    },
    run_command: {
      title: `run_command · ${text(args.command).slice(0, 90) || '未指定命令'}`,
      detail: text(args.command).slice(0, 500)
    },
    update_tasks: {
      title: `update_tasks · ${Array.isArray(args.tasks) ? args.tasks.length : 0} 项`,
      detail: `正在同步 ${Array.isArray(args.tasks) ? args.tasks.length : 0} 项任务的状态`
    }
  }
  return (
    descriptions[name] ?? {
      title: `执行 ${name}`,
      detail: JSON.stringify(args).slice(0, 500)
    }
  )
}

function validateToolCallArguments(name: string, args: Record<string, unknown>): string | null {
  if (
    Object.keys(args).length === 1 &&
    typeof args.value === 'string' &&
    args.value.trim().length > 0
  ) {
    return `工具参数不是合法 JSON。模型原始参数：${args.value.trim().slice(0, 800)}`
  }
  const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(args, key)
  const hasText = (key: string): boolean => text(args[key]).trim().length > 0
  const hasNumber = (key: string): boolean => Number.isFinite(Number(args[key]))
  const missing: string[] = []
  const requireText = (key: string): void => {
    if (!hasText(key)) missing.push(key)
  }
  const requireNumber = (key: string): void => {
    if (!hasNumber(key)) missing.push(key)
  }
  const requirePresent = (key: string): void => {
    if (!hasOwn(key)) missing.push(key)
  }

  switch (name) {
    case 'read_file':
    case 'create_directory':
    case 'delete_path':
    case 'file_info':
    case 'normalize_chinese_quotes':
      requireText('path')
      break
    case 'create_file':
      requireText('path')
      requirePresent('content')
      break
    case 'replace_in_file':
      requireText('path')
      requireText('search')
      requirePresent('replacement')
      break
    case 'replace_lines':
      requireText('path')
      requirePresent('content')
      if (!Number.isSafeInteger(Number(args.start_line)) || Number(args.start_line) < 1) {
        return `replace_lines 参数错误：start_line 必须是大于等于 1 的安全整数，实际收到 ${String(args.start_line)}`
      }
      if (!Number.isSafeInteger(Number(args.end_line)) || Number(args.end_line) < 1) {
        return `replace_lines 参数错误：end_line 必须是大于等于 1 的安全整数，实际收到 ${String(args.end_line)}`
      }
      if (Number(args.end_line) < Number(args.start_line)) {
        return `replace_lines 参数错误：end_line=${String(args.end_line)} 小于 start_line=${String(args.start_line)}`
      }
      break
    case 'insert_lines':
      requireText('path')
      requireNumber('line')
      requireText('position')
      requirePresent('content')
      break
    case 'move_path':
    case 'copy_path':
      requireText('source')
      requireText('target')
      break
    case 'search_files':
    case 'search_conversation_history':
    case 'search_web':
      requireText('query')
      break
    case 'fetch_webpage':
      requireText('url')
      break
    case 'run_command':
      requireText('command')
      break
    case 'update_tasks':
      if (!Array.isArray(args.tasks)) missing.push('tasks')
      break
  }

  if (!missing.length) return null
  return `工具调用参数缺失或类型错误：${missing.join('、')}。请先读取必要上下文，再用完整参数重新调用 ${name}。`
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  }
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => entities[name.toLowerCase()] ?? match)
}

function stripHtmlNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|canvas|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|aside|form|button|select|header|footer)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
}

function htmlToText(html: string): string {
  return decodeHtml(
    stripHtmlNoise(html)
      .replace(/<\/(p|div|article|section|main|header|footer|h[1-6]|li|tr|pre|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeCharset(value?: string | null): string | null {
  if (!value) return null
  const charset = value.trim().replace(/^["']|["']$/g, '').toLocaleLowerCase()
  if (!charset) return null
  if (/^(?:gb2312|gb_2312|gbk|gb18030)$/i.test(charset)) return 'gb18030'
  if (/^(?:utf8|utf-8)$/i.test(charset)) return 'utf-8'
  return charset
}

function decodeBytes(bytes: Uint8Array, declaredCharset?: string | null): string {
  const preview = new TextDecoder('utf-8').decode(bytes.slice(0, 8192))
  const metaCharset =
    preview.match(/<meta[^>]+charset\s*=\s*["']?([^"'\s/>]+)/i)?.[1] ??
    preview.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^"';\s]+)/i)?.[1]
  const candidates = [
    normalizeCharset(declaredCharset),
    normalizeCharset(metaCharset),
    'utf-8',
    'gb18030',
    'windows-1252'
  ].filter((item, index, all): item is string => Boolean(item) && all.indexOf(item) === index)
  let best = ''
  let bestBadness = Number.POSITIVE_INFINITY
  for (const charset of candidates) {
    try {
      const decoded = new TextDecoder(charset).decode(bytes)
      const badness = (decoded.match(/\uFFFD/g) ?? []).length
      if (badness < bestBadness) {
        best = decoded
        bestBadness = badness
      }
      if (badness === 0) return decoded
    } catch {
      // Ignore unsupported charset and try fallback.
    }
  }
  return best || new TextDecoder().decode(bytes)
}

async function readResponseText(response: Response, maxBytes = 2 * 1024 * 1024): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const declaredCharset = response.headers
    .get('content-type')
    ?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]
  const chunks: Uint8Array[] = []
  let received = 0
  let finished = false
  while (received < maxBytes) {
    const { value, done } = await reader.read()
    if (done) {
      finished = true
      break
    }
    const remaining = maxBytes - received
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value
    chunks.push(chunk)
    received += chunk.byteLength
  }
  if (!finished) void reader.cancel().catch(() => undefined)
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return decodeBytes(bytes, declaredCharset)
}

function assertPublicWebUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 HTTP 与 HTTPS 网页')
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const privateHost =
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  if (privateHost) throw new Error('网页工具禁止访问本机或局域网地址')
  return url
}

let systemWebSessionPromise: Promise<Session> | null = null
let lastResolvedWebProxy = '尚未解析系统代理'

function describeProxyRoute(route: string): string {
  const normalized = route.trim()
  if (!normalized || normalized === 'DIRECT') return '系统直连'
  return normalized
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .join(' → ')
}

async function systemWebSession(): Promise<Session> {
  if (!systemWebSessionPromise) {
    systemWebSessionPromise = (async () => {
      const webSession = session.defaultSession
      await webSession.setProxy({ mode: 'system' })
      return webSession
    })().catch((error) => {
      systemWebSessionPromise = null
      throw error
    })
  }
  return systemWebSessionPromise
}

async function fetchPublicPage(value: string, signal: AbortSignal): Promise<Response> {
  let current = assertPublicWebUrl(value)
  const webSession = await systemWebSession()
  for (let redirect = 0; redirect < 6; redirect += 1) {
    const route = await webSession.resolveProxy(current.toString()).catch(() => 'UNKNOWN')
    lastResolvedWebProxy = describeProxyRoute(route)
    let response: Response
    try {
      response = await webSession.fetch(current.toString(), {
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.7',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6'
        }
      })
    } catch (error) {
      throw new Error(`${errorMessage(error)}；网络通道：${lastResolvedWebProxy}`)
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    current = assertPublicWebUrl(new URL(location, current).toString())
  }
  throw new Error('网页重定向次数过多')
}

type WebSearchMode = 'auto' | 'general' | 'site' | 'encyclopedia' | 'community' | 'news'

type WebSearchResult = {
  title: string
  url: string
  snippet: string
  sourceRank?: number
}

type WebSearchEndpoint = {
  label: string
  url: string
  parse: (value: string, limit: number) => WebSearchResult[]
}

type WebSearchProbe =
  | {
      ok: true
      label: string
      url: string
      status: number
      durationMs: number
      count: number
      results: WebSearchResult[]
    }
  | {
      ok: false
      label: string
      url: string
      durationMs: number
      error: string
    }

type WebFetchProbe =
  | {
      ok: true
      item: WebSearchResult
      content: string
    }
  | {
      ok: false
      item: WebSearchResult
      error: string
    }

const webSearchCache = new Map<string, { expiresAt: number; value: string }>()
const webPageCache = new Map<string, { expiresAt: number; value: string }>()

function cachedWebValue(
  cache: Map<string, { expiresAt: number; value: string }>,
  key: string
): string | null {
  const cached = cache.get(key)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  return cached.value
}

function storeWebValue(
  cache: Map<string, { expiresAt: number; value: string }>,
  key: string,
  value: string,
  ttlMs: number,
  maxEntries: number
): void {
  cache.set(key, { expiresAt: Date.now() + ttlMs, value })
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== 'string') break
    cache.delete(oldest)
  }
}
function normalizeSearchUrl(rawValue: string): string {
  try {
    const url = new URL(decodeHtml(rawValue), 'https://www.bing.com')
    const duckTarget = url.hostname.endsWith('duckduckgo.com')
      ? url.searchParams.get('uddg')
      : null
    if (duckTarget) return duckTarget
    const googleTarget =
      url.hostname.endsWith('google.com') && url.pathname === '/url'
        ? url.searchParams.get('q') || url.searchParams.get('url')
        : null
    if (googleTarget) return googleTarget
    if (url.hostname.endsWith('bing.com') && url.pathname.startsWith('/ck/a')) {
      const encoded = url.searchParams.get('u')
      if (encoded?.startsWith('a1')) {
        return Buffer.from(encoded.slice(2), 'base64url').toString('utf8')
      }
    }
    return url.toString()
  } catch {
    return decodeHtml(rawValue)
  }
}

function parseBingResults(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const blocks = html.match(/<li[^>]*class=(?:"[^"]*\bb_algo\b[^"]*"|'[^']*\bb_algo\b[^']*')[^>]*>[\s\S]*?<\/li>/gi)
  const fallbackBlocks = [...html.matchAll(/<h2[^>]*>[\s\S]*?<a[^>]+href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/gi)].map(
    (match) => `<a href="${match[1] ?? match[2] ?? ''}">${match[3]}</a>`
  )
  for (const block of blocks?.length ? blocks : fallbackBlocks) {
    const link =
      block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/<a[^>]+href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/i)
    if (!link) continue
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    results.push({
      title: htmlToText(link[3]),
      url: normalizeSearchUrl(link[1] ?? link[2]),
      snippet: snippet ? htmlToText(snippet[1]) : ''
    })
    if (results.length >= limit) break
  }
  return results
}

function parseDuckResults(html: string, limit: number): WebSearchResult[] {
  const links = [
    ...html.matchAll(
      /<a[^>]*class=(?:"[^"]*result__a[^"]*"|'[^']*result__a[^']*')[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi
    )
  ]
  const snippets = [
    ...html.matchAll(/<(?:a|div)[^>]*class=(?:"[^"]*result__snippet[^"]*"|'[^']*result__snippet[^']*')[^>]*>([\s\S]*?)<\//gi)
  ]
  return links.slice(0, limit).map((link, index) => {
    const rawUrl = decodeHtml(link[1] ?? link[2] ?? '')
    return {
      title: htmlToText(link[3]),
      url: normalizeSearchUrl(rawUrl),
      snippet: snippets[index] ? htmlToText(snippets[index][1]) : ''
    }
  })
}

function parseBingRssResults(xml: string, limit: number): WebSearchResult[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, limit)
    .flatMap((match) => {
      const item = match[1]
      const title = htmlToText(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '')
      const url = decodeHtml(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '').trim()
      const snippet = htmlToText(
        item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? ''
      )
      return title && url ? [{ title, url, snippet }] : []
    })
}

function parseWikipediaSearchResults(
  json: string,
  limit: number,
  origin: string
): WebSearchResult[] {
  try {
    const data = JSON.parse(json) as {
      query?: { search?: Array<{ title?: string; snippet?: string }> }
    }
    return (data.query?.search ?? []).slice(0, limit).flatMap((item) =>
      item.title
        ? [{
            title: item.title,
            url: `${origin}/wiki/${encodeURIComponent(item.title.replace(/\s+/g, '_'))}`,
            snippet: htmlToText(item.snippet ?? '')
          }]
        : []
    )
  } catch {
    return []
  }
}

function searchQueryTerms(query: string): string[] {
  const normalized = query.toLocaleLowerCase()
  const quoted = [...normalized.matchAll(/["“”']([^"“”']{2,})["“”']/g)].map((match) =>
    match[1].trim()
  )
  const words = normalized
    .replace(/\b(?:site|filetype):[^\s]+/gi, ' ')
    .split(/[\s,，。、“”"'：:；;！？!?（）()【】[\]<>|]+/)
    .map((term) => term.trim())
    .filter(
      (term) =>
        term.length >= 2 &&
        !/^(?:搜索|查询|查找|资料|网页|最新|新闻|内容|信息|结果|site|or|and|http|https|www|com|cn|org|net)$/.test(
          term
        )
    )
  return [...new Set([...quoted, ...words])].slice(0, 16)
}

function canonicalWebUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|spm$|from$|ref$|source$|share_|campaign$)/i.test(key)) {
        url.searchParams.delete(key)
      }
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return value.replace(/#.*$/, '')
  }
}

function sourceModeScore(urlValue: string, mode: WebSearchMode): number {
  const kind = webSourceKind(urlValue)
  if (mode === 'encyclopedia') return kind === '百科' ? 16 : -4
  if (mode === 'community') return kind === '社区讨论' ? 16 : -4
  if (mode === 'news') {
    try {
      const hostname = new URL(urlValue).hostname.toLocaleLowerCase()
      return /(?:news|reuters|apnews|bbc|cnn|xinhuanet|people|cctv)/.test(hostname) ? 10 : 0
    } catch {
      return 0
    }
  }
  return kind === '机构来源' ? 6 : kind === '百科' ? 3 : 0
}

function rankSearchResults(
  query: string,
  results: WebSearchResult[],
  limit: number,
  mode: WebSearchMode = 'general'
): WebSearchResult[] {
  const terms = searchQueryTerms(query)
  const scored = results.flatMap((result, index) => {
    const normalizedUrl = canonicalWebUrl(result.url)
    if (!/^https?:\/\//i.test(normalizedUrl)) return []
    let hostname = ''
    try {
      hostname = new URL(normalizedUrl).hostname.toLocaleLowerCase()
    } catch {
      return []
    }
    if (
      hostname.endsWith('bing.com') ||
      hostname.endsWith('duckduckgo.com') ||
      hostname.endsWith('google.com')
    ) {
      return []
    }
    const title = result.title.toLocaleLowerCase()
    const snippet = result.snippet.toLocaleLowerCase()
    const matchedTerms = terms.filter((term) => title.includes(term) || snippet.includes(term))
    const coverage = terms.length ? matchedTerms.length / terms.length : 1
    const exactTitle = terms.reduce((sum, term) => sum + (title.includes(term) ? 8 : 0), 0)
    const snippetScore = terms.reduce((sum, term) => sum + (snippet.includes(term) ? 3 : 0), 0)
    const exactQueryScore = title.includes(query.toLocaleLowerCase().trim()) ? 18 : 0
    const rankBonus = Math.max(0, 6 - (result.sourceRank ?? index) * 0.35)
    const spamPenalty = /(?:免费下载|破解版|无限金币|点击进入|全网最全|合集下载)/.test(
      `${title}\n${snippet}`
    )
      ? 12
      : 0
    const score =
      exactTitle +
      snippetScore +
      exactQueryScore +
      coverage * 24 +
      rankBonus +
      sourceModeScore(normalizedUrl, mode) -
      spamPenalty
    if (terms.length >= 3 && coverage < 0.25 && exactTitle === 0) return []
    return [{ ...result, url: normalizedUrl, score }]
  })
  const seenUrls = new Set<string>()
  const seenTitles = new Set<string>()
  const domainCounts = new Map<string, number>()
  return scored
    .sort((left, right) => right.score - left.score)
    .filter((result) => {
      const titleKey = result.title.toLocaleLowerCase().replace(/\s+/g, '').slice(0, 120)
      if (seenUrls.has(result.url) || (titleKey && seenTitles.has(titleKey))) return false
      const hostname = new URL(result.url).hostname.toLocaleLowerCase()
      const count = domainCounts.get(hostname) ?? 0
      if (count >= 2) return false
      seenUrls.add(result.url)
      if (titleKey) seenTitles.add(titleKey)
      domainCounts.set(hostname, count + 1)
      return true
    })
    .slice(0, limit)
    .map(({ score: _score, ...result }) => result)
}

function webContentMatchesQuery(query: string, content: string): boolean {
  const terms = searchQueryTerms(query)
  if (!terms.length) return true
  const haystack = content.toLocaleLowerCase()
  const matched = terms.filter((term) => haystack.includes(term)).length
  const required = terms.length <= 2 ? 1 : Math.max(2, Math.ceil(terms.length * 0.3))
  return matched >= required
}

function selectRelevantWebContent(content: string, query: string, maxChars = 5200): string {
  const marker = '\n\n正文：\n'
  const markerIndex = content.indexOf(marker)
  if (markerIndex < 0 || content.length <= maxChars) return content.slice(0, maxChars)
  const header = content.slice(0, markerIndex)
  const body = content.slice(markerIndex + marker.length)
  const terms = searchQueryTerms(query)
  const paragraphs = body
    .split(/\n{2,}/)
    .map((value, index) => ({ value: value.trim(), index }))
    .filter((item) => item.value.length >= 40)
  const scored = paragraphs
    .map((item) => {
      const normalized = item.value.toLocaleLowerCase()
      const matched = terms.filter((term) => normalized.includes(term)).length
      const headingBonus = /^(?:#{1,6}\s|第.{1,16}[章节]|\d+[.、])/u.test(item.value) ? 2 : 0
      return { ...item, score: matched * 8 + headingBonus }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .sort((left, right) => left.index - right.index)
  const selected = scored.length ? scored.map((item) => item.value) : paragraphs.slice(0, 5).map((item) => item.value)
  const bodyLimit = Math.max(1000, maxChars - header.length - marker.length)
  const focused = selected.join('\n\n').slice(0, bodyLimit)
  return `${header}${marker}${focused}${focused.length >= bodyLimit ? '\n\n[相关段落已截断]' : ''}`
}

function webSourceKind(value: string): string {
  try {
    const hostname = new URL(value).hostname.toLocaleLowerCase()
    if (
      hostname.includes('baike.baidu.com') ||
      hostname.includes('wikipedia.org') ||
      hostname.includes('britannica.com')
    ) {
      return '百科'
    }
    if (
      hostname.includes('reddit.com') ||
      hostname.includes('zhihu.com') ||
      hostname.includes('quora.com')
    ) {
      return '社区讨论'
    }
    if (
      hostname.includes('gov.') ||
      hostname.endsWith('.gov') ||
      hostname.includes('edu.') ||
      hostname.endsWith('.edu')
    ) {
      return '机构来源'
    }
    return '独立网页'
  } catch {
    return '网页'
  }
}

function htmlAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
}

function extractMetaDescription(html: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = htmlAttribute(tag, 'name').toLocaleLowerCase()
    const property = htmlAttribute(tag, 'property').toLocaleLowerCase()
    if (
      ['description', 'og:description', 'twitter:description'].includes(name) ||
      ['description', 'og:description', 'twitter:description'].includes(property)
    ) {
      const content = htmlAttribute(tag, 'content')
      if (content) return content
    }
  }
  return ''
}

function htmlDocumentToText(html: string): string {
  const cleaned = stripHtmlNoise(html)
  const candidates: string[] = []
  for (const pattern of [
    /<(article|main)[^>]*>[\s\S]*?<\/\1>/gi,
    /<section[^>]*(?:id|class)\s*=\s*["'][^"']*(?:content|article|post|entry|lemma|markdown|body|main|wiki)[^"']*["'][^>]*>[\s\S]*?<\/section>/gi,
    /<div[^>]*(?:id|class)\s*=\s*["'][^"']*(?:content|article|post|entry|lemma|markdown|body|main|wiki)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi
  ]) {
    for (const match of cleaned.match(pattern) ?? []) {
      const textContent = htmlToText(match)
      if (textContent.length >= 120) candidates.push(textContent)
    }
  }
  const description = extractMetaDescription(html)
  const fallback = htmlToText(cleaned)
  const best = candidates.sort((left, right) => right.length - left.length)[0] ?? fallback
  return [description, best]
    .map((item) => item.trim())
    .filter((item, index, all) => item && all.findIndex((other) => other.includes(item)) === index)
    .join('\n\n')
    .trim()
}

function normalizeWebHosts(hosts: string[]): string[] {
  return [
    ...new Set(
      hosts
        .map((host) => host.trim().toLocaleLowerCase().replace(/^www\./, ''))
        .filter(Boolean)
    )
  ]
}

function webHostAllowed(urlValue: string, allowedHosts: string[]): boolean {
  if (!allowedHosts.length) return true
  try {
    const hostname = new URL(urlValue).hostname.toLocaleLowerCase().replace(/^www\./, '')
    return allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}

function assertWebHostAllowed(urlValue: string, allowedHosts: string[]): void {
  if (webHostAllowed(urlValue, allowedHosts)) return
  throw new Error(`用户已限定网页来源，只允许访问：${allowedHosts.join('、')}`)
}

function requestedWebHosts(value: string): string[] {
  const hosts: string[] = []
  for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      hosts.push(new URL(match[0]).hostname)
    } catch {
      // Ignore malformed user-provided URLs.
    }
  }
  for (const match of value.matchAll(/\bsite:([a-z0-9.-]+\.[a-z]{2,})\b/gi)) {
    hosts.push(match[1])
  }
  for (const match of value.matchAll(
    /\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|cn|tv|gg|dev|app|co|me))\b/gi
  )) {
    hosts.push(match[1])
  }
  const scopePrefix = '(?:只查|仅查|限定|指定|访问|打开|读取|抓取|从|在|搜索|查询|查找|看看|查看)'
  const scopeSuffix =
    '(?:官网|网站|站点|页面|链接|网址|商城|商店|社区|词条|条目|内容|仓库|视频|专栏|上|里|内|站内)'
  const namedSources: Array<{ aliases: string[]; hosts: string[] }> = [
    { aliases: ['\\bsteam\\b', '蒸汽平台'], hosts: ['steampowered.com', 'steamcommunity.com'] },
    { aliases: ['\\bgithub\\b'], hosts: ['github.com'] },
    { aliases: ['\\breddit\\b'], hosts: ['reddit.com'] },
    { aliases: ['\\bwikipedia\\b', '维基百科'], hosts: ['wikipedia.org'] },
    { aliases: ['百度百科'], hosts: ['baike.baidu.com'] },
    { aliases: ['知乎', '\\bzhihu\\b'], hosts: ['zhihu.com'] },
    { aliases: ['哔哩哔哩', '\\bbilibili\\b'], hosts: ['bilibili.com'] },
    { aliases: ['\\byoutube\\b', '油管'], hosts: ['youtube.com'] },
    { aliases: ['\\bepic\\b'], hosts: ['epicgames.com'] },
    { aliases: ['\\bitch\\.io\\b'], hosts: ['itch.io'] }
  ]
  for (const source of namedSources) {
    const alias = `(?:${source.aliases.join('|')})`
    const explicitScopePattern = new RegExp(
      `${scopePrefix}.{0,12}${alias}|${alias}.{0,12}${scopeSuffix}`,
      'i'
    )
    if (explicitScopePattern.test(value)) hosts.push(...source.hosts)
  }
  return normalizeWebHosts(hosts)
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as Error & { cause?: unknown }).cause
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code?: unknown }).code)
        : ''
  const raw = [error.message, causeMessage].filter(Boolean).join('；')
  if (/aborted|abort/i.test(raw)) return '请求已取消'
  if (/timeout|timed out|signal timed out/i.test(raw)) return '请求超时，可能是网络、代理或目标站响应过慢'
  if (/certificate|tls|ssl/i.test(raw)) return `TLS/证书握手失败：${raw}`
  if (/ENOTFOUND|EAI_AGAIN|DNS|getaddrinfo/i.test(raw)) return `DNS 解析失败：${raw}`
  if (/ECONNREFUSED|ECONNRESET|socket|network|fetch failed/i.test(raw)) {
    return `网络请求失败，可能是代理、防火墙、DNS 或搜索站拦截：${raw}`
  }
  return raw || error.name
}

function shortWebUrl(value: string): string {
  try {
    const url = new URL(value)
    const query = url.searchParams.get('q') || url.searchParams.get('srsearch') || ''
    return `${url.hostname}${url.pathname}${query ? `?q=${query.slice(0, 80)}` : ''}`
  } catch {
    return value.slice(0, 140)
  }
}

function formatWebSearchDiagnostics(
  query: string,
  allowedHosts: string[],
  probes: WebSearchProbe[],
  collectedCount: number,
  eligibleCount: number
): string {
  const failed = probes.filter((probe) => !probe.ok)
  const succeeded = probes.filter((probe) => probe.ok)
  const reason =
    collectedCount === 0
      ? '所有搜索入口均未返回候选结果'
      : allowedHosts.length && eligibleCount === 0
        ? '用户指定站点未命中可用候选'
        : '候选结果排序后为空'
  return [
    `网页搜索失败：${reason}`,
    `关键词：${query}`,
    allowedHosts.length ? `限定来源：${allowedHosts.join('、')}` : '',
    `网络通道：${lastResolvedWebProxy}`,
    `入口统计：成功 ${succeeded.length}/${probes.length}，失败 ${failed.length}/${probes.length}，候选 ${collectedCount}，可用候选 ${eligibleCount}`,
    '入口明细：',
    ...probes.map((probe, index) =>
      probe.ok
        ? `${index + 1}. ✅ ${probe.label} · ${probe.status} · ${probe.durationMs}ms · 结果 ${probe.count} · ${shortWebUrl(probe.url)}`
        : `${index + 1}. ❌ ${probe.label} · ${probe.durationMs}ms · ${probe.error} · ${shortWebUrl(probe.url)}`
    ),
    '建议：检查本机网络、代理、防火墙、DNS；或改用更精准关键词、直接提供目标网址。'
  ]
    .filter(Boolean)
    .join('\n')
}

function formatWebSearchEmptyResult(
  query: string,
  mode: WebSearchMode,
  probes: WebSearchProbe[],
  eligibleResults: WebSearchResult[]
): string {
  const succeeded = probes.filter((probe) => probe.ok)
  const failed = probes.filter((probe) => !probe.ok)
  return [
    `<web_search_empty query="${query.replace(/"/g, '&quot;')}" mode="${mode}">`,
    '搜索入口已经正常返回候选，但本地相关性排序未发现可作为证据的页面。此结果不属于网络故障或工具执行失败。',
    `入口状态：成功 ${succeeded.length}/${probes.length}，失败 ${failed.length}/${probes.length}，候选 ${eligibleResults.length}。`,
    '可能原因：查询同时混入互不相属的人物、作品或限定词；请拆成单一实体与单一事实重新搜索，禁止原样重复查询。',
    eligibleResults.length
      ? `被过滤候选预览：\n${eligibleResults
          .slice(0, 5)
          .map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}`)
          .join('\n')}`
      : '',
    '</web_search_empty>'
  ]
    .filter(Boolean)
    .join('\n')
}

function formatWebFetchDiagnostics(query: string, probes: WebFetchProbe[]): string {
  const failed = probes.filter((probe) => !probe.ok)
  return [
    '网页正文读取失败：搜索已命中结果，但候选页面全部无法解析为正文',
    `关键词：${query}`,
    `读取统计：成功 0/${probes.length}，失败 ${failed.length}/${probes.length}`,
    '读取明细：',
    ...failed.map(
      (probe, index) =>
        `${index + 1}. ❌ ${probe.item.title || '未提供标题'}\n   地址：${probe.item.url}\n   原因：${probe.error}`
    ),
    '建议：目标站可能需要登录、验证码、脚本渲染或屏蔽抓取；可换公开镜像、百科/官方页面，或把页面内容手动贴进来。'
  ].join('\n')
}

async function runSearchEndpoint(
  endpoint: WebSearchEndpoint,
  limit: number,
  signal: AbortSignal
): Promise<WebSearchProbe> {
  const started = Date.now()
  try {
    const response = await fetchPublicPage(endpoint.url, signal)
    const status = response.status
    if (!response.ok) {
      const body = await readResponseText(response, 4096)
      const blocked =
        /(?:captcha|verify you are human|access denied|enable javascript|登录后继续|请完成验证|安全验证|访问过于频繁|人机验证|验证码)/i.test(
          body
        )
      throw new Error(
        blocked
          ? `搜索服务返回 ${status}，疑似验证码、登录墙或反爬页面`
          : `搜索服务返回 ${status} ${response.statusText}`
      )
    }
    const results = endpoint.parse(await readResponseText(response), limit)
    return {
      ok: true,
      label: endpoint.label,
      url: endpoint.url,
      status,
      durationMs: Date.now() - started,
      count: results.length,
      results
    }
  } catch (error) {
    return {
      ok: false,
      label: endpoint.label,
      url: endpoint.url,
      durationMs: Date.now() - started,
      error: errorMessage(error)
    }
  }
}

async function runFetchResult(
  item: WebSearchResult,
  query: string,
  signal: AbortSignal
): Promise<WebFetchProbe> {
  try {
    const content = await fetchPublicWebpage(item.url, 16000, signal)
    if (!webContentMatchesQuery(query, `${item.title}\n${item.snippet}\n${content}`)) {
      throw new Error('网页正文与查询核心词相关度不足')
    }
    return {
      ok: true,
      item,
      content: selectRelevantWebContent(content, query)
    }
  } catch (error) {
    return {
      ok: false,
      item,
      error: errorMessage(error)
    }
  }
}

function normalizeSearchMode(
  value: unknown,
  query: string,
  allowedHosts: string[]
): WebSearchMode {
  if (allowedHosts.length) return 'site'
  const requested = text(value).trim().toLocaleLowerCase()
  if (requested === 'site') return 'general'
  if (['general', 'site', 'encyclopedia', 'community', 'news'].includes(requested)) {
    return requested as WebSearchMode
  }
  if (/(?:百科|词条|wikipedia|wiki)/i.test(query)) return 'encyclopedia'
  if (/(?:reddit|知乎|论坛|社区|讨论帖|用户评价)/i.test(query)) return 'community'
  if (/(?:最新|新闻|今日|今天|刚刚|近期|本周|本月|动态|进展)/i.test(query)) return 'news'
  return 'general'
}

function buildSearchEndpoints(
  query: string,
  mode: WebSearchMode,
  allowedHosts: string[],
  fallback = false
): WebSearchEndpoint[] {
  const siteScope = allowedHosts.map((host) => `site:${host}`).join(' OR ')
  const scopedQuery = siteScope
    ? `${query} (${siteScope})`
    : mode === 'community'
      ? `${query} (site:reddit.com OR site:zhihu.com)`
      : mode === 'news'
        ? `${query} 新闻`
        : query
  if (fallback) {
    return [
      {
        label: mode === 'site' ? 'Bing HTML 限定来源兜底' : 'Bing HTML 搜索兜底',
        url: `https://www.bing.com/search?q=${encodeURIComponent(scopedQuery)}&setlang=zh-hans`,
        parse: parseBingResults
      }
    ]
  }
  if (mode === 'encyclopedia') {
    const encyclopediaQuery = `${query} (site:baike.baidu.com OR site:wikipedia.org)`
    return [
      {
        label: '中文维基 API',
        url: `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
        parse: (value: string, max: number) =>
          parseWikipediaSearchResults(value, max, 'https://zh.wikipedia.org')
      },
      {
        label: '英文维基 API',
        url: `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
        parse: (value: string, max: number) =>
          parseWikipediaSearchResults(value, max, 'https://en.wikipedia.org')
      },
      {
        label: 'Bing RSS 百科搜索',
        url: `https://www.bing.com/search?format=rss&q=${encodeURIComponent(encyclopediaQuery)}`,
        parse: parseBingRssResults
      }
    ]
  }
  if (mode === 'community') {
    const communityQuery = `${query} (site:reddit.com OR site:zhihu.com)`
    return [
      {
        label: 'Bing RSS 社区搜索',
        url: `https://www.bing.com/search?format=rss&q=${encodeURIComponent(communityQuery)}`,
        parse: parseBingRssResults
      },
      {
        label: 'DuckDuckGo HTML 社区搜索',
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(communityQuery)}&kl=cn-zh`,
        parse: parseDuckResults
      }
    ]
  }
  if (mode === 'news') {
    return [
      {
        label: 'Bing News RSS',
        url: `https://www.bing.com/news/search?format=rss&q=${encodeURIComponent(query)}`,
        parse: parseBingRssResults
      },
      {
        label: 'DuckDuckGo HTML 最新信息搜索',
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=cn-zh`,
        parse: parseDuckResults
      }
    ]
  }
  return [
    {
      label: mode === 'site' ? 'Bing RSS 限定来源' : 'Bing RSS 常规搜索',
      url: `https://www.bing.com/search?format=rss&q=${encodeURIComponent(scopedQuery)}`,
      parse: parseBingRssResults
    },
    {
      label: mode === 'site' ? 'DuckDuckGo HTML 限定来源' : 'DuckDuckGo HTML 常规搜索',
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(scopedQuery)}&kl=cn-zh`,
      parse: parseDuckResults
    }
  ]
}

export async function searchPublicWeb(
  queryValue: string,
  maxResults: number,
  signal: AbortSignal,
  allowedHostsValue: string[] = [],
  modeValue: unknown = 'auto'
): Promise<string> {
  const query = queryValue.trim()
  if (!query) throw new Error('搜索关键词不能为空')
  const allowedHosts = normalizeWebHosts(allowedHostsValue)
  const mode = normalizeSearchMode(modeValue, query, allowedHosts)
  const limit = Math.max(3, Math.min(8, maxResults || 6))
  const cacheKey = JSON.stringify({ query: query.toLocaleLowerCase(), allowedHosts, mode, limit })
  const cached = cachedWebValue(webSearchCache, cacheKey)
  if (cached) return cached
  const endpoints = buildSearchEndpoints(query, mode, allowedHosts)
  const searched: WebSearchProbe[] = await Promise.all(
    endpoints.map((endpoint) => runSearchEndpoint(endpoint, limit, signal))
  )
  let collected = searched.flatMap((result) => (result.ok ? result.results : []))
  if (collected.length < Math.min(3, limit) && mode !== 'encyclopedia') {
    const fallback = await Promise.all(
      buildSearchEndpoints(query, mode, allowedHosts, true).map((endpoint) =>
        runSearchEndpoint(endpoint, limit, signal)
      )
    )
    searched.push(...fallback)
    collected = searched.flatMap((result) => (result.ok ? result.results : []))
  }
  collected = collected.map((item, index) => ({ ...item, sourceRank: index }))
  const eligibleResults = allowedHosts.length
    ? collected.filter((item) => webHostAllowed(item.url, allowedHosts))
    : collected
  const results = rankSearchResults(query, eligibleResults, limit, mode)
  if (!results.length) {
    const emptyResult = formatWebSearchEmptyResult(
      query,
      mode,
      searched,
      eligibleResults
    )
    storeWebValue(webSearchCache, cacheKey, emptyResult, 2 * 60 * 1000, 160)
    return emptyResult
  }
  const fetchLimit = mode === 'site' ? 2 : mode === 'general' ? 3 : 4
  const fetched = await Promise.all(
    results
      .slice(0, Math.min(fetchLimit, results.length))
      .map((item) => runFetchResult(item, query, signal))
  )
  const readable = fetched.filter((result): result is Extract<WebFetchProbe, { ok: true }> =>
    Boolean(result.ok)
  )
  if (!readable.length) {
    throw new Error(formatWebFetchDiagnostics(query, fetched))
  }
  const failedFetches = fetched.filter((result): result is Extract<WebFetchProbe, { ok: false }> =>
    Boolean(!result.ok)
  )
  const fetchedAt = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  })
  const output = [
    `<live_web_evidence fetched_at="${fetchedAt}" source="runtime_http" authoritative="true">`,
    allowedHosts.length
      ? `程序已在 ${fetchedAt} 严格限定 ${allowedHosts.join('、')}，按 ${mode} 模式并发读取 ${readable.length} 个页面。以下内容来自实时 HTTP 响应，不受模型训练截止日期限制。`
      : `程序已在 ${fetchedAt} 按 ${mode} 模式搜索并读取 ${readable.length} 个高相关来源。以下内容来自实时 HTTP 响应，不受模型训练截止日期限制。`,
    ...readable.map(
      ({ item, content }, index) =>
        `\n===== 来源 ${index + 1} · ${webSourceKind(item.url)} =====\n搜索标题：${item.title}\n${content}`
    ),
    failedFetches.length
      ? `\n===== 读取失败明细 =====\n${failedFetches
          .map(
            (failure, index) =>
              `${index + 1}. ${failure.item.title || '未提供标题'}\n地址：${failure.item.url}\n原因：${failure.error}`
          )
          .join('\n\n')}`
      : '',
    '</live_web_evidence>'
  ]
    .filter(Boolean)
    .join('\n\n')
  storeWebValue(webSearchCache, cacheKey, output, 10 * 60 * 1000, 120)
  return output
}

async function parsePublicWebpageResponse(
  response: Response,
  requestedUrl: string,
  maxCharsValue: number,
  displayUrl?: string
): Promise<string> {
  const maxChars = Math.max(2000, Math.min(30000, maxCharsValue || 18000))
  const contentType = response.headers.get('content-type') ?? ''
  const normalizedContentType = contentType.toLocaleLowerCase()
  if (
    contentType &&
    !normalizedContentType.includes('text/') &&
    !normalizedContentType.includes('html') &&
    !normalizedContentType.includes('json') &&
    !normalizedContentType.includes('xml')
  ) {
    throw new Error(`暂不支持此网页内容类型：${contentType}`)
  }
  const source = await readResponseText(response)
  if (!response.ok) {
    const blockedPagePattern =
      /(?:captcha|verify you are human|access denied|enable javascript|登录后继续|请完成验证|安全验证|访问过于频繁|人机验证|验证码)/i
    if (blockedPagePattern.test(source.slice(0, 2400))) {
      throw new Error(`网页返回 ${response.status}，疑似验证码、登录墙或反爬页面`)
    }
    throw new Error(`网页返回 ${response.status} ${response.statusText}`)
  }
  const htmlTitle = htmlToText(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  const plainTitle = source.match(/^Title:\s*(.+)$/im)?.[1]?.trim() ?? ''
  const title = htmlTitle || plainTitle
  const isHtml =
    normalizedContentType.includes('html') || /<(?:!doctype\s+html|html|head|body)\b/i.test(source)
  const plainContent = source.match(/Markdown Content:\s*([\s\S]*)/i)?.[1]?.trim() ?? source.trim()
  const content = isHtml ? htmlDocumentToText(source) : plainContent
  const blockedPagePattern =
    /(?:captcha|verify you are human|access denied|enable javascript|登录后继续|请完成验证|安全验证|访问过于频繁|人机验证|验证码)/i
  if (blockedPagePattern.test(`${title}\n${content.slice(0, 1600)}`)) {
    throw new Error('网页返回验证码、登录墙或反爬页面，已拒绝作为有效来源')
  }
  const readable = content || title
  if (readable.length < 60) {
    throw new Error('网页正文过短或依赖脚本渲染，解析失败')
  }
  const finalUrl = displayUrl || response.url || requestedUrl
  return `标题：${title || '未提供标题'}\n地址：${finalUrl}\n来源类型：${webSourceKind(finalUrl)}\n解析字符数：${readable.length}\n\n正文：\n${readable.slice(0, maxChars)}${
    readable.length > maxChars ? '\n\n[正文已截断]' : ''
  }`
}

async function renderPublicWebpageLocally(
  url: string,
  maxCharsValue: number,
  signal: AbortSignal
): Promise<string> {
  const renderer = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  renderer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let timeout: ReturnType<typeof setTimeout> | null = null
  let abortListener: (() => void) | null = null
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = (): void => reject(new Error('请求已取消'))
    if (signal.aborted) abortListener()
    else signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('本地渲染网页超时')), 20000)
    })
    await Promise.race([
      renderer.loadURL(url, {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
      }),
      timeoutPromise,
      abortPromise
    ])
    await new Promise((resolve) => setTimeout(resolve, 450))
    const finalUrl = renderer.webContents.getURL() || url
    assertPublicWebUrl(finalUrl)
    const html = await renderer.webContents.executeJavaScript(
      'document.documentElement ? document.documentElement.outerHTML : ""',
      true
    )
    const title = renderer.webContents.getTitle()
    const content = htmlDocumentToText(String(html))
    if (content.length < 60) throw new Error('本地渲染完成，但正文仍然过短')
    const maxChars = Math.max(2000, Math.min(30000, maxCharsValue || 18000))
    return `标题：${title || '未提供标题'}\n地址：${finalUrl}\n来源类型：${webSourceKind(finalUrl)}\n解析字符数：${content.length}\n\n正文：\n${content.slice(0, maxChars)}${
      content.length > maxChars ? '\n\n[正文已截断]' : ''
    }`
  } finally {
    if (timeout) clearTimeout(timeout)
    if (abortListener) signal.removeEventListener('abort', abortListener)
    if (!renderer.isDestroyed()) renderer.destroy()
  }
}

export async function fetchPublicWebpage(
  urlValue: string,
  maxCharsValue: number,
  signal: AbortSignal
): Promise<string> {
  const url = assertPublicWebUrl(urlValue.trim()).toString()
  const cacheKey = `${url}\n${Math.max(2000, Math.min(30000, maxCharsValue || 18000))}`
  const cached = cachedWebValue(webPageCache, cacheKey)
  if (cached) return cached
  let directError: Error | null = null
  try {
    const response = await fetchPublicPage(url, signal)
    const content = await parsePublicWebpageResponse(response, url, maxCharsValue)
    storeWebValue(webPageCache, cacheKey, content, 30 * 60 * 1000, 240)
    return content
  } catch (error) {
    if (signal.aborted) throw error
    directError = error instanceof Error ? error : new Error(String(error))
  }
  try {
    const content = await renderPublicWebpageLocally(url, maxCharsValue, signal)
    storeWebValue(webPageCache, cacheKey, content, 30 * 60 * 1000, 240)
    return content
  } catch (error) {
    if (signal.aborted) throw error
    const fallbackError = error instanceof Error ? error.message : String(error)
    throw new Error(`${directError.message}；本地渲染解析失败：${fallbackError}`)
  }
}

function isWebTool(name: string): boolean {
  return name === 'search_web' || name === 'fetch_webpage'
}

function webToolFailed(result: string): boolean {
  return /^(?:网页工具执行失败|工具执行失败|网页相关性校验失败)/.test(result.trim())
}

function webSearchReturnedNoEvidence(result: string): boolean {
  return result.trimStart().startsWith('<web_search_empty ')
}

function webInfrastructureFailed(result: string): boolean {
  return (
    webToolFailed(result) &&
    /(?:ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS 解析失败|ECONNREFUSED|代理连接失败|所有搜索入口均未返回候选结果[\s\S]{0,1200}成功 0\/\d+)/i.test(
      result
    )
  )
}

function toolResultPreview(result: string): string {
  const limit = webToolFailed(result) ? 6000 : 2000
  return result.length > limit ? `${result.slice(0, limit)}\n\n[结果已截断]` : result
}

function hostRuntimeContext(currentTime: string): string {
  return `<host_runtime_context source="host_os_clock" authoritative="true">
宿主系统当前时间：${currentTime}（Asia/Shanghai）。
此时间由正在运行应用的本机时钟直接提供，不是模型推断结果。禁止自行猜测当前日期，禁止使用训练截止日期覆盖此值。
</host_runtime_context>`
}

function describeInitialAgentThinking(request: AgentStartRequest): string {
  const objective = request.objective.replace(/\s+/g, ' ').trim().slice(0, 220)
  const signals: string[] = []
  if (/(?:搜索|查找|查询|网页|互联网|最新|新闻|资料)/i.test(request.objective)) {
    signals.push('需要联网核验或搜索定位')
  }
  if (/(?:读取|查看|检查|审查|文件|代码|<file\b|<current_file\b|<selected_code\b)/i.test(request.objective)) {
    signals.push('需要读取项目上下文')
  }
  if (/(?:修改|修复|实现|添加|删除|创建|重命名|移动)/i.test(request.objective)) {
    signals.push('可能涉及文件改动')
  }
  if (/(?:运行|测试|验证|构建|报错|失败)/i.test(request.objective)) {
    signals.push('需要运行验证或排查错误')
  }
  const action =
    signals.length > 0
      ? signals.join('、')
      : '偏向直接解释或给出建议，只有缺少事实依据时再调用工具'
  const editRule =
    request.permissionMode === 'read-only'
      ? '当前只读模式：只分析和说明，不执行写入。'
      : '若确认需要改文件，会先定位并读取行号，再用精准替换，改完复查。'
  return [
    `目标摘要：${objective || '处理当前请求'}`,
    `意图判断：${action}。`,
    `执行策略：先结合上下文选择最小必要工具，避免为了流程强行调用工具。${editRule}`
  ].join('\n')
}

export async function runWebChat(
  model: AgentStartRequest['model'],
  messages: LlmMessage[],
  onChunk: (content: string) => void,
  signal: AbortSignal,
  onEvent: (event: Omit<ChatEvent, 'requestId'>) => void = () => undefined,
  forceWebSearch = false,
  historyArchive: ChatContextMessage[] = []
): Promise<TokenUsage> {
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
  const latestUserIndex = messages.reduce(
    (latest, message, index) => (message.role === 'user' ? index : latest),
    -1
  )
  const runtimeMessages = messages.map((message, index) =>
    index === latestUserIndex
      ? {
          ...message,
          content: `${message.content}\n\n${hostRuntimeContext(currentTime)}`
        }
      : message
  )
  const latestUserContent = latestUserIndex >= 0 ? messages[latestUserIndex].content : ''
  const restrictedWebHosts = requestedWebHosts(latestUserContent)
  const restrictedWebInstruction = restrictedWebHosts.length
    ? `用户已指定网页来源，程序将严格限制为 ${restrictedWebHosts.join('、')}。禁止搜索、读取、引用或推荐任何其他网站；此任务不执行跨域名凑数核验。`
    : '用户未指定网页来源时，才使用多个独立网站进行交叉核验。'
  const webTools: ToolDefinition[] = [
    ...(historyArchive.length
      ? [
          {
            type: 'function' as const,
            function: {
              name: 'search_conversation_history',
              description:
                '按关键词查询本机会话历史资料库。当前请求默认不携带历史聊天原文；需要上文、人物设定、旧结论或用户偏好时必须按需调用此工具检索，禁止凭记忆乱补。',
              parameters: {
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string', description: '要在历史资料库中查询的关键词' },
                  max_results: { type: 'number', description: '返回条数，默认 6，最多 12' }
                }
              }
            }
          }
        ]
      : []),
    {
      type: 'function',
      function: {
        name: 'search_web',
        description:
          restrictedWebHosts.length
            ? `只在用户指定的 ${restrictedWebHosts.join('、')} 内并发搜索并读取正文，禁止返回其他网站。`
            : '并发搜索多个搜索入口，并同时读取多个不同网站的正文。返回内容可直接用于多来源交叉分析。',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            max_results: { type: 'number' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fetch_webpage',
        description: '读取公开网页正文并返回标题、直接网址、来源类型和正文。',
        parameters: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string' },
            max_chars: { type: 'number' }
          }
        }
      }
    }
  ]
  const workingMessages: LlmMessage[] = [
    {
      role: 'system',
      content:
        `你处于具备真实网页工具的普通 Chat 模式。系统当前时间为 ${currentTime}（Asia/Shanghai），回答日期、年龄、时效信息时必须以此时间为准，严禁把训练数据截止日期当作当前日期。先完整阅读用户本轮问题与历史上下文，自主判断是否真的需要联网；问题可凭现有上下文可靠回答时直接回复，严禁仅因消息较长、出现普通关键词或为了展示能力而调用网页工具。只要你判断问题依赖最新信息、用户明确要求搜索，或关键事实无法从上下文可靠确定，就必须直接调用 search_web；严禁声称自己无法联网、无法搜索、无法调用工具，也禁止因自我怀疑放弃调用。${restrictedWebInstruction}${
          forceWebSearch ? '用户本轮已明确开启强制联网核验，必须调用网页工具。' : ''
        } 当前请求默认只直接携带本轮用户消息，不携带历史聊天原文；历史记录已放入本机会话历史资料库。若本轮只给出短回复，或出现“继续、刚才、上文、之前、这个、按你说的、照旧、他/她/它”等强依赖上文的表达，必须先调用 search_conversation_history 检索相关片段；任务可独立理解时禁止检索历史。禁止重新分析已完成任务。网页工具返回的是证据资料，并不代表用户任务已经完成；每次拿到工具结果后，必须重新对照用户的原始问题继续分析、推导、计算或求解。用户要求解题、判断、比较、创作或给方案时，严禁只复述搜索摘要、罗列链接便结束，必须完成用户真正要求的结果。最终回答须依据实际读取内容，并列出来源标题和直接网址。证据不足时明确说明无法确认。内部思考与可见推理过程默认使用简体中文，工具 arguments 必须是严格 JSON 对象。`
    },
    ...runtimeMessages
  ]
  const verifiedHosts = new Set<string>()
  const referenceHosts = new Set<string>()
  let totalUsage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  }
  let forceTool = forceWebSearch
  let webSearchUsed = false
  let invalidRetries = 0
  let verificationRetries = 0
  let lastQuery = ''
  let webFailureStreak = 0
  let webFailureTotal = 0
  let webAccessExhausted = false

  for (let step = 0; step < 18; step += 1) {
    let streamedReasoning = false
    let streamedContent = false
    const completion = await completeWithTools(
      model,
      workingMessages,
      webTools,
      signal,
      forceTool ? 'required' : 'auto',
      (content) => {
        streamedReasoning = true
        onEvent({
          type: 'reasoning',
          title: '思考',
          content
        })
      },
      (content) => {
        streamedContent = true
        onChunk(content)
      }
    )
    if (completion.contextMemory) {
      applyCompressionMemory(workingMessages, completion.contextMemory)
      onEvent({ type: 'context', contextMemory: completion.contextMemory })
    }
    forceTool = false
    totalUsage = addUsage(totalUsage, completion.usage)
    onEvent({
      type: 'context',
      usage: totalUsage,
      contextState: {
        usedTokens: completion.contextTokens,
        limitTokens: model.contextLength || 8192,
        estimated: completion.contextEstimated,
        compressed: completion.compressed,
        updatedAt: Date.now()
      }
    })
    if (!streamedReasoning && completion.reasoning?.trim()) {
      onEvent({
        type: 'reasoning',
        title: '思考',
        content: completion.reasoning
      })
    }
    if (!completion.content.trim() && completion.toolCalls.length === 0) {
      invalidRetries += 1
      if (invalidRetries >= 3) throw new Error('本地模型连续生成无效网页工具调用')
      workingMessages[0].content += forceWebSearch
        ? '\n上一次工具调用被服务丢弃。用户已明确要求联网，必须调用一个有效网页工具，函数名来自 tools，arguments 为严格 JSON。'
        : '\n上一次输出为空。请重新判断：无需联网就直接给出明确中文回答；确需联网才调用一个有效网页工具。arguments 必须为严格 JSON。'
      forceTool = forceWebSearch
      continue
    }
    invalidRetries = 0
    workingMessages.push(completion.rawMessage)

    if (!completion.toolCalls.length) {
      const refusedAvailableWeb =
        !webSearchUsed &&
        /(?:无法|不能|不具备|没法).{0,18}(?:联网|搜索|网页|调用.{0,8}工具|访问.{0,8}互联网)/i.test(
          completion.content
        )
      if (refusedAvailableWeb) {
        verificationRetries += 1
        if (verificationRetries < 3) {
          workingMessages.push({
            role: 'user',
            content:
              '系统纠正：网页工具当前真实可用。你刚才错误地声称无法联网；既然你已经判断需要网页信息，现在必须立即调用 search_web，不要继续解释能力限制。'
          })
          forceTool = true
          continue
        }
      }
      if (
        webSearchUsed &&
        restrictedWebHosts.length === 0 &&
        !webAccessExhausted &&
        (verifiedHosts.size < 3 || referenceHosts.size < 2)
      ) {
        verificationRetries += 1
        if (verificationRetries >= 3) {
          onChunk(
            `当前公开来源不足，无法可靠确认。已读取 ${verifiedHosts.size} 个独立来源，其中 ${referenceHosts.size} 个非社区来源。`
          )
          return totalUsage
        }
        workingMessages[0].content += `\n网页核验仍不足：当前 ${verifiedHosts.size} 个独立来源、${referenceHosts.size} 个非社区来源。禁止回答结论，继续搜索并读取来源。`
        forceTool = true
        continue
      }
      if (!streamedContent) onChunk(completion.content)
      return totalUsage
    }

    const call = completion.toolCalls[0]
    let result = ''
    const toolTitle =
      call.name === 'search_web'
        ? '调用函数：search_web'
        : call.name === 'fetch_webpage'
          ? '调用函数：fetch_webpage'
          : '调用函数：search_conversation_history'
    onEvent({
      type: 'tool',
      title: toolTitle,
      content:
        call.name === 'search_web'
          ? `query=${text(call.arguments.query)}`
          : call.name === 'fetch_webpage'
            ? `url=${text(call.arguments.url)}`
            : `query=${text(call.arguments.query)}`,
      toolName: call.name,
      toolArgs: call.arguments
    })
    if (webAccessExhausted && isWebTool(call.name)) {
      workingMessages.push({
        role: 'tool',
        content:
          '网页工具已因连续解析失败停止。请直接基于已读取信息回答；若证据不足，必须明确说明无法完成可靠核验。',
        tool_call_id: call.id
      })
      forceTool = false
      continue
    }
    try {
      if (call.name === 'search_web') {
        webSearchUsed = true
        lastQuery = text(call.arguments.query)
        result = await searchPublicWeb(
          lastQuery,
          Number(call.arguments.max_results) || 8,
          signal,
          restrictedWebHosts
        )
        for (const match of result.matchAll(/^地址：(.+)$/gm)) {
          try {
            const hostname = new URL(match[1].trim()).hostname.toLocaleLowerCase()
            verifiedHosts.add(hostname)
            if (webSourceKind(match[1].trim()) !== '社区讨论') {
              referenceHosts.add(hostname)
            }
          } catch {
            // Ignore malformed source lines from third-party pages.
          }
        }
      } else if (call.name === 'fetch_webpage') {
        webSearchUsed = true
        assertWebHostAllowed(text(call.arguments.url), restrictedWebHosts)
        result = await fetchPublicWebpage(
          text(call.arguments.url),
          Number(call.arguments.max_chars) || 18000,
          signal
        )
        if (lastQuery && !webContentMatchesQuery(lastQuery, result)) {
          throw new Error(`网页正文与搜索关键词“${lastQuery}”相关性不足`)
        }
        const finalUrl = result.match(/^地址：(.+)$/m)?.[1]?.trim() || text(call.arguments.url)
        const hostname = new URL(finalUrl).hostname.toLocaleLowerCase()
        verifiedHosts.add(hostname)
        if (webSourceKind(finalUrl) !== '社区讨论') referenceHosts.add(hostname)
      } else if (call.name === 'search_conversation_history') {
        result = searchConversationHistoryArchive(
          historyArchive,
          text(call.arguments.query),
          Number(call.arguments.max_results) || 6
        )
      } else {
        result = `未知网页工具：${call.name}`
      }
    } catch (error) {
      result = `${isWebTool(call.name) ? '网页工具执行失败' : '工具执行失败'}：${
        error instanceof Error ? error.message : String(error)
      }`
    }
    if (isWebTool(call.name) && webInfrastructureFailed(result)) {
      webAccessExhausted = true
      webSearchUsed = true
      workingMessages[0].content +=
        '\n网页请求已确认发生代理、DNS 或基础网络故障。禁止更换关键词重复调用网页工具；请直接说明网络通道与故障原因，并基于本地资料完成仍可完成的部分。'
      onEvent({
        type: 'status',
        title: '网页网络故障，停止重复搜索',
        content: `当前网络通道：${lastResolvedWebProxy}`
      })
    }
    if (isWebTool(call.name) && webToolFailed(result)) {
      webFailureStreak += 1
      webFailureTotal += 1
    } else if (isWebTool(call.name)) {
      webFailureStreak = 0
    }
    if (webFailureStreak >= 3 || webFailureTotal >= 5) {
      webAccessExhausted = true
      workingMessages[0].content +=
        '\n网页工具已连续解析失败。禁止继续调用 search_web 或 fetch_webpage；请直接说明当前无法完成可靠网页核验，并列出已成功读取的来源与失败原因。'
    }
    workingMessages.push({ role: 'tool', content: result, tool_call_id: call.id })
    onEvent({
      type: 'tool',
      title: `${call.name} 已返回`,
      content: toolResultPreview(result),
      toolName: call.name
    })
    forceTool =
      webSearchUsed &&
      restrictedWebHosts.length === 0 &&
      !webAccessExhausted &&
      (verifiedHosts.size < 3 || referenceHosts.size < 2)
  }
  if (webAccessExhausted) {
    onChunk(
      `网页解析连续失败，已安全停止网页循环。已读取 ${verifiedHosts.size} 个独立来源，其中 ${referenceHosts.size} 个非社区来源；当前证据不足，无法给出可靠网页核验结论。`
    )
    return totalUsage
  }
  throw new Error('网页核验达到 18 步安全上限')
}

export async function runAgent(
  request: AgentStartRequest,
  signal: AbortSignal,
  send: EventSender,
  requestApproval: ApprovalRequester,
  readGuidance: () => AgentGuideRequest[] = () => [],
  readUserFileEditLock: (relative: string) => AgentUserFileEditLock | undefined = () =>
    undefined,
  acknowledgeUserFileEditLock: (relative: string, revision: number) => void = () => undefined
): Promise<void> {
  const changes = new Map<string, AgentChange>()
  const tools = new Map<string, RegisteredTool>()
  let activeTasks: AgentTask[] = []
  const workflow: { stage: 'understand' | 'tasks' | 'execute' } = { stage: 'understand' }
  let totalUsage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  }
  const restrictedWebHosts = requestedWebHosts(request.objective)
  const currentTaskText = request.objective.split(/\n\n<(?:selected_code|current_file|file|attachment)\b/i)[0]
  const requiresWorkspaceEdit =
    request.permissionMode !== 'read-only' &&
    /(?:修改|修复|改写|润色|替换|编辑|写入|更新|补写|补充|删除|添加|新增|实现)/i.test(
      currentTaskText
    )
  const hasWritingFileContext =
    /<(?:selected_code|current_file|file)\b[^>]*\bpath=["'][^"']*(?:正文|小说|大纲|章节|人物|角色|设定|剧情)[^"']*["']/i.test(
      request.objective
    )
  const explicitWritingTask =
    /(?:写作|创作|续写|扩写|补写|改写|润色|重写|小说|正文|章节|剧情|文风|描写|台词|对白)/i.test(
      currentTaskText
    )
  const containsLoreMaterial =
    /(?:人物|角色|人设|姓名|身份|性格|关系|外貌|形象|造型|服装|服饰|穿搭|发型|气质|门派|宗门|家族|势力|武学|武功|功法|心法|内功|轻功|身法|招式|剑法|刀法|拳法|掌法|境界|兵器|法宝|绝学|秘籍)/i.test(
      request.objective
    )
  const asksForWritingCorrection =
    /(?:错误|不对|不符|不合理|不像|纠正|修正|修改|调整|优化|改掉|换掉|替换|细节|问题)/i.test(
      currentTaskText
    )
  const isWritingTask =
    explicitWritingTask ||
    (asksForWritingCorrection && (hasWritingFileContext || containsLoreMaterial))
  const requiresWritingLoreResearch = isWritingTask
  const userRequestedWholeFileRead =
    /(?:(?:读取|查看|检查|审查|分析|总结|通读|重构|重写|格式化).{0,16}(?:全文|全篇|整个文件|完整文件|全部内容|所有内容)|(?:全文|全篇|整个文件|完整文件|全部内容|所有内容).{0,16}(?:读取|查看|检查|审查|分析|总结|通读|重构|重写|格式化))/i.test(
      currentTaskText
    )
  const restrictedWebInstruction = restrictedWebHosts.length
    ? `用户已指定网页来源，只允许搜索、读取和引用 ${restrictedWebHosts.join('、')}，禁止访问其他网站，也禁止为了凑来源跨站核验。`
    : '用户未指定网页来源时，才执行多网站交叉核验。'

  const recordChanges = (nextChanges: AgentChange[]): void => {
    for (const change of nextChanges) {
      const existing = changes.get(change.path)
      changes.set(
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

  const readFilePaths = new Set<string>()
  const readFileRanges = new Map<
    string,
    { startLine: number; endLine: number; totalLines: number }
  >()
  const readFileFingerprints = new Map<string, string>()
  const fingerprintText = (content: string): string =>
    createHash('sha256').update(content, 'utf8').digest('hex')
  const normalizedWorkspacePath = (relative: string): string =>
    path.resolve(resolveInWorkspace(request.workspaceRoot, relative)).toLocaleLowerCase()
  const selectedLineRanges = new Map<string, LineRange>()
  for (const range of selectedCodeLineRanges(request.objective)) {
    try {
      selectedLineRanges.set(normalizedWorkspacePath(range.path), range)
    } catch {
      // Ignore stale selections that no longer belong to the current workspace.
    }
  }
  const markFileRead = (
    relative: string,
    range: { startLine: number; endLine: number; totalLines: number },
    content: string
  ): void => {
    const normalized = normalizedWorkspacePath(relative)
    readFilePaths.add(normalized)
    readFileRanges.set(normalized, range)
    readFileFingerprints.set(normalized, fingerprintText(content))
  }
  const invalidateFileRead = (normalized: string): void => {
    readFilePaths.delete(normalized)
    readFileRanges.delete(normalized)
    readFileFingerprints.delete(normalized)
  }
  const throwUserEditLock = (
    relative: string,
    userEditLock: AgentUserFileEditLock
  ): never => {
    const saveState = userEditLock.saved
      ? '用户修改已保存'
      : '用户仍在编辑或自动保存尚未完成'
    throw new Error(
      `用户编辑锁：${saveState}，目标为 ${relative} 第 ${userEditLock.startLine}-${userEditLock.endLine} 行。当前 edit 已拒绝；必须重新调用 read_file 读取此区间，确认用户最新内容并重新分析后，才可发起新的 edit。`
    )
  }
  const throwEditConflict = (relative: string, normalized: string): never => {
    const range = readFileRanges.get(normalized)
    const displayPath = path.relative(
      request.workspaceRoot,
      resolveInWorkspace(request.workspaceRoot, relative)
    )
    invalidateFileRead(normalized)
    const rangeInstruction = range
      ? `重新调用 read_file 读取 ${displayPath} 第 ${range.startLine}-${range.endLine} 行`
      : `重新调用 read_file 读取 ${displayPath} 的目标区间`
    throw new Error(
      `编辑冲突：检测到用户在 AI 最近一次读取后修改了 ${displayPath}。本次写入已拒绝，严禁覆盖用户改动；必须${rangeInstruction}，基于最新内容重新分析后再编辑，禁止复用旧 search、replacement 或 content 参数。`
    )
  }
  const requireReadBeforeEdit = async (
    relative: string,
    currentContent?: string
  ): Promise<void> => {
    if (!relative.trim()) throw new Error('编辑目标文件路径不能为空')
    const normalized = normalizedWorkspacePath(relative)
    const userEditLock = readUserFileEditLock(relative)
    if (userEditLock) throwUserEditLock(relative, userEditLock)
    let info: Record<string, unknown>
    try {
      info = await workspaceEntryInfo(request.workspaceRoot, relative)
    } catch {
      if (readFileFingerprints.has(normalized)) throwEditConflict(relative, normalized)
      return
    }
    if (info.kind !== 'file') throw new Error(`编辑目标不是文本文件：${relative}`)
    const expectedFingerprint = readFileFingerprints.get(normalized)
    if (!readFilePaths.has(normalized) || !expectedFingerprint) {
      throw new Error(`编辑前必须先调用 read_file 读取同一文件：${relative}`)
    }
    const current = currentContent ?? (await readTextFile(request.workspaceRoot, relative))
    if (fingerprintText(current) === expectedFingerprint) return
    throwEditConflict(relative, normalized)
  }

  const normalizeToolCallArguments = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<{
    arguments: Record<string, unknown>
    note?: string
    presentation?: Record<string, unknown>
  }> => {
    if (name === 'read_file') {
      const relative = text(args.path).trim()
      if (!relative) return { arguments: args }
      try {
        const selectedRange = selectedLineRanges.get(normalizedWorkspacePath(relative))
        const hasExplicitRange = [
          args.start_line,
          args.end_line,
          args.around_line
        ].some((value) => Number.isSafeInteger(Number(value)) && Number(value) >= 1)
        if (!selectedRange || hasExplicitRange) return { arguments: args }
        const contextLines = 50
        const normalizedArguments = {
          ...args,
          start_line: Math.max(1, selectedRange.startLine - contextLines),
          end_line: selectedRange.endLine + contextLines
        }
        return {
          arguments: normalizedArguments,
          note: `已根据用户选区自动补充上下文：${relative} 第 ${normalizedArguments.start_line}-${normalizedArguments.end_line} 行；选区仅作为初始锚点，读取后仍需判断是否检索其他文件或网页资料。`,
          presentation: normalizedArguments
        }
      } catch {
        return { arguments: args }
      }
    }
    if (name === 'replace_in_file') {
      const relative = text(args.path).trim()
      const search = text(args.search)
      if (!relative || !search) return { arguments: args }
      try {
        const current = await readTextFile(request.workspaceRoot, relative)
        const index = current.indexOf(search)
        if (index < 0 || current.indexOf(search, index + search.length) >= 0) {
          return { arguments: args }
        }
        const startLine = current.slice(0, index).split(/\r?\n/).length
        const matchLineCount = search.split(/\r?\n/).length
        const replacement = text(args.replacement)
        return {
          arguments: args,
          presentation: {
            ...args,
            __match_start_line: startLine,
            __match_end_line: startLine + matchLineCount - 1,
            __match_line_count: matchLineCount,
            __replacement_line_count: replacement ? replacement.split(/\r?\n/).length : 0
          }
        }
      } catch {
        return { arguments: args }
      }
    }
    if (name !== 'replace_lines') return { arguments: args }
    const relative = text(args.path).trim()
    const rawStart = Number(args.start_line)
    const rawEnd = Number(args.end_line)
    if (!relative || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      return { arguments: args }
    }

    let current: string
    let normalizedPath: string
    try {
      current = await readTextFile(request.workspaceRoot, relative)
      normalizedPath = normalizedWorkspacePath(relative)
    } catch {
      return { arguments: args }
    }
    const totalLines = current.split(/\r?\n/).length
    const validRange =
      Number.isSafeInteger(rawStart) &&
      Number.isSafeInteger(rawEnd) &&
      rawStart >= 1 &&
      rawEnd >= rawStart &&
      rawEnd <= totalLines
    if (validRange) return { arguments: args }

    const selectedRange = selectedLineRanges.get(normalizedPath)
    const recentReadRange = readFileRanges.get(normalizedPath)
    const fallback =
      selectedRange && selectedRange.endLine <= totalLines
        ? { ...selectedRange, source: '编辑器选区' }
        : recentReadRange &&
            recentReadRange.startLine === rawStart &&
            recentReadRange.endLine >= recentReadRange.startLine &&
            recentReadRange.endLine <= totalLines
          ? {
              path: relative,
              startLine: recentReadRange.startLine,
              endLine: recentReadRange.endLine,
              source: '刚刚读取的区间'
            }
          : null
    if (!fallback) return { arguments: args }

    return {
      arguments: {
        ...args,
        start_line: fallback.startLine,
        end_line: fallback.endLine
      },
      presentation: {
        ...args,
        start_line: fallback.startLine,
        end_line: fallback.endLine
      },
      note: `模型给出的行号 ${String(args.start_line)}-${String(args.end_line)} 无法对应当前文件，已按${fallback.source}纠正为 ${fallback.startLine}-${fallback.endLine}`
    }
  }

  const createTextPreview = async (
    relative: string,
    update: (current: string) => string,
    allowMissing = false,
    enforceReadSnapshot = false
  ): Promise<AgentChange[]> => {
    const absolute = resolveInWorkspace(request.workspaceRoot, relative)
    let before = ''
    let beforeExists = true
    try {
      before = await readTextFile(request.workspaceRoot, relative)
    } catch (error) {
      if (!allowMissing) throw error
      beforeExists = false
    }
    if (enforceReadSnapshot && beforeExists) {
      await requireReadBeforeEdit(relative, before)
    }
    return [
      {
        path: absolute,
        before,
        after: update(before),
        beforeExists,
        afterExists: true
      }
    ]
  }

  const applyTextPreview = async (preview: AgentChange[]): Promise<void> => {
    for (const change of preview) {
      const lockBeforeRead = readUserFileEditLock(change.path)
      if (lockBeforeRead) throwUserEditLock(change.path, lockBeforeRead)
      let current = ''
      let currentExists = true
      try {
        current = await readTextFile(request.workspaceRoot, change.path)
      } catch {
        currentExists = false
      }
      const lockAfterRead = readUserFileEditLock(change.path)
      if (lockAfterRead) throwUserEditLock(change.path, lockAfterRead)
      if (currentExists !== (change.beforeExists ?? true) || current !== change.before) {
        const normalized = normalizedWorkspacePath(change.path)
        if (readFileFingerprints.has(normalized)) throwEditConflict(change.path, normalized)
        throw new Error(`文件在写入提交前发生变化，已拒绝覆盖：${change.path}`)
      }
    }
    for (const change of preview) {
      if (change.afterExists === false) {
        await deleteWorkspaceEntry(request.workspaceRoot, change.path)
      } else {
        await writeTextFile(request.workspaceRoot, change.path, change.after)
      }
    }
    for (const change of preview) {
      const normalized = normalizedWorkspacePath(change.path)
      if (!readFileFingerprints.has(normalized)) continue
      if (change.afterExists === false) {
        invalidateFileRead(normalized)
        continue
      }
      const totalLines = change.after.split(/\r?\n/).length
      const previousRange = readFileRanges.get(normalized)
      readFilePaths.add(normalized)
      readFileFingerprints.set(normalized, fingerprintText(change.after))
      readFileRanges.set(normalized, {
        startLine: Math.min(previousRange?.startLine ?? 1, totalLines),
        endLine: Math.min(previousRange?.endLine ?? totalLines, totalLines),
        totalLines
      })
    }
    recordChanges(preview)
    send({
      requestId: request.requestId,
      type: 'file_change',
      changes: preview
    })
  }

  const changedLineWindow = (
    before: string,
    after: string,
    contextLines = 50
  ): { changedStart: number; changedEnd: number; start: number; end: number; total: number } => {
    const beforeLines = before.split(/\r?\n/)
    const afterLines = after.split(/\r?\n/)
    let prefix = 0
    while (
      prefix < beforeLines.length &&
      prefix < afterLines.length &&
      beforeLines[prefix] === afterLines[prefix]
    ) {
      prefix += 1
    }
    let suffix = 0
    while (
      suffix < beforeLines.length - prefix &&
      suffix < afterLines.length - prefix &&
      beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
    ) {
      suffix += 1
    }
    const total = Math.max(1, afterLines.length)
    const changedStart = Math.min(total, prefix + 1)
    const changedEnd = Math.max(changedStart, Math.min(total, afterLines.length - suffix))
    return {
      changedStart,
      changedEnd,
      start: Math.max(1, changedStart - contextLines),
      end: Math.min(total, changedEnd + contextLines),
      total
    }
  }

  const appendPostEditReview = async (preview?: AgentChange[]): Promise<void> => {
    const reviewTargets = (preview ?? []).filter((change) => change.afterExists !== false)
    if (!reviewTargets.length) return
    const blocks: string[] = []
    for (const change of reviewTargets.slice(0, 6)) {
      const relative = path.relative(request.workspaceRoot, change.path) || change.path
      const window = changedLineWindow(change.before, change.after)
      send({
        requestId: request.requestId,
        type: 'tool',
        title: `read_file · ${relative}:${window.start}-${window.end}`,
        content: `edit 后自动复查修改行 ${window.changedStart}-${window.changedEnd}，读取附近上下文 ${window.start}-${window.end}`,
        toolName: 'read_file',
        toolArgs: {
          path: relative,
          start_line: window.start,
          end_line: window.end
        }
      })
      try {
        const content = await readTextFile(request.workspaceRoot, change.path)
        const lines = content.split(/\r?\n/)
        const start = Math.min(lines.length, window.start)
        const end = Math.min(lines.length, window.end)
        const visibleContent =
          lines
            .slice(start - 1, end)
            .map((line, index) => `${start + index} | ${line}`)
            .join('\n')
        markFileRead(relative, { startLine: start, endLine: end, totalLines: lines.length }, content)
        blocks.push(
          `<post_edit_file path="${relative}" changed_lines="${window.changedStart}-${window.changedEnd}" read_lines="${start}-${end}">\n${visibleContent}\n</post_edit_file>`
        )
        send({
          requestId: request.requestId,
          type: 'tool',
          title: `read_file · ${relative}:${start}-${end} 已返回`,
          content: visibleContent,
          toolName: 'read_file',
          toolArgs: { path: relative, start_line: start, end_line: end }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        blocks.push(`<post_edit_file path="${relative}" error="${message}" />`)
        send({
          requestId: request.requestId,
          type: 'tool',
          title: `read_file · ${relative}:${window.start}-${window.end} 失败`,
          content: message,
          toolName: 'read_file',
          toolArgs: {
            path: relative,
            start_line: window.start,
            end_line: window.end
          }
        })
      }
    }
    if (!blocks.length) return
    messages.push({
      role: 'user',
      content: [
        '<post_edit_review>',
        '程序已在写入后自动读取修改区间附近的最新上下文。必须只依据以下带行号区间检查刚刚的 edit 与前后逻辑是否符合用户要求；如发现问题，继续调用精准编辑工具修复。未展示的文件区域不属于本次复查范围。',
        ...blocks,
        '</post_edit_review>'
      ].join('\n\n')
    })
  }

  const replaceUniqueText = (current: string, args: Record<string, unknown>): string => {
    const search = text(args.search)
    const replacement = text(args.replacement)
    const relative = text(args.path).trim() || '未指定文件'
    if (!search) {
      throw new Error(
        `replace_in_file 参数错误：${relative} 的 search 不能为空；文件未修改。请先调用 read_file 读取目标区间，再从返回的最新原文中逐字复制待替换文本。`
      )
    }
    const occurrenceLines: number[] = []
    let cursor = 0
    while (cursor <= current.length - search.length) {
      const index = current.indexOf(search, cursor)
      if (index < 0) break
      occurrenceLines.push(current.slice(0, index).split(/\r?\n/).length)
      cursor = index + Math.max(1, search.length)
    }
    const count = occurrenceLines.length
    if (count === 0) {
      throw new Error(
        [
          `replace_in_file 匹配失败：${relative} 中待替换文本出现 0 次，文件未修改。`,
          '禁止原样重复本次调用。下一步必须重新调用 read_file 读取同一文件的最新目标区间。',
          '读取成功后，从 read_file 返回的原文中逐字复制 search，去掉行号与分隔符后再调用 replace_in_file；若已掌握准确行号，改用 replace_lines。',
          '常见原因：原文已变化、空格或换行不同、中文引号与英文引号不同、search 携带了 read_file 的行号。'
        ].join('\n')
      )
    }
    if (count > 1) {
      const visibleLines = occurrenceLines.slice(0, 12).join('、')
      const more = occurrenceLines.length > 12 ? ` 等 ${occurrenceLines.length} 处` : ''
      throw new Error(
        [
          `replace_in_file 匹配失败：${relative} 中待替换文本出现 ${count} 次，文件未修改。`,
          `匹配起始行：${visibleLines}${more}。`,
          '禁止原样重复本次调用。下一步必须重新调用 read_file 读取目标位置上下文，再扩大 search 使其唯一；若目标行号明确，改用 replace_lines。'
        ].join('\n')
      )
    }
    return current.replace(search, replacement)
  }

  const replaceLineRange = (current: string, args: Record<string, unknown>): string => {
    const newline = current.includes('\r\n') ? '\r\n' : '\n'
    const lines = current.split(/\r?\n/)
    const start = Number(args.start_line)
    const end = Number(args.end_line)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error('行号范围无效')
    }
    if (end > lines.length) {
      throw new Error(
        `replace_lines 参数错误：end_line=${end}，当前文件共 ${lines.length} 行，无法定位该区间；已拒绝写入以防误删`
      )
    }
    const replacement = text(args.content)
    const replacementLines = replacement === '' ? [] : replacement.split(/\r?\n/)
    return [
      ...lines.slice(0, start - 1),
      ...replacementLines,
      ...lines.slice(end)
    ].join(newline)
  }

  const insertAtLine = (current: string, args: Record<string, unknown>): string => {
    const newline = current.includes('\r\n') ? '\r\n' : '\n'
    const lines = current.split(/\r?\n/)
    const line = Number(args.line)
    if (!Number.isInteger(line) || line < 1 || line > lines.length) {
      throw new Error(`插入行必须在 1-${lines.length} 之间`)
    }
    const inserted = text(args.content).split(/\r?\n/)
    if (current === '') return inserted.join(newline)
    const index = text(args.position) === 'before' ? line - 1 : line
    return [...lines.slice(0, index), ...inserted, ...lines.slice(index)].join(newline)
  }

  const normalizeChineseQuotes = (
    current: string
  ): { content: string; doubleCount: number; singleCount: number; count: number } => {
    let doubleQuoteOpen = true
    let singleQuoteOpen = true
    let doubleCount = 0
    let singleCount = 0
    let changed = 0
    let inFence = false
    const newline = current.includes('\r\n') ? '\r\n' : '\n'
    const lines = current.split(/\r?\n/)
    const isAsciiWord = (value: string | undefined): boolean =>
      Boolean(value && /[A-Za-z0-9]/.test(value))
    const doubleQuotes = new Set(['"', '“', '”'])
    const singleQuotes = new Set(["'", '‘', '’'])
    const previousVisibleChar = (line: string, index: number): string => {
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const value = line[cursor]
        if (value && value.trim()) return value
      }
      return ''
    }
    const nextVisibleChar = (line: string, index: number): string => {
      for (let cursor = index + 1; cursor < line.length; cursor += 1) {
        const value = line[cursor]
        if (value && value.trim()) return value
      }
      return ''
    }
    const decideQuoteRole = (
      line: string,
      index: number,
      needsOpen: boolean,
      currentChar: string
    ): 'open' | 'close' => {
      const prev = previousVisibleChar(line, index)
      const next = nextVisibleChar(line, index)
      const explicitClosingQuote = currentChar === '”' || currentChar === '’'
      if (!needsOpen && prev === '' && next !== '' && !explicitClosingQuote) return 'open'
      return needsOpen ? 'open' : 'close'
    }
    const applyQuote = (
      currentChar: string,
      targetChar: string,
      kind: 'double' | 'single'
    ): string => {
      if (currentChar !== targetChar) changed += 1
      if (currentChar === '"' || currentChar === "'" || currentChar !== targetChar) {
        if (kind === 'double') doubleCount += 1
        else singleCount += 1
      }
      return targetChar
    }
    const normalized = lines.map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      let inInlineCode = false
      let output = ''
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index]
        if (char === '`') {
          inInlineCode = !inInlineCode
          output += char
          continue
        }
        if (doubleQuotes.has(char) && !inInlineCode && line[index - 1] !== '\\') {
          const role = decideQuoteRole(line, index, doubleQuoteOpen, char)
          const target = role === 'open' ? '“' : '”'
          output += applyQuote(char, target, 'double')
          doubleQuoteOpen = role === 'close'
          continue
        }
        if (
          singleQuotes.has(char) &&
          !inInlineCode &&
          line[index - 1] !== '\\' &&
          !(isAsciiWord(line[index - 1]) && isAsciiWord(line[index + 1]))
        ) {
          const role = decideQuoteRole(line, index, singleQuoteOpen, char)
          const target = role === 'open' ? '‘' : '’'
          output += applyQuote(char, target, 'single')
          singleQuoteOpen = role === 'close'
          continue
        }
        output += char
      }
      return output
    })
    return { content: normalized.join(newline), doubleCount, singleCount, count: changed }
  }

  tools.set('list_files', {
    risk: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'list_files',
        description: '列出工作区目录结构。path 使用工作区相对路径，留空代表根目录。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } }
        }
      }
    },
    execute: async (args) => {
      const relative = text(args.path, '.')
      const target = await resolveSecurelyInWorkspace(request.workspaceRoot, relative)
      const tree = await buildFileTree(target, 3)
      const simplify = (nodes: typeof tree): unknown =>
        nodes.map((node) => ({
          name: node.name,
          path: path.relative(request.workspaceRoot, node.path),
          kind: node.kind,
          children: node.children ? simplify(node.children) : undefined
        }))
      return stringifyResult(simplify(tree))
    }
  })

  tools.set('read_file', {
    risk: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          '按行读取工作区内的 UTF-8 文本文件并返回行号。默认必须提供 start_line+end_line，或 around_line+context_lines 精准读取区间；位置未知时先调用 search_files 定位。用户明确要求通读、总结、审查、重构全文或局部上下文确实不足时才省略区间读取全文；工具层不限制用户明确要求的读取行数。',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: '工作区相对路径' },
            start_line: { type: 'integer', minimum: 1, description: '起始行' },
            end_line: { type: 'integer', minimum: 1, description: '结束行' },
            around_line: {
              type: 'integer',
              minimum: 1,
              description: '命中关键词所在行；提供后自动读取该行上下文'
            },
            context_lines: {
              type: 'integer',
              minimum: 1,
              description: 'around_line 上下各读取多少行，默认 50'
            }
          }
        }
      }
    },
    execute: async (args) => {
      const relative = text(args.path)
      const initialUserEditLock = readUserFileEditLock(relative)
      if (initialUserEditLock && !initialUserEditLock.saved) {
        throw new Error(
          `用户编辑锁：${relative} 第 ${initialUserEditLock.startLine}-${initialUserEditLock.endLine} 行仍在自动保存，请稍后重新调用 read_file，禁止基于磁盘旧内容继续编辑`
        )
      }
      let content = await readTextFile(request.workspaceRoot, relative)
      let userEditLock = readUserFileEditLock(relative)
      if (userEditLock) {
        if (!userEditLock.saved) {
          throw new Error(
            `用户编辑锁：${relative} 第 ${userEditLock.startLine}-${userEditLock.endLine} 行仍在自动保存，请稍后重新调用 read_file，禁止基于磁盘旧内容继续编辑`
          )
        }
        content = await readTextFile(request.workspaceRoot, relative)
        const latestLock = readUserFileEditLock(relative)
        if (!latestLock?.saved || latestLock.revision !== userEditLock.revision) {
          throw new Error(
            `用户编辑锁：读取 ${relative} 期间用户再次修改了文件，请重新调用 read_file 获取最终内容`
          )
        }
        userEditLock = latestLock
      }
      const lines = content.split(/\r?\n/)
      const aroundLine =
        Number.isSafeInteger(Number(args.around_line)) && Number(args.around_line) >= 1
          ? Math.min(lines.length, Number(args.around_line))
          : 0
      const contextLines =
        Number.isSafeInteger(Number(args.context_lines)) && Number(args.context_lines) >= 1
          ? Number(args.context_lines)
          : 50
      const hasStart = Number.isSafeInteger(Number(args.start_line)) && Number(args.start_line) >= 1
      const hasEnd = Number.isSafeInteger(Number(args.end_line)) && Number(args.end_line) >= 1
      const hasExplicitInterval = aroundLine > 0 || (hasStart && hasEnd)
      if (!hasExplicitInterval && !userRequestedWholeFileRead && lines.length > 1) {
        throw new Error(
          [
            `read_file 缺少准确读取区间：${relative} 当前共 ${lines.length} 行，已阻止默认读取全文。`,
            '位置未知时先调用 search_files 定位关键词行号，再用 around_line 与 context_lines（默认上下各 50 行）读取上下文。',
            '已有用户选区、明确行号或其他可靠区间时，提供 start_line 与 end_line。只有当前任务明确要求通读、总结、审查、重构全文时才省略区间。'
          ].join('\n')
        )
      }
      const start = aroundLine
        ? Math.max(1, aroundLine - contextLines)
        : Math.min(lines.length, hasStart ? Number(args.start_line) : 1)
      const end = aroundLine
        ? Math.min(lines.length, aroundLine + contextLines)
        : Math.min(lines.length, hasEnd ? Number(args.end_line) : lines.length)
      if (end < start) throw new Error(`读取区间无效：${start}-${end}`)
      markFileRead(relative, { startLine: start, endLine: end, totalLines: lines.length }, content)
      if (userEditLock) acknowledgeUserFileEditLock(relative, userEditLock.revision)
      const userEditNotice = userEditLock
        ? `用户编辑事件：用户刚修改了 ${relative} 第 ${userEditLock.startLine}-${userEditLock.endLine} 行；以下内容已从保存后的最新文件重新读取，本次 read 已解除用户编辑锁，后续 edit 必须基于此内容重新分析。\n\n`
        : ''
      return `${userEditNotice}${lines
        .slice(start - 1, end)
        .map((line, index) => `${start + index} | ${line}`)
        .join('\n')}`
    }
  })

  tools.set('search_files', {
    risk: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'search_files',
        description:
          '像 grep 一样在文件内容中定位关键词与行号。已知目标文件或目录时必须传 path 限定范围；需要跨文件查找或目标未知时省略 path，搜索全部工作区。由你根据当前任务自主选择范围。query 支持 OR 与 AND：a | b | c 表示任一关键词命中，a & b 表示同一文件必须同时包含全部关键词；混合表达式按 OR 分组、组内 AND 处理。',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: '关键词表达式，支持 | 与 &' },
            path: {
              type: 'string',
              description: '可选的工作区相对文件或目录路径；传入时仅搜索该范围，省略时全局搜索'
            }
          }
        }
      }
    },
    execute: async (args) => {
      const scopePath = text(args.path).trim()
      const results = await searchWorkspace(request.workspaceRoot, text(args.query), scopePath)
      return stringifyResult(
        {
          scope: scopePath || '全部工作区',
          query: text(args.query),
          matches: results.map((result) => ({
            ...result,
            path: path.relative(request.workspaceRoot, result.path)
          }))
        }
      )
    }
  })

  tools.set('search_conversation_history', {
    risk: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'search_conversation_history',
        description:
          '按关键词查询本机会话历史资料库。当前请求默认不携带历史聊天原文；需要上文、人物设定、旧结论、用户偏好或未完成事项时按需检索。历史资料库为空时返回空结果，工具始终可用。',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: '要在历史资料库中查询的关键词' },
            max_results: { type: 'number', description: '返回条数，默认 6，最多 12' }
          }
        }
      }
    },
    execute: async (args) =>
      searchConversationHistoryArchive(
        request.historyArchive ?? [],
        text(args.query),
        Number(args.max_results) || 6
      )
  })

  tools.set('search_web', {
    risk: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'search_web',
        description:
          restrictedWebHosts.length
            ? `只在用户指定的 ${restrictedWebHosts.join('、')} 内搜索并读取高相关正文，禁止返回其他网站。`
            : '按查询意图选择少量搜索入口，本地排序并读取高相关正文。禁止为了凑来源固定扩散到百科、社区或无关网站。',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: '搜索关键词，建议包含技术名词或时间范围' },
            mode: {
              type: 'string',
              enum: ['auto', 'general', 'site', 'encyclopedia', 'community', 'news'],
              description:
                '搜索意图，默认 auto；指定网站用 site，百科用 encyclopedia，社区讨论用 community，时效信息用 news'
            },
            max_results: { type: 'number', description: '候选数量，默认 6，最多 8' }
          }
        }
      }
    },
    execute: async (args) =>
      searchPublicWeb(
        text(args.query),
        Number(args.max_results) || 6,
        signal,
        restrictedWebHosts,
        args.mode
      )
  })

  tools.set('fetch_webpage', {
    risk: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'fetch_webpage',
        description: '读取公开网页正文，用于核对搜索结果和提取资料。禁止访问本机与局域网地址。',
        parameters: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', description: '完整网页地址' },
            max_chars: { type: 'number', description: '返回正文字符数，默认 18000，最多 30000' }
          }
        }
      }
    },
    execute: async (args) => {
      const url = text(args.url)
      assertWebHostAllowed(url, restrictedWebHosts)
      return fetchPublicWebpage(url, Number(args.max_chars) || 18000, signal)
    }
  })

  tools.set('create_file', {
    risk: 'create',
    definition: {
      type: 'function',
      function: {
        name: 'create_file',
        description:
          '仅用于创建当前不存在的新文本文件，或初始化已通过 read_file 读取过的空文件。严禁用于编辑非空文件；非空文件必须使用 replace_in_file、replace_lines 或 insert_lines。',
        parameters: {
          type: 'object',
          required: ['path', 'content'],
          properties: {
            path: { type: 'string', description: '工作区相对路径' },
            content: { type: 'string', description: '完整文件内容' }
          }
        }
      }
    },
    preview: async (args) => {
      const relative = text(args.path)
      await requireReadBeforeEdit(relative)
      const preview = await createTextPreview(relative, () => text(args.content), true, true)
      if (preview[0].beforeExists && preview[0].before.length > 0) {
        throw new Error('create_file 不能编辑非空文件，请使用 replace_in_file、replace_lines 或 insert_lines')
      }
      return preview
    },
    execute: async (args, preview) => {
      const relative = text(args.path)
      await applyTextPreview(
        preview ?? (await createTextPreview(relative, () => text(args.content), true, true))
      )
      return `已写入 ${relative}`
    }
  })

  tools.set('create_directory', {
    risk: 'create',
    definition: {
      type: 'function',
      function: {
        name: 'create_directory',
        description: '在工作区内创建文件夹。',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', description: '工作区相对路径' } }
        }
      }
    },
    execute: async (args) => {
      const relative = text(args.path)
      const parent = path.dirname(relative)
      const name = path.basename(relative)
      await createWorkspaceEntry(request.workspaceRoot, parent, name, 'directory', true)
      return `已创建文件夹 ${relative}`
    }
  })

  tools.set('delete_path', {
    risk: 'delete',
    definition: {
      type: 'function',
      function: {
        name: 'delete_path',
        description: '删除工作区内的文件或文件夹。',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', description: '工作区相对路径' } }
        }
      }
    },
    preview: async (args) => {
      const relative = text(args.path)
      const info = await workspaceEntryInfo(request.workspaceRoot, relative)
      if (info.kind !== 'file') return []
      const absolute = resolveInWorkspace(request.workspaceRoot, relative)
      const before = await readTextFile(request.workspaceRoot, relative)
      return [
        {
          path: absolute,
          before,
          after: '',
          beforeExists: true,
          afterExists: false
        }
      ]
    },
    execute: async (args, preview) => {
      const relative = text(args.path)
      if (preview?.length) await applyTextPreview(preview)
      else await deleteWorkspaceEntry(request.workspaceRoot, relative)
      return `已删除 ${relative}`
    }
  })

  tools.set('move_path', {
    risk: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'move_path',
        description: '移动或重命名工作区内的文件或文件夹。',
        parameters: {
          type: 'object',
          required: ['source', 'target'],
          properties: {
            source: { type: 'string' },
            target: { type: 'string' }
          }
        }
      }
    },
    preview: async (args) => {
      const source = text(args.source)
      const target = text(args.target)
      const info = await workspaceEntryInfo(request.workspaceRoot, source)
      if (info.kind !== 'file') return []
      const content = await readTextFile(request.workspaceRoot, source)
      return [
        {
          path: resolveInWorkspace(request.workspaceRoot, source),
          before: content,
          after: '',
          beforeExists: true,
          afterExists: false
        },
        {
          path: resolveInWorkspace(request.workspaceRoot, target),
          before: '',
          after: content,
          beforeExists: false,
          afterExists: true
        }
      ]
    },
    execute: async (args, preview) => {
      if (preview?.length) {
        await applyTextPreview(preview)
        return `已移动到 ${text(args.target)}`
      }
      const target = await moveWorkspaceEntry(
        request.workspaceRoot,
        text(args.source),
        text(args.target)
      )
      return `已移动到 ${path.relative(request.workspaceRoot, target)}`
    }
  })

  tools.set('copy_path', {
    risk: 'create',
    definition: {
      type: 'function',
      function: {
        name: 'copy_path',
        description: '复制工作区内的文件或文件夹到指定位置。',
        parameters: {
          type: 'object',
          required: ['source', 'target'],
          properties: {
            source: { type: 'string' },
            target: { type: 'string' }
          }
        }
      }
    },
    preview: async (args) => {
      const source = text(args.source)
      const target = text(args.target)
      const info = await workspaceEntryInfo(request.workspaceRoot, source)
      if (info.kind !== 'file') return []
      const content = await readTextFile(request.workspaceRoot, source)
      return [
        {
          path: resolveInWorkspace(request.workspaceRoot, target),
          before: '',
          after: content,
          beforeExists: false,
          afterExists: true
        }
      ]
    },
    execute: async (args, preview) => {
      if (preview?.length) {
        await applyTextPreview(preview)
        return `已复制到 ${text(args.target)}`
      }
      const target = await copyWorkspaceEntry(
        request.workspaceRoot,
        text(args.source),
        text(args.target)
      )
      return `已复制到 ${path.relative(request.workspaceRoot, target)}`
    }
  })

  tools.set('file_info', {
    risk: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'file_info',
        description: '获取文件或文件夹的类型、大小和修改时间。',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } }
        }
      }
    },
    execute: async (args) =>
      stringifyResult(await workspaceEntryInfo(request.workspaceRoot, text(args.path)))
  })

  tools.set('normalize_chinese_quotes', {
    risk: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'normalize_chinese_quotes',
        description:
          '确定性修复已通过 read_file 读取过的中文正文里的英文双引号和英文单引号，按上下文转换为中文双引号“”与中文单引号‘’，并修复反向中文引号。跳过 Markdown 代码块、行内代码和英文单词中的撇号。用于小说、散文、中文文稿中的引号规范化。',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: '要规范化的文本文件，使用工作区相对路径' }
          }
        }
      }
    },
    preview: async (args) =>
      requireReadBeforeEdit(text(args.path)).then(() =>
        createTextPreview(
          text(args.path),
          (current) => normalizeChineseQuotes(current).content,
          false,
          true
        )
      ),
    execute: async (args, preview) => {
      const relative = text(args.path)
      const before = preview?.[0]?.before ?? (await readTextFile(request.workspaceRoot, relative))
      const normalized = normalizeChineseQuotes(before)
      if (normalized.count === 0) return `未发现需要转换的英文单双引号：${relative}`
      await applyTextPreview(
        preview ?? (await createTextPreview(relative, () => normalized.content, false, true))
      )
      return `已将 ${relative} 中 ${normalized.doubleCount} 个英文双引号、${normalized.singleCount} 个英文单引号转换为中文引号`
    }
  })

  tools.set('replace_in_file', {
    risk: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'replace_in_file',
        description:
          '在已通过 read_file 读取过的文件中精确替换文本。search 必须逐字来自最新 read_file 结果且在文件内唯一；匹配失败后严禁原样重试，必须重新 read_file，再修正 search 或改用 replace_lines。',
        parameters: {
          type: 'object',
          required: ['path', 'search', 'replacement'],
          properties: {
            path: { type: 'string' },
            search: { type: 'string' },
            replacement: { type: 'string' }
          }
        }
      }
    },
    preview: async (args) =>
      requireReadBeforeEdit(text(args.path)).then(() =>
        createTextPreview(
          text(args.path),
          (current) => replaceUniqueText(current, args),
          false,
          true
        )
      ),
    execute: async (args, preview) => {
      const relative = text(args.path)
      const before = preview?.[0]?.before ?? (await readTextFile(request.workspaceRoot, relative))
      const search = text(args.search)
      const index = before.indexOf(search)
      const startLine = index >= 0 ? before.slice(0, index).split(/\r?\n/).length : 0
      const endLine = startLine ? startLine + search.split(/\r?\n/).length - 1 : 0
      await applyTextPreview(
        preview ??
          (await createTextPreview(
            relative,
            (current) => replaceUniqueText(current, args),
            false,
            true
          ))
      )
      return startLine
        ? `已更新 ${relative} 第 ${startLine}-${endLine} 行`
        : `已更新 ${relative}`
    }
  })

  tools.set('replace_lines', {
    risk: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'replace_lines',
        description:
          '精准替换已通过 read_file 读取过的文件中的指定行范围。start_line 与 end_line 为从 1 开始的闭区间；content 为空可删除对应行。',
        parameters: {
          type: 'object',
          required: ['path', 'start_line', 'end_line', 'content'],
          properties: {
            path: { type: 'string', description: '工作区相对路径' },
            start_line: { type: 'integer', minimum: 1, description: '起始行，从 1 开始' },
            end_line: { type: 'integer', minimum: 1, description: '结束行，从 1 开始' },
            content: { type: 'string', description: '用于替换的新内容，可包含多行' }
          }
        }
      }
    },
    preview: async (args) =>
      requireReadBeforeEdit(text(args.path)).then(() =>
        createTextPreview(
          text(args.path),
          (current) => replaceLineRange(current, args),
          false,
          true
        )
      ),
    execute: async (args, preview) => {
      const relative = text(args.path)
      const start = Number(args.start_line)
      const end = Number(args.end_line)
      await applyTextPreview(
        preview ??
          (await createTextPreview(
            relative,
            (current) => replaceLineRange(current, args),
            false,
            true
          ))
      )
      return `已精准替换 ${relative} 第 ${start}-${end} 行`
    }
  })

  tools.set('insert_lines', {
    risk: 'write',
    definition: {
      type: 'function',
      function: {
        name: 'insert_lines',
        description:
          '在已通过 read_file 读取过的文件指定行之前或之后插入内容，不覆盖其他行。空文件可在第 1 行之前插入。',
        parameters: {
          type: 'object',
          required: ['path', 'line', 'position', 'content'],
          properties: {
            path: { type: 'string' },
            line: { type: 'number' },
            position: { type: 'string', enum: ['before', 'after'] },
            content: { type: 'string' }
          }
        }
      }
    },
    preview: async (args) =>
      requireReadBeforeEdit(text(args.path)).then(() =>
        createTextPreview(
          text(args.path),
          (current) => insertAtLine(current, args),
          false,
          true
        )
      ),
    execute: async (args, preview) => {
      const relative = text(args.path)
      const line = Number(args.line)
      await applyTextPreview(
        preview ??
          (await createTextPreview(relative, (current) => insertAtLine(current, args), false, true))
      )
      return `已在 ${relative} 第 ${line} 行${text(args.position) === 'before' ? '之前' : '之后'}插入内容`
    }
  })

  tools.set('run_command', {
    risk: 'command',
    definition: {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          '在当前工作区执行系统命令，仅用于安装依赖、构建、测试、运行程序与查看状态。创建文件或文件夹必须调用 create_file/create_directory，删除必须调用 delete_path，复制必须调用 copy_path，普通文件编辑必须调用精准编辑工具；严禁用 Python、PowerShell、Shell、重定向或脚本绕过对应的聊天确认模块。命令产生的构建输出会自动刷新。',
        parameters: {
          type: 'object',
          required: ['command'],
          properties: { command: { type: 'string' } }
        }
      }
    },
    execute: async (args) => {
      const command = text(args.command)
      assertCommandWithinWorkspace(command)
      const { stdout, stderr } = await execAsync(command, {
        cwd: request.workspaceRoot,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      })
      return stringifyResult({ stdout, stderr })
    }
  })

  tools.set('update_tasks', {
    risk: 'read',
    definition: {
      type: 'function',
      function: {
        name: 'update_tasks',
        description:
          '创建或更新当前 Agent 任务的可见任务清单。先理解用户目标，再根据任务实际需要自主决定清单的内容、粒度、顺序与状态；每次传入当前完整清单。',
        parameters: {
          type: 'object',
          required: ['tasks'],
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'content', 'status'],
                properties: {
                  id: { type: 'string', description: '稳定且简短的任务标识' },
                  content: { type: 'string', description: '清晰、可验证的任务内容' },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed']
                  }
                }
              }
            }
          }
        }
      }
    },
    execute: async (args) => {
      if (!Array.isArray(args.tasks)) throw new Error('tasks 必须是数组')
      if (args.tasks.length === 0) throw new Error('Agent 任务清单至少需要一项任务')
      const seen = new Set<string>()
      const tasks: AgentTask[] = args.tasks.map((value, index) => {
        if (!value || typeof value !== 'object') throw new Error(`第 ${index + 1} 项任务格式无效`)
        const item = value as Record<string, unknown>
        const id = text(item.id).trim()
        const content = text(item.content).trim()
        const status = text(item.status)
        if (!id || !content) throw new Error(`第 ${index + 1} 项任务缺少 id 或 content`)
        if (seen.has(id)) throw new Error(`任务 id 重复：${id}`)
        if (!['pending', 'in_progress', 'completed'].includes(status)) {
          throw new Error(`第 ${index + 1} 项任务状态无效`)
        }
        seen.add(id)
        return {
          id,
          content,
          status: status as AgentTask['status']
        }
      })
      workflow.stage = 'execute'
      activeTasks = tasks
      send({
        requestId: request.requestId,
        type: 'tasks',
        tasks
      })
      const completed = tasks.filter((task) => task.status === 'completed').length
      return `任务清单已更新：${completed}/${tasks.length} 项完成\n${tasks
        .map((task) => `- [${task.status}] ${task.id}: ${task.content}`)
        .join('\n')}`
    }
  })

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
  const systemPrompt = [
    '执行控制最高优先级：只处理最后一个 <current_task>；禁止复盘、分析、续做或评价任何已完成历史请求。',
    '推理控制最高优先级：只进行完成当前任务所需的最短必要推理，确认目标后立即执行；禁止反复解释意图、复述历史、模拟多套方案、自我辩论或为了展示过程延长思考。',
    '编辑前置最高优先级：任何编辑现有文本文件的写入工具之前，必须先调用 read_file 读取同一路径并确认上下文；未读取时工具层会拒绝写入。',
    '用户编辑锁最高优先级：用户可能在你思考或等待确认期间亲自修改文件。工具若返回“用户编辑锁”，当前 edit 必须失败；必须按错误提示重新 read_file 读取用户修改区间，基于最新文本重新分析后才能发起新的 edit，严禁直接重试或覆盖用户改动。',
    '编辑工具最高优先级：完成 read_file 后，目标文件已存在且非空时，必须优先调用 replace_in_file；已知精确行号时可调用 replace_lines，仅插入内容时调用 insert_lines。create_file 仅可创建新文件或初始化已读取过的空文件，严禁用它编辑非空文件。',
    '资料检索优先规则：search_files 相当于 grep。已知目标文件或目录时传 path 限定范围；目标未知、需要查人物设定或跨文件关系时省略 path 进行全局搜索，由你根据任务自主决定。query 使用 a | b 表示 OR，a & b 表示同一文件内 AND。命中后调用 read_file 并传 around_line 与 context_lines 精准读取。已有用户选区、明确行号或可靠命中区间时，可直接 read_file 读取该区间上下文，但仍可继续检索。只有用户明确要求通读、总结、审查或重构全文，或局部区间无法满足任务时，才读取全文。',
    '选区锚点规则：<selected_code> 只提供初始定位锚点，绝不代表上下文或资料已经完整。必须先读取选区前后上下文，再根据任务自主判断是否需要 search_files 检索当前文件、其他文件、项目资料或会话历史；涉及外部事实、最新信息、陌生技术或本地资料不足时继续 search_web。严禁因用户提供选区而跳过必要检索，也严禁因选区存在而禁止联网。',
    requiresWritingLoreResearch
      ? '写作本地资料检索闸门已启用：本轮属于续写、改写、润色、文学细节纠错或人物设定修正。输出正文或编辑文件前，必须先用 search_files 检索本地项目资料；命中后必须用 read_file 读取命中行上下文。只有本地零命中或读取结果确实缺少目标设定时，才允许调用 search_web 查询原著或可靠公开资料。完成本地检索前严禁联网、补造设定、输出正文或修改文件。'
      : '',
    '未知知识检索规则：该规则同样适用于代码与普通问答。遇到模型训练资料中可能不存在、版本可能变化、记忆不确定、项目专有、第三方库或 API 行为不明确的事实，严禁凭印象猜测。先调用 search_files 检索本地项目文档、源码与配置；本地资料缺失或不足时必须调用 search_web。只有现有上下文已经给出可靠依据时才可跳过检索。',
    `创建与删除权限最高优先级：严禁根据用户措辞或安全关键词隐藏创建、复制或删除工具。create_file、create_directory、copy_path 与 delete_path 是否逐次审批由输入框“创建/删除确认”开关决定；当前开关为${request.confirmCreateDelete === false ? '关闭，允许按当前读写权限直接执行' : '开启，必须显示独立确认模块并等待用户允许'}。`,
    '专用工具规则：创建文件使用 create_file，创建目录使用 create_directory，复制使用 copy_path，删除使用 delete_path。严禁调用 run_command、Python、PowerShell、Shell、重定向或临时脚本绕过创建与删除确认模块。',
    'CWD 硬边界规则：全部文件工具只允许读取或操作当前工作区内部路径；绝对外部路径、父级穿越和借助符号链接越界都会由工具层拒绝。run_command 禁止切换出当前工作区，也禁止引用外部绝对路径、父级路径或用户目录变量。',
    '中文引号修复最高优先级：用户要求把英文双引号或英文单引号改成中文引号、修复小说引号、统一中文标点时，必须先 read_file 读取目标文件，再调用 normalize_chinese_quotes，禁止手动逐行替换或重写全文。',
    request.instructions,
    '你是运行在个人电脑中的星伴 AI。',
    `当前工作区：${request.workspaceRoot}`,
    `系统当前时间：${currentTime}（Asia/Shanghai）。回答日期、年龄、时效信息时必须以此时间为准，严禁把训练数据截止日期当作当前日期。`,
    '内部思考与向界面输出的可见推理过程默认使用简体中文；工具名、代码、路径与必要技术名词可保留原文。',
    '每轮都根据当前上下文自主判断：直接回复、继续思考、调用一个必要工具，或结束任务；禁止套用固定流程模板。',
    '自主决策规则：执行过程中禁止暂停任务向用户反问。遇到歧义时先检索本地资料与必要网页资料，再结合当前目标采用风险最低、最符合上下文的合理方案继续完整执行；确实无法可靠完成时，在最终回复中一次性说明缺失信息、已完成部分与建议，禁止用问题代替执行。',
    '当前任务边界规则：历史对话只用于参考用户偏好、既有结论、文件状态与未完成事项。历史中已经获得助手回复或工具结果的用户请求视为已处理，禁止重新分析、重新执行、重新总结，也禁止把旧请求并入当前任务。',
    '当前任务边界规则：只执行最后一个 <current_task> 中的目标。只有当前目标明确要求继续、复查或修正历史任务时，才允许恢复相关旧任务。',
    request.historyArchive?.length
      ? `会话历史规则：当前请求默认只直接携带本轮目标，不携带历史聊天原文；${request.historyArchive.length} 条历史记录在本机会话历史资料库中。若本轮目标可独立理解，禁止检索历史；若本轮只给出短回复，或出现“继续、刚才、上文、之前、这个、按你说的、照旧、他/她/它”等强依赖上文的表达，必须先调用 search_conversation_history 检索相关片段。禁止把旧任务拿出来重做。`
      : '',
    '先判断用户目标属于咨询解释、搜索定位、代码审查、运行验证、文件修改或综合任务，再选择最小必要动作。',
    '任务清单规则：Agent 模式必须在完成前建立可见 tasks；应先理解当前目标，再根据任务实际需要自主决定清单内容、粒度、顺序与状态。全部工具始终开放，tasks 只负责表达和同步执行判断，禁止用固定模板限制任务拆分。',
    '咨询解释任务：可直接回答；需要项目事实时只使用读取与搜索工具，禁止修改文件。',
    '搜索定位与代码审查任务：读取、搜索并给出结论；除非用户明确要求修复，否则禁止修改文件。',
    '运行验证任务：仅执行与目标直接相关的检查或测试，禁止顺手修改无关内容。',
    '文件修改任务：位置未知时先 search_files 定位行号，再调用 read_file 读取命中区间上下文；已有选区、明确行号或可靠命中位置时直接读取该区间上下文。读取后仍需判断是否检索其他文件或网页资料。已有非空文件默认先使用 replace_in_file 精准替换，搜索文本不唯一或已知行号时使用 replace_lines，仅新增片段时使用 insert_lines。简单修改直接执行，禁止先输出冗长计划。',
    '中文文稿规范化任务：若目标是修复英文双引号或英文单引号，先调用 read_file，再调用 normalize_chinese_quotes；该工具会跳过 Markdown 代码块、行内代码和英文单词撇号，禁止慢慢手工替换。',
    '用户没有表达创建、修改、修复、删除、移动或重命名意图时，不得调用任何写入类工具。',
    '工具只为完成目标服务，禁止为了展示流程而调用工具，禁止为了显得完整而强行编辑。',
    '联网判断规则：先完整阅读用户本轮问题与历史上下文；只有用户明确要求搜索、问题依赖最新信息，或关键事实无法从现有上下文可靠确定时才调用 search_web。严禁仅因消息较长、出现普通关键词或为了展示能力而联网。',
    '联网能力规则：search_web 与 fetch_webpage 当前真实可用；只要判断需要联网就必须直接调用，严禁声称无法联网、无法搜索、无法访问网页或无法调用工具，也禁止因自我怀疑放弃调用。',
    '实时网页结果规则：工具成功返回的网页正文属于程序在系统当前时间获取的运行时观察，不受模型训练截止日期限制；必须直接依据正文继续任务，禁止把训练记忆与网页日期不一致当成幻觉，禁止讨论结果是否像未来信息。',
    '本地工具调用格式：严格使用当前模型聊天模板提供的原生工具协议，函数名必须来自可用工具列表，参数语义与字段类型必须完全符合工具 JSON Schema。只调用完成目标所需的最少工具；彼此独立且确有必要时允许一次返回多个工具调用。严禁自行编造工具标签、把工具协议写进普通正文或返回空调用。',
    '失败熔断规则：工具失败后先读取真实错误并修正参数，禁止原样重复调用；任意工具连续失败三次时必须立即停止全部工具操作，向用户汇报失败工具、错误原因、已完成内容与未完成部分，禁止继续钻牛角尖。',
    `网页来源规则：${restrictedWebInstruction}`,
    restrictedWebHosts.length
      ? '网页事实核验规则：用户指定的网站是唯一允许来源；可读取该站多个页面，但不得引用站外搜索结果、百科、社区或媒体内容。'
      : '网页事实核验规则：search_web 会根据查询意图选择少量入口、本地排序并读取高相关正文。简单事实可使用一个可靠来源，时效或争议信息再交叉核对多个独立来源；只有资料缺口明确时才追加 fetch_webpage，禁止为了凑数量机械扩散网站。',
    restrictedWebHosts.length
      ? ''
      : '网页事实核验规则：回答人物、作品、日期、新闻、数据或其他可核实事实前，至少需要三个不同域名且与问题直接相关的来源正文。',
    restrictedWebHosts.length
      ? ''
      : '网页事实核验规则：来源应尽量覆盖官方或机构页面、百度百科或维基百科、专业资料站与 Reddit 或知乎等社区讨论；社区内容只能补充观点，不能单独作为事实结论。',
    '网页事实核验规则：必须比较来源中的关键姓名、标题、日期和数值；来源冲突时继续搜索，证据仍不足时明确说明无法确认，严禁根据常识或搜索摘要补写细节。',
    '网页事实核验规则：最终回答必须列出实际读取过的来源标题与直接网址，禁止引用必应或 DuckDuckGo 跳转链接。',
    'create_file 只用于创建新文件或初始化已读取过的已有空文件；已有非空文件必须使用 replace_in_file、replace_lines 或 insert_lines。',
    '每次修改尽量小，保持现有编码、换行、结构与风格。',
    `当前权限模式：${request.permissionMode || 'read-write-manual'}。只读模式禁止全部写入、创建、删除与命令；读写手动模式要求普通写入与命令逐次确认；读写自动模式允许普通写入自动执行。命令始终逐次确认；创建、复制与删除当前${request.confirmCreateDelete === false ? '允许自动执行' : '必须逐次确认'}。`,
    '执行完成后用简短中文总结结果、改动文件、行范围与验证情况。',
    '文件工具中的路径必须使用工作区相对路径。'
  ]
    .filter(Boolean)
    .join('\n')

  const skillInstructions = request.skills
    .filter((skill) => skill.enabled)
    .map(
      (skill) =>
        `\n<skill name="${skill.name}">\n说明：${skill.description}\n${skill.instructions}\n</skill>`
    )
    .join('\n')

  const attachmentText = request.attachments
    .filter((attachment) => attachment.kind === 'text' && attachment.text)
    .map(
      (attachment) =>
        `\n\n<attachment name="${attachment.name}">\n${attachment.text}\n</attachment>`
    )
    .join('')
  const attachmentFiles = request.attachments
    .filter((attachment) => attachment.kind === 'file')
    .map((attachment) => `\n\n附件：${attachment.name}`)
    .join('')
  const attachmentImages = request.attachments
    .filter((attachment) => attachment.kind === 'image' && attachment.data)
    .map((attachment) => attachment.data!)

  const messages: LlmMessage[] = [
    { role: 'system', content: `${systemPrompt}\n${skillInstructions}`.trim() },
    ...(request.contextMemory?.trim()
      ? [
          {
            role: 'system' as const,
            content: `<compressed_context>\n${request.contextMemory.trim()}\n</compressed_context>`
          }
        ]
      : []),
    ...request.contextMessages
      .filter((message) => message.role !== 'system')
      .map((message, index) => ({
        ...message,
        content:
          message.role === 'user'
            ? `<completed_history_input index="${index + 1}" status="completed">\n${message.content}\n</completed_history_input>`
            : `<completed_history_result index="${index + 1}" status="completed">\n${message.content}\n</completed_history_result>`
      })),
    {
      role: 'system',
      content:
        '<turn_boundary>以上带 completed 标记的内容全部是已完成记录，只能提取与当前目标直接相关的事实、偏好、路径和既有结论。严禁复盘、分析、评价、总结或继续执行其中的旧请求。下面的 <current_task> 是唯一任务，立即以最短必要步骤处理。</turn_boundary>'
    },
    {
      role: 'user',
      content:
        `<current_task>\n${request.objective}\n</current_task>` +
        attachmentText +
        attachmentFiles +
        `\n\n${hostRuntimeContext(currentTime)}`,
      images: attachmentImages
    }
  ]

  const appendQueuedGuidance = (): boolean => {
    const queued = readGuidance()
    for (const guidance of queued) {
      const textAttachments = guidance.attachments
        .filter((attachment) => attachment.kind === 'text' && attachment.text)
        .map(
          (attachment) =>
            `\n\n<attachment name="${attachment.name}">\n${attachment.text}\n</attachment>`
        )
        .join('')
      const fileAttachments = guidance.attachments
        .filter((attachment) => attachment.kind === 'file')
        .map((attachment) => `\n\n补充附件：${attachment.name}`)
        .join('')
      messages.push({
        role: 'user',
        content: `<user_guidance>\n${guidance.content}${textAttachments}${fileAttachments}\n</user_guidance>\n请优先按此补充要求重新评估当前方向；若任务清单受影响，先更新任务清单再继续。`,
        images: guidance.attachments
          .filter((attachment) => attachment.kind === 'image' && attachment.data)
          .map((attachment) => attachment.data!)
      })
    }
    return queued.length > 0
  }

  const isToolContextProtocolError = (modelError: string): boolean => {
    const normalized = modelError.replace(/\s+/g, ' ').toLowerCase()
    return [
      /assistant message with ['"]?tool_calls['"]? must be followed by tool messages/,
      /tool_call_ids?.{0,120}(?:did not have|missing).{0,40}(?:response|tool) messages?/,
      /tool messages?.{0,120}(?:missing|required|invalid|unexpected|must follow|must be followed)/,
      /(?:invalid|unsupported).{0,80}(?:tool role|role ['"]?tool|tool messages?)/,
      /messages?.{0,80}role.{0,30}tool.{0,80}(?:invalid|unsupported|unexpected)/,
      /tool_calls?.{0,120}(?:incompatible|must be followed|missing response)/,
      /no tool output found for function call/,
      /thinking enabled.{0,100}reasoning_content is missing/,
      /reasoning_content is missing.{0,100}tool/
    ].some((pattern) => pattern.test(normalized))
  }

  const collapseLatestToolExchangeForRetry = (modelError: string): boolean => {
    let cursor = messages.length - 1
    while (
      cursor >= 0 &&
      messages[cursor].role === 'user' &&
      messages[cursor].content.trimStart().startsWith('<runtime_web_status')
    ) {
      cursor -= 1
    }
    if (cursor < 0 || messages[cursor].role !== 'tool') return false
    const toolResults: LlmMessage[] = []
    while (cursor >= 0 && messages[cursor].role === 'tool') {
      toolResults.unshift(messages[cursor])
      cursor -= 1
    }
    const assistantMessage = messages[cursor]
    if (!assistantMessage || assistantMessage.role !== 'assistant' || !assistantMessage.tool_calls?.length) {
      return false
    }
    const callNames = assistantMessage.tool_calls
      .map((call) => {
        const item = call as { function?: { name?: unknown } }
        return typeof item.function?.name === 'string' ? item.function.name : ''
      })
      .filter(Boolean)
      .join('、')
    const collapsed = [
      '<tool_runtime_observation recovered_from_tool_role="true">',
      '模型服务拒绝继续读取上一轮结构化 tool 消息，程序已把工具结果转换为普通运行时观察继续任务。',
      callNames ? `上一轮工具：${callNames}` : '',
      `模型服务错误：${modelError.slice(0, 1200)}`,
      assistantMessage.content.trim()
        ? `工具调用前模型输出：\n${assistantMessage.content.slice(0, 4000)}`
        : '',
      ...toolResults.map(
        (message, index) => `工具结果 ${index + 1}：\n${message.content.slice(0, 8000)}`
      ),
      '请基于以上真实工具结果分析问题，修正参数或改用更稳的工具路径继续，禁止原样重复失败调用。',
      '</tool_runtime_observation>'
    ]
      .filter(Boolean)
      .join('\n\n')
    messages.splice(cursor, messages.length - cursor, {
      role: 'user',
      content: collapsed
    })
    return true
  }

  let invalidToolCallRetries = 0
  let invalidToolCorrection = ''
  let modelRequestFailures = 0
  let completionGuardRetries = 0
  let webSearchUsed = false
  let lastWebQuery = ''
  const verifiedWebHosts = new Set<string>()
  const verifiedReferenceHosts = new Set<string>()
  let webVerificationExhausted = false
  let webFailureStreak = 0
  let webFailureTotal = 0
  let webEmptyResultStreak = 0
  let blockedWebToolCalls = 0
  type KnowledgeResearchStage =
    | 'anchor-read'
    | 'local-search'
    | 'local-read'
    | 'web-search'
    | 'complete'
  const pendingAnchorPaths = new Set(selectedLineRanges.keys())
  let knowledgeResearchStage: KnowledgeResearchStage = pendingAnchorPaths.size
    ? 'anchor-read'
    : requiresWritingLoreResearch
      ? 'local-search'
      : 'complete'
  let forceToolNext = false
  let consecutiveToolFailures = 0
  const recentToolFailures: string[] = []
  type ReplaceRecovery = {
    path: string
    failedSearch: string
    failure: string
  }
  let replaceRecovery: ReplaceRecovery | null = null
  let replaceLinesFallbackPath = ''
  let replaceFailureGuidance = ''
  const failedReplaceSignatures = new Set<string>()
  const replaceSignature = (args: Record<string, unknown>): string =>
    JSON.stringify({
      path: normalizedWorkspacePath(text(args.path).trim()),
      search: text(args.search),
      replacement: text(args.replacement)
    })
  const toolPriority = new Map([
    ['search_files', 0],
    ['read_file', 1],
    ['replace_in_file', 2],
    ['replace_lines', 3],
    ['insert_lines', 4],
    ['normalize_chinese_quotes', 5],
    ['file_info', 6],
    ['search_conversation_history', 7],
    ['create_file', 90]
  ])
  const pendingAnchorDescription = (): string =>
    [...selectedLineRanges.values()]
      .filter((range) => {
        try {
          return pendingAnchorPaths.has(normalizedWorkspacePath(range.path))
        } catch {
          return false
        }
      })
      .map((range) => `${range.path} 第 ${range.startLine}-${range.endLine} 行`)
      .join('、')
  const buildModelToolDefinitions = (): ToolDefinition[] => {
    return [...tools.entries()]
      .sort(
        ([leftName], [rightName]) =>
          (toolPriority.get(leftName) ?? 20) - (toolPriority.get(rightName) ?? 20)
      )
      .map(([, tool]) => tool.definition)
  }
  let step = 0
  while (!signal.aborted) {
    step += 1
    if (signal.aborted) throw new Error('任务已停止')
    appendQueuedGuidance()
    if (workflow.stage === 'understand') forceToolNext = false
    if (workflow.stage === 'tasks') forceToolNext = true

    const toolChoice = workflow.stage === 'understand' ? 'auto' : forceToolNext ? 'required' : 'auto'
    forceToolNext = false
    const editToolsNeedRead = readFilePaths.size === 0
    const runtimeSystemMessages: LlmMessage[] = [
      ...(activeTasks.length
        ? [
            {
              role: 'system' as const,
              content: `当前任务清单属于不可丢失的执行锚点，压缩历史后仍须继续维护：\n${activeTasks
                .map((task) => `- [${task.status}] ${task.id}: ${task.content}`)
                .join('\n')}`
            }
          ]
        : []),
      ...(editToolsNeedRead
        ? [
            {
              role: 'system' as const,
              content:
                '编辑工具前置条件：完整工具集已经开放，但修改现有文件前仍必须先用 read_file 读取同一路径的最新目标区间，否则工具层会返回明确失败。search_files 始终可用且检索优先级高于 read_file；优先像 grep 一样定位关键词与行号，再读取目标区间上下文。已知用户选区时可直接读取选区上下文，也可继续检索其他文件或网页资料。'
            }
          ]
        : []),
      ...(invalidToolCorrection
        ? [{ role: 'system' as const, content: invalidToolCorrection }]
        : []),
      ...(replaceRecovery
        ? [
            {
              role: 'system' as const,
                content: `replace_in_file 恢复建议：刚才对 ${replaceRecovery.path} 的精确匹配失败。完整工具集仍然可用；建议先用 search_files 定位最新文本，再用 read_file 读取同一文件的最新目标区间，也可依据任务选择其他有效工具。禁止再次提交完全相同的失败参数。失败原因：${replaceRecovery.failure}`
            }
          ]
        : replaceLinesFallbackPath
          ? [
              {
                role: 'system' as const,
                content: `replace_in_file 重复参数已被拦截。完整工具集仍然可用；若最新行号已经明确，优先用 replace_lines 修改 ${replaceLinesFallbackPath}，也可重新检索或读取后构造新的精准参数。`
              }
            ]
          : replaceFailureGuidance
            ? [{ role: 'system' as const, content: replaceFailureGuidance }]
            : []),
      ...(knowledgeResearchStage !== 'complete'
        ? [
            {
              role: 'system' as const,
              content:
                knowledgeResearchStage === 'anchor-read'
                  ? `当前选区锚点建议：用户选区只负责定位当前问题，不代表资料完整。完整工具集始终可用；需要定位关键词、同义表达或跨文件资料时优先 search_files，已知目标区间时可用 read_file 读取 ${pendingAnchorDescription()} 的前后上下文。若未显式提供范围，程序会自动扩展选区前后各约 50 行。请根据当前子任务自主选择工具，严禁声称工具不可用。`
                  : knowledgeResearchStage === 'local-search'
                  ? '当前资料建议：本轮可能涉及人物、服装形象、关系、武学、门派、情节或其他关键设定，优先用 search_files 检索本地项目资料。完整工具集始终可用，请根据当前子任务自主选择；严禁声称编辑或其他工具不可用。'
                  : knowledgeResearchStage === 'local-read'
                    ? '当前资料建议：优先用 read_file 读取 search_files 命中的文件与行号，推荐 around_line 加 context_lines=50；命中不够精准时可继续 search_files，也可根据当前子任务调用其他工具。完整工具集始终可用。'
                    : '本地资料未命中。若任务仍依赖外部人物、武学或既有设定，建议调用 search_web 并带上准确名称与作品名；完整工具集始终可用，请根据当前子任务自主选择。'
            }
          ]
        : []),
      ...(workflow.stage === 'understand'
        ? [
            {
              role: 'system' as const,
              content:
                '当前建议先理解任务：完整阅读本轮 current_task、用户选区、附件与可用上下文，用简体中文明确目标、关键约束、已知信息与可验证完成标准。全部工具从首轮起均已开放；若理解任务确实需要检索、读取或核验，可自主调用合适工具。尚未形成可靠理解前不要制定 tasks，也不要输出最终回复。'
            }
          ]
        : workflow.stage === 'tasks'
          ? [
              {
                role: 'system' as const,
                content:
                  '当前建议依据已经形成的任务理解调用 update_tasks 建立清单。清单内容、粒度、顺序与状态由你依据当前任务自主决定，不套用固定模板。全部工具仍然开放；若仍需补充检索、读取或核验，可自主调用，但完成 Agent 任务前必须建立 tasks。'
              }
            ]
          : [])
    ]
    const requestMessages: LlmMessage[] = [
      messages[0],
      ...runtimeSystemMessages,
      ...messages.slice(1)
    ]
    const modelToolDefinitions = buildModelToolDefinitions()
    let streamedReasoning = false
    let streamedContent = false
    let completion: Awaited<ReturnType<typeof completeWithTools>>
    try {
      completion = await completeWithTools(
        request.model,
        requestMessages,
        modelToolDefinitions,
        signal,
        toolChoice,
        (content) => {
          streamedReasoning = true
          send({
            requestId: request.requestId,
            type: 'reasoning',
            title: workflow.stage === 'understand' ? '理解任务' : '思考',
            content
          })
        },
        (content) => {
          streamedContent = true
          if (workflow.stage !== 'execute') {
            send({
              requestId: request.requestId,
              type: 'reasoning',
              title: workflow.stage === 'understand' ? '理解任务' : '制定任务',
              content
            })
          } else {
            send({
              requestId: request.requestId,
              type: 'chunk',
              content
            })
          }
        }
      )
      modelRequestFailures = 0
    } catch (error) {
      if (signal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      modelRequestFailures += 1
      if (
        modelRequestFailures <= 2 &&
        isToolContextProtocolError(message) &&
        collapseLatestToolExchangeForRetry(message)
      ) {
        send({
          requestId: request.requestId,
          type: 'status',
          title: `模型服务拒绝工具上下文，转换后重试 ${modelRequestFailures}/2`,
          content: `检测到明确的工具协议兼容错误，已把上一轮工具结果转换为普通运行时观察后重试。\n\n原始错误：${message.slice(0, 1600)}`
        })
        forceToolNext = false
        continue
      }
      if (modelRequestFailures <= 2) {
        messages.push({
          role: 'user',
          content: `<runtime_model_error>\n模型服务本轮请求失败：${message.slice(0, 2000)}\n请缩短思考，避免重复失败格式；若刚才工具失败，请修正参数或改用更稳路径继续。\n</runtime_model_error>`
        })
        send({
          requestId: request.requestId,
          type: 'status',
          title: `错误：模型请求失败 · 重试 ${modelRequestFailures}/2`,
          content: message.slice(0, 2000)
        })
        forceToolNext = false
        continue
      }
      send({
        requestId: request.requestId,
        type: 'message',
        content: `模型服务连续失败，任务已安全停止。最后错误：${message.slice(0, 2000)}`
      })
      send({
        requestId: request.requestId,
        type: 'done',
        title: '模型连续失败，已安全终止',
        changes: [...changes.values()],
        usage: totalUsage
      })
      return
    }
    if (completion.contextMemory) {
      applyCompressionMemory(messages, completion.contextMemory)
      send({
        requestId: request.requestId,
        type: 'context',
        contextMemory: completion.contextMemory
      })
    }
    totalUsage = addUsage(totalUsage, completion.usage)
    send({
      requestId: request.requestId,
      type: 'context',
      usage: totalUsage,
      contextState: {
        usedTokens: completion.contextTokens,
        limitTokens: request.model.contextLength || 8192,
        estimated: completion.contextEstimated,
        compressed: completion.compressed,
        updatedAt: Date.now()
      }
    })
    if (!streamedReasoning && completion.reasoning?.trim()) {
      send({
        requestId: request.requestId,
        type: 'reasoning',
        title: workflow.stage === 'understand' ? '理解任务' : '思考',
        content: completion.reasoning
      })
    }
    const missingStructuredToolCall =
      completion.finishReason === 'tool_calls' && completion.toolCalls.length === 0
    const emptyCompletion =
      completion.toolCalls.length === 0 &&
      completion.content.trim().length === 0 &&
      (completion.reasoning?.trim().length ?? 0) === 0
    if (missingStructuredToolCall || emptyCompletion) {
      invalidToolCallRetries += 1
      const finishReason = completion.finishReason || '未提供'
      const directError = missingStructuredToolCall
        ? `模型接口返回 finish_reason=${finishReason}，但 tool_calls 数组为空，无法取得函数名与参数`
        : `模型接口返回空响应：finish_reason=${finishReason}，正文 0 字符，工具调用 0 项`
      send({
        requestId: request.requestId,
        type: 'status',
        title: `${missingStructuredToolCall ? '错误：模型返回空工具调用' : '错误：模型返回空响应'} · 重试 ${invalidToolCallRetries}/3`,
        content: `${directError}\n正文字符：${completion.content.length}；思考字符：${completion.reasoning?.length ?? 0}。程序将要求模型重新生成合法函数名与完整 JSON 参数。`
      })
      if (invalidToolCallRetries >= 3) {
        send({
          requestId: request.requestId,
          type: 'message',
          content:
            'Agent 连续三次生成无效工具调用，已停止继续尝试，避免陷入重复循环。当前任务未能完成；请检查 LM Studio 的工具调用模板，或调整目标后重试。'
        })
        send({
          requestId: request.requestId,
          type: 'done',
          title: '连续失败，任务已安全终止',
          changes: [...changes.values()],
          usage: totalUsage
        })
        return
      }
      invalidToolCorrection = `纠错要求：上一次模型响应失败，具体错误为“${directError}”。必须只调用一个最相关工具，函数名必须来自 tools，arguments 必须是严格 JSON 对象并完全符合参数定义。若任务无需工具，必须输出明确中文结论，禁止返回空内容。`
      forceToolNext = true
      continue
    }
    if (appendQueuedGuidance()) {
      forceToolNext = false
      continue
    }
    invalidToolCallRetries = 0
    invalidToolCorrection = ''
    if (workflow.stage === 'understand' && completion.toolCalls.length === 0) {
      const understanding = completion.content.trim() || completion.reasoning?.trim() || ''
      if (!understanding) {
        messages.push({
          role: 'user',
          content:
            '<runtime_workflow_stage>任务理解内容为空。请重新阅读当前任务，只输出目标、约束、已知信息和完成标准；禁止调用工具或制定 tasks。</runtime_workflow_stage>'
        })
        continue
      }
      messages.push({
        role: 'assistant',
        content: `【任务理解】\n${understanding}`
      })
      messages.push({
        role: 'user',
        content:
          '<runtime_workflow_stage>任务理解已完成。现在依据上一条任务理解优先调用 update_tasks 制定精简任务清单；全部工具仍然开放，确需补充事实时可自主调用。</runtime_workflow_stage>'
      })
      workflow.stage = 'tasks'
      forceToolNext = true
      continue
    }
    const toolArgumentNotes = new Map<string, string>()
    const toolPresentationArguments = new Map<string, Record<string, unknown>>()
    for (const call of completion.toolCalls) {
      const normalized = await normalizeToolCallArguments(call.name, call.arguments)
      call.arguments = normalized.arguments
      if (normalized.note) toolArgumentNotes.set(call.id, normalized.note)
      toolPresentationArguments.set(call.id, normalized.presentation ?? normalized.arguments)
    }
    if (completion.toolCalls.length > 0) {
      completion.rawMessage.tool_calls = completion.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }))
    }
    messages.push(completion.rawMessage)

    if (completion.toolCalls.length === 0) {
      if (workflow.stage === 'tasks') {
        messages.push({
          role: 'user',
          content:
            '<runtime_workflow_stage>当前仍处于任务清单阶段。禁止输出正文，必须立即调用 update_tasks，并提交完整任务数组。</runtime_workflow_stage>'
        })
        forceToolNext = true
        continue
      }
      const refusedAvailableWeb =
        !webSearchUsed &&
        /(?:无法|不能|不具备|没法).{0,18}(?:联网|搜索|网页|调用.{0,8}工具|访问.{0,8}互联网)/i.test(
          completion.content
        )
      if (refusedAvailableWeb) {
        messages.push({
          role: 'user',
          content:
            '系统纠正：网页工具当前真实可用。你刚才错误地声称无法联网；既然你已经判断需要网页信息，现在必须立即调用 search_web，不要继续解释能力限制。'
        })
        forceToolNext = true
        continue
      }
      const incompleteTasks = activeTasks.filter((task) => task.status !== 'completed')
      const missingEditEvidence = requiresWorkspaceEdit && changes.size === 0
      if (incompleteTasks.length > 0 || missingEditEvidence) {
        completionGuardRetries += 1
        if (completionGuardRetries <= 3) {
          messages.push({
            role: 'user',
            content: [
              '<runtime_completion_guard>',
              missingEditEvidence
                ? '用户要求修改文件，但当前尚未产生任何真实文件改动。禁止结束任务，必须继续调用读取与精准编辑工具完成实际修改。'
                : '',
              incompleteTasks.length
                ? `任务清单仍有 ${incompleteTasks.length} 项未完成：${incompleteTasks
                    .map((task) => `${task.id}:${task.content}`)
                    .join('；')}。完成真实工作后必须调用 update_tasks 同步状态，禁止由程序伪造完成。`
                : '',
              '</runtime_completion_guard>'
            ]
              .filter(Boolean)
              .join('\n')
          })
          forceToolNext = true
          continue
        }
        send({
          requestId: request.requestId,
          type: 'message',
          content:
            'Agent 连续尝试结束任务，但真实文件改动或任务状态仍未满足完成条件；程序已保留真实进度，并停止伪造完成。'
        })
        send({
          requestId: request.requestId,
          type: 'done',
          title: '任务未完成',
          changes: [...changes.values()],
          usage: totalUsage
        })
        return
      }
      completionGuardRetries = 0
      if (completion.content.trim() && !streamedContent) {
        send({
          requestId: request.requestId,
          type: 'message',
          content: completion.content
        })
      }
      send({
        requestId: request.requestId,
        type: 'done',
        title: '任务完成',
        changes: [...changes.values()],
        usage: totalUsage
      })
      return
    }

    if (workflow.stage === 'execute' && completion.content.trim() && !streamedContent) {
      send({
        requestId: request.requestId,
        type: 'message',
        content: completion.content
      })
    }

    let restartAfterReplaceRecovery = false
    for (let callIndex = 0; callIndex < completion.toolCalls.length; callIndex += 1) {
      const call = completion.toolCalls[callIndex]
      if (signal.aborted) throw new Error('任务已停止')
      const tool = tools.get(call.name)
      const argumentError = validateToolCallArguments(call.name, call.arguments)
      const presentationArguments = toolPresentationArguments.get(call.id) ?? call.arguments
      const description = argumentError
        ? {
            title: `${call.name || '未知工具'} · 参数缺失`,
            detail: argumentError
          }
        : describeToolCall(call.name, presentationArguments)
      const argumentNote = toolArgumentNotes.get(call.id)
      send({
        requestId: request.requestId,
        type: 'tool',
        title: description.title,
        content: argumentNote ? `${argumentNote}\n${description.detail}` : description.detail,
        toolName: call.name,
        toolArgs: call.arguments
      })
      let result: string
      let toolSucceeded = false
      let preview: AgentChange[] | undefined
      let duplicateReplaceBlocked = false
      try {
        if (argumentError) throw new Error(argumentError)
        if (
          call.name === 'replace_in_file' &&
          failedReplaceSignatures.has(replaceSignature(call.arguments))
        ) {
          duplicateReplaceBlocked = true
          throw new Error(
            `replace_in_file 已拦截完全相同的失败参数：${text(call.arguments.path)}。必须重新读取最新原文并修改 search；若行号明确，请改用 replace_lines。`
          )
        }
        if (webVerificationExhausted && isWebTool(call.name)) {
          blockedWebToolCalls += 1
          throw new Error(
            '网页工具已因连续解析失败停止。请基于已读取内容直接回答；证据不足时说明无法完成可靠核验。'
          )
        }
        if (!tool) throw new Error(`未知工具：${call.name}`)
        const permissionMode = request.permissionMode || 'read-write-manual'
        if (permissionMode === 'read-only' && tool.risk !== 'read') {
          result = '权限已阻止：当前会话为只读模式，请仅分析并向用户说明需要执行的操作'
        } else {
          const needsApproval =
            (tool.risk === 'write' && permissionMode === 'read-write-manual') ||
            ((tool.risk === 'create' || tool.risk === 'delete') &&
              request.confirmCreateDelete !== false) ||
            tool.risk === 'command'
          preview = tool.preview ? await tool.preview(call.arguments) : undefined
          if (needsApproval) {
            const approvalRisk = tool.risk as 'write' | 'create' | 'delete' | 'command'
            const approvalTitle = {
              write: '确认文件修改',
              create: '确认创建内容',
              delete: '确认删除内容',
              command: '确认执行命令'
            }[approvalRisk]
            const approvalDescription = {
              write: `修改范围：${preview?.length || 0} 个文件`,
              create: `创建范围：${preview?.length || 0} 个路径`,
              delete: `删除范围：${preview?.length || 0} 个路径`,
              command: `待确认命令：${call.name}`
            }[approvalRisk]
            const approval: AgentApproval = {
              requestId: request.requestId,
              approvalId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              title: approvalTitle,
              description: approvalDescription,
              toolName: call.name,
              toolArgs: call.arguments,
              risk: approvalRisk,
              changes: preview
            }
            const approved = await requestApproval(approval)
            if (!approved) {
              result = '用户拒绝了本次操作，请调整方案或跳过此步骤'
            } else {
              result = await tool.execute(call.arguments, preview)
              toolSucceeded = true
            }
          } else {
            result = await tool.execute(call.arguments, preview)
            toolSucceeded = true
          }
        }
      } catch (error) {
        result = `工具执行失败：${error instanceof Error ? error.message : String(error)}`
      }
      const searchReturnedNoEvidence =
        call.name === 'search_web' && webSearchReturnedNoEvidence(result)
      if (result.startsWith('工具执行失败：')) {
        consecutiveToolFailures += 1
        recentToolFailures.push(`${call.name}：${result.slice('工具执行失败：'.length)}`)
        if (recentToolFailures.length > 3) recentToolFailures.shift()
      } else if (toolSucceeded) {
        consecutiveToolFailures = 0
        recentToolFailures.length = 0
      }
      const replaceMatchFailed =
        call.name === 'replace_in_file' &&
        result.includes('replace_in_file 匹配失败：')
      if (replaceMatchFailed) {
        const relative = text(call.arguments.path).trim()
        const failedSearch = text(call.arguments.search)
        failedReplaceSignatures.add(replaceSignature(call.arguments))
        replaceRecovery = {
          path: relative,
          failedSearch,
          failure: result.slice('工具执行失败：'.length, 2400)
        }
        replaceFailureGuidance = [
          `replace_in_file 纠错约束：${relative} 最近一次精确匹配失败。`,
          '禁止再次提交完全相同的 path、search、replacement 参数。',
          '必须依据最新 read_file 返回内容重新构造 search；search 需要去掉行号与分隔符，并保留原始空格、换行及引号。',
          '若准确行号已经明确，优先改用 replace_lines 完成修改。'
        ].join('\n')
        restartAfterReplaceRecovery = true
        forceToolNext = true
      }
      if (duplicateReplaceBlocked) {
        replaceLinesFallbackPath = text(call.arguments.path).trim()
        replaceFailureGuidance = `replace_in_file 的同一组失败参数已被程序拦截。必须调用 replace_lines，依据最新 read_file 结果提供准确的 start_line、end_line 与 content，目标文件：${replaceLinesFallbackPath}。`
        restartAfterReplaceRecovery = true
        forceToolNext = true
      }
      const recoveredReplacePath = replaceRecovery?.path
      if (
        toolSucceeded &&
        call.name === 'read_file' &&
        recoveredReplacePath &&
        normalizedWorkspacePath(text(call.arguments.path).trim()) ===
          normalizedWorkspacePath(recoveredReplacePath)
      ) {
        replaceRecovery = null
        restartAfterReplaceRecovery = true
        forceToolNext = false
      }
      if (
        toolSucceeded &&
        call.name === 'replace_lines' &&
        replaceLinesFallbackPath &&
        normalizedWorkspacePath(text(call.arguments.path).trim()) ===
          normalizedWorkspacePath(replaceLinesFallbackPath)
      ) {
        replaceLinesFallbackPath = ''
        replaceFailureGuidance = ''
      }
      if (webVerificationExhausted && isWebTool(call.name) && blockedWebToolCalls >= 2) {
        send({
          requestId: request.requestId,
          type: 'message',
          content: `网页解析连续失败，已安全停止网页工具循环。已读取 ${verifiedWebHosts.size} 个独立来源，其中 ${verifiedReferenceHosts.size} 个非社区来源；当前证据不足，无法给出可靠网页核验结论。`
        })
        send({
          requestId: request.requestId,
          type: 'done',
          title: '任务完成',
          changes: [...changes.values()],
          usage: totalUsage
        })
        return
      }
      if (toolSucceeded && call.name === 'search_web') {
        webSearchUsed = true
        lastWebQuery = text(call.arguments.query)
        if (searchReturnedNoEvidence) {
          webEmptyResultStreak += 1
        } else {
          webEmptyResultStreak = 0
        }
        for (const match of result.matchAll(/^地址：(.+)$/gm)) {
          try {
            const url = match[1].trim()
            const hostname = new URL(url).hostname.toLocaleLowerCase()
            verifiedWebHosts.add(hostname)
            if (webSourceKind(url) !== '社区讨论') {
              verifiedReferenceHosts.add(hostname)
            }
          } catch {
            // Ignore malformed source lines from third-party pages.
          }
        }
      }
      if (toolSucceeded && call.name === 'fetch_webpage') {
        try {
          if (lastWebQuery && !webContentMatchesQuery(lastWebQuery, result)) {
            toolSucceeded = false
            result = `网页相关性校验失败：正文与搜索关键词“${lastWebQuery}”缺少足够匹配，不能计入有效来源。\n\n${result.slice(0, 2000)}`
          }
          if (!toolSucceeded) throw new Error('相关性不足')
          const url = result.match(/^地址：(.+)$/m)?.[1]?.trim() || text(call.arguments.url)
          const hostname = new URL(url).hostname.toLocaleLowerCase()
          verifiedWebHosts.add(hostname)
          if (webSourceKind(url) !== '社区讨论') verifiedReferenceHosts.add(hostname)
        } catch {
          // Invalid URLs are already rejected by the tool.
        }
      }
      if (isWebTool(call.name)) {
        if (webInfrastructureFailed(result) && !webVerificationExhausted) {
          webVerificationExhausted = true
          webSearchUsed = true
          knowledgeResearchStage = 'complete'
          send({
            requestId: request.requestId,
            type: 'status',
            title: '网页网络故障，停止重复搜索',
            content: `当前网络通道：${lastResolvedWebProxy}`
          })
          messages[0] = {
            ...messages[0],
            content: `${messages[0].content}\n\n网页请求已确认发生代理、DNS 或基础网络故障。禁止更换关键词重复调用 search_web 或 fetch_webpage；请基于已经取得的本地资料完成仍可完成的部分，并在最终回复中简明说明网络故障。`
          }
        }
        if (webToolFailed(result)) {
          webFailureStreak += 1
          webFailureTotal += 1
        } else if (toolSucceeded) {
          webFailureStreak = 0
        }
        if (!webVerificationExhausted && (webFailureStreak >= 2 || webFailureTotal >= 3)) {
          webVerificationExhausted = true
          send({
            requestId: request.requestId,
            type: 'status',
            title: '网页解析失败过多，停止循环',
            content:
              '网页工具连续失败，Agent 将停止继续调用网页工具，改为说明已读来源、失败原因与证据缺口'
          })
          messages[0] = {
            ...messages[0],
            content: `${messages[0].content}\n\n网页工具已连续解析失败。禁止继续调用 search_web 或 fetch_webpage；请直接说明当前无法完成可靠网页核验，并列出已成功读取的来源与失败原因。`
          }
        }
      }
      messages.push({
        role: 'tool',
        content: result,
        tool_call_id: call.id
      })
      if (replaceMatchFailed) {
        messages.push({
          role: 'user',
          content: `<runtime_replace_recovery path="${text(call.arguments.path)}">精确替换失败，文件未修改。下一步必须重新调用 read_file 读取同一文件的最新目标区间；读取前禁止再次编辑。读取后从工具返回的真实原文逐字构造新的 search，或在行号明确时改用 replace_lines。禁止重复上一组参数。</runtime_replace_recovery>`
        })
      } else if (duplicateReplaceBlocked) {
        messages.push({
          role: 'user',
          content: `<runtime_replace_recovery path="${text(call.arguments.path)}" fallback="replace_lines">完全相同的失败参数已被拦截。下一步必须只调用 replace_lines，并依据最新 read_file 返回的行号提供准确区间与完整替换内容。</runtime_replace_recovery>`
        })
      } else if (
        toolSucceeded &&
        call.name === 'read_file' &&
        recoveredReplacePath
      ) {
        messages.push({
          role: 'user',
          content: `<runtime_replace_recovery path="${recoveredReplacePath}" refreshed="true">目标文件已经重新读取。现在必须基于上一条最新工具结果修正参数：禁止使用此前失败的 search；精确文本唯一时调用 replace_in_file，行号明确时调用 replace_lines。</runtime_replace_recovery>`
        })
      }
      if (
        toolSucceeded &&
        knowledgeResearchStage === 'anchor-read' &&
        call.name === 'read_file'
      ) {
        pendingAnchorPaths.delete(normalizedWorkspacePath(text(call.arguments.path).trim()))
        if (pendingAnchorPaths.size > 0) {
          forceToolNext = true
          messages.push({
            role: 'user',
            content: `<runtime_anchor_context pending="${pendingAnchorPaths.size}">已读取一个用户选区的上下文，仍有选区锚点待读取。下一步继续调用 read_file；完成全部锚点读取后再判断本地检索或网页检索。</runtime_anchor_context>`
          })
        } else if (requiresWritingLoreResearch) {
          knowledgeResearchStage = 'local-search'
          forceToolNext = true
          messages.push({
            role: 'user',
            content:
              '<runtime_anchor_context complete="true">用户选区上下文已读取。选区只是当前问题锚点；本轮属于写作或设定修正，下一步继续调用 search_files 检索本地人物、武学、关系、情节或其他相关设定，禁止直接编辑或联网。若本地资料不足，读取命中上下文后再决定 search_web。</runtime_anchor_context>'
          })
        } else {
          knowledgeResearchStage = 'complete'
          messages.push({
            role: 'user',
            content:
              '<runtime_anchor_context complete="true">用户选区上下文已读取。现在根据任务真实信息缺口自主决策：上下文充分时继续完成目标；需要跨文件关系、项目专有资料或同类实现时调用 search_files；涉及外部事实、最新信息、陌生技术或本地资料不足时调用 search_web。严禁把选区视为禁止检索。</runtime_anchor_context>'
          })
        }
      } else if (
        toolSucceeded &&
        knowledgeResearchStage === 'local-search' &&
        call.name === 'search_files'
      ) {
        if (
          result.trim() === '[]' ||
          /"matches"\s*:\s*\[\s*\]/.test(result)
        ) {
          knowledgeResearchStage = 'web-search'
          forceToolNext = true
          messages.push({
            role: 'user',
            content:
              '<runtime_research_gate local_hits="0">本地项目资料零命中。下一步必须调用 search_web 查询对应人物、武学与作品设定，禁止自行补造。</runtime_research_gate>'
          })
        } else {
          knowledgeResearchStage = 'local-read'
          forceToolNext = true
          messages.push({
            role: 'user',
            content:
              '<runtime_research_gate local_hits="found">本地检索已有命中。下一步必须调用 read_file 读取最相关命中行上下各 50 行，再判断资料是否足够。</runtime_research_gate>'
          })
        }
      } else if (
        toolSucceeded &&
        knowledgeResearchStage === 'local-read' &&
        call.name === 'read_file'
      ) {
        knowledgeResearchStage = 'complete'
        messages.push({
          role: 'user',
          content:
            '<runtime_research_gate source="local">本地设定资料已读取。后续写作必须严格依据该工具结果；若读取内容仍缺少当前人物或武学的关键设定，必须先调用 search_web，严禁猜测或补造。</runtime_research_gate>'
        })
      } else if (
        toolSucceeded &&
        knowledgeResearchStage === 'web-search' &&
        call.name === 'search_web' &&
        !searchReturnedNoEvidence
      ) {
        knowledgeResearchStage = 'complete'
      }
      if (toolSucceeded && call.name === 'search_web') {
        if (searchReturnedNoEvidence) {
          if (webEmptyResultStreak < 2) {
            forceToolNext = true
            messages.push({
              role: 'user',
              content:
                '<runtime_web_status evidence="empty">网络入口正常，但查询把互不相属的实体或限定词混在一起，未获得可用证据。请根据用户原始目标拆分人物、作品与事实，用明显不同且更准确的关键词重试一次，禁止原样重复。</runtime_web_status>'
            })
          } else {
            knowledgeResearchStage = 'complete'
            webVerificationExhausted = true
            messages.push({
              role: 'user',
              content:
                '<runtime_web_status evidence="empty" exhausted="true">两次不同查询均未获得相关证据。停止继续扩散网页搜索；请回到本地资料与用户给定上下文完成可确认部分，并明确说明外部证据缺口，禁止把零结果伪装成网络故障。</runtime_web_status>'
            })
          }
        } else {
          messages.push({
            role: 'user',
            content: `<runtime_web_status fetched_at="${currentTime}">search_web 已由程序真实执行成功。上一条 tool 消息包含实时网页正文。请直接依据查询结果继续完成目标；禁止用训练截止日期质疑、否定或覆盖工具结果，禁止输出“可能是幻觉”之类的判断。</runtime_web_status>`
          })
        }
      }
      if (toolSucceeded && (tool?.risk === 'write' || tool?.risk === 'create')) {
        await appendPostEditReview(preview)
      }
      send({
        requestId: request.requestId,
        type: 'tool',
        title: `${description.title} · ${toolSucceeded ? '成功' : '失败'}`,
        toolName: call.name,
        content: toolResultPreview(result)
      })
      if (consecutiveToolFailures >= 3) {
        send({
          requestId: request.requestId,
          type: 'status',
          title: '工具连续失败三次，停止继续尝试',
          content: '已触发失败熔断，Agent 不再重复调用工具'
        })
        send({
          requestId: request.requestId,
          type: 'message',
          content: [
            '工具连续失败三次，任务已安全终止，避免继续钻牛角尖。',
            '',
            '最近失败：',
            ...recentToolFailures.map((failure) => `- ${failure}`),
            '',
            '当前已完成的改动会保留；未完成部分请根据失败原因调整环境或任务要求后再继续。'
          ].join('\n')
        })
        send({
          requestId: request.requestId,
          type: 'done',
          title: '连续失败，任务已安全终止',
          changes: [...changes.values()],
          usage: totalUsage
        })
        return
      }
      if (restartAfterReplaceRecovery) {
        for (const skippedCall of completion.toolCalls.slice(callIndex + 1)) {
          messages.push({
            role: 'tool',
            content:
              '工具调用已取消：replace_in_file 进入纠错恢复流程，必须先重新读取目标文件并依据最新原文修正参数。',
            tool_call_id: skippedCall.id
          })
        }
        break
      }
    }
    if (restartAfterReplaceRecovery) continue
  }

  throw new Error('任务已停止')
}
