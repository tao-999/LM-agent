import {
  Children,
  isValidElement,
  memo,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  AtSign,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  Code2,
  Copy,
  Download,
  ExternalLink,
  File,
  FilePlus2,
  FolderOpen,
  GitCompareArrows,
  Globe2,
  History,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquareText,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Search as SearchIcon,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Virtuoso, type ListRange, type VirtuosoHandle } from 'react-virtuoso'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import type {
  AgentApproval,
  ChatContextMessage,
  AgentExecutionBlock,
  AgentPermissionMode,
  ChatAttachment,
  ChatMessage,
  ComfyWorkflowInspection,
  ConversationMode,
  FileNode,
  ModelOption
} from '../../../shared/types'
import { markdownKatexOptions, normalizeMarkdownMath } from '../markdown'
import { useAppStore } from '../store'

const uid = (): string => crypto.randomUUID()
const HISTORY_ARCHIVE_MESSAGE_LIMIT = 200
const HISTORY_ARCHIVE_CONTENT_LIMIT = 12000
const USER_MESSAGE_COLLAPSE_CHARACTERS = 720
const USER_MESSAGE_COLLAPSE_HEIGHT = 280
const LONG_PASTE_ATTACHMENT_THRESHOLD = 4_000
const MAX_MESSAGE_ATTACHMENTS = 12
const KIMI_CODE_MODELS: ModelOption[] = [
  {
    id: 'kimi-code:standard',
    name: 'kimi-for-coding',
    provider: 'openai',
    baseUrl: 'https://api.kimi.com/coding/v1',
    source: 'Kimi Code',
    preset: 'kimi-code',
    contextLength: 262144,
    maxContextLength: 262144
  },
  {
    id: 'kimi-code:highspeed',
    name: 'kimi-for-coding-highspeed',
    provider: 'openai',
    baseUrl: 'https://api.kimi.com/coding/v1',
    source: 'Kimi Code',
    preset: 'kimi-code',
    contextLength: 262144,
    maxContextLength: 262144
  }
]

type MentionEntry = {
  path: string
  root: string
  name: string
  label: string
}

type MessageAttachment = NonNullable<ChatMessage['attachments']>[number]

function flattenFiles(root: string, nodes: FileNode[], prefix = ''): MentionEntry[] {
  const result: MentionEntry[] = []
  const rootName = root.split(/[\\/]/).pop() || root
  for (const node of nodes) {
    const relative = prefix ? `${prefix}/${node.name}` : node.name
    if (node.kind === 'file') {
      result.push({
        path: node.path,
        root,
        name: node.name,
        label: `${rootName}/${relative}`
      })
    } else {
      result.push(...flattenFiles(root, node.children ?? [], relative))
    }
  }
  return result
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds} 毫秒`
  const totalSeconds = Math.floor(milliseconds / 1000)
  if (totalSeconds < 60) {
    return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)} 秒`
  }
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} 分 ${seconds} 秒`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours} 时 ${minutes} 分 ${seconds} 秒`
}

function aspectResolution(
  aspectRatio: string,
  megapixels: number,
  multiple: number
): { width: number; height: number } | null {
  const match = aspectRatio.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/)
  if (!match) return null
  const widthRatio = Number(match[1])
  const heightRatio = Number(match[2])
  if (!widthRatio || !heightRatio) return null
  const safeMultiple = Math.max(1, Math.round(multiple) || 8)
  const totalPixels = Math.max(0.1, megapixels || 1) * 1024 * 1024
  const scale = Math.sqrt(totalPixels / (widthRatio * heightRatio))
  return {
    width: Math.max(
      safeMultiple,
      Math.round((widthRatio * scale) / safeMultiple) * safeMultiple
    ),
    height: Math.max(
      safeMultiple,
      Math.round((heightRatio * scale) / safeMultiple) * safeMultiple
    )
  }
}

function attachmentContextText(attachments?: MessageAttachment[]): string {
  if (!attachments?.length) return ''
  const parts = attachments.map((attachment) => {
    if (attachment.kind === 'text' && attachment.text) {
      return `<attachment name="${attachment.name}" type="text">\n${attachment.text}\n</attachment>`
    }
    if (attachment.kind === 'image') {
      return `<attachment name="${attachment.name}" type="image">${
        attachment.data || attachment.thumbnail ? '图像数据已随本条消息传入' : '仅保留图片预览记录'
      }</attachment>`
    }
    return `<attachment name="${attachment.name}" type="${attachment.kind}">仅保留文件名，未读取正文</attachment>`
  })
  return `\n\n<message_attachments>\n${parts.join('\n')}\n</message_attachments>`
}

function attachmentImages(attachments?: MessageAttachment[]): string[] | undefined {
  const images =
    attachments
      ?.filter((attachment) => attachment.kind === 'image')
      .map((attachment) => attachment.data || attachment.thumbnail || '')
      .filter(Boolean) ?? []
  return images.length ? images : undefined
}

function buildContextMessage(
  message: ChatMessage,
  latestTaskMessageId?: string
): ChatContextMessage {
  const taskBlock =
    message.id === latestTaskMessageId
      ? message.agentBlocks?.find((block) => block.type === 'tasks')
      : undefined
  const taskContext =
    taskBlock?.type === 'tasks'
      ? `\n\n<task_state>\n${taskBlock.items
          .map((task) => `${task.status} | ${task.id} | ${task.content}`)
          .join('\n')}\n</task_state>`
      : ''
  const guidanceContext = (message.agentBlocks ?? [])
    .filter((block) => block.type === 'guidance')
    .map((block) => (block.type === 'guidance' ? block.content : ''))
    .filter(Boolean)
    .join('\n')
  return {
    role: message.role,
    content:
      message.content +
      attachmentContextText(message.attachments) +
      taskContext +
      (guidanceContext
        ? `\n\n<user_guidance_history>\n${guidanceContext}\n</user_guidance_history>`
        : '') +
      (message.stoppedByUser
        ? '\n\n<interaction_event type="user_stopped">用户主动终止了本轮生成或任务。后续回复必须把此操作视为会话历史事实，不得假装上一轮正常完成。</interaction_event>'
        : ''),
    images: message.role === 'user' ? attachmentImages(message.attachments) : undefined
  }
}

function buildArchivedHistoryMessage(message: ChatContextMessage): ChatContextMessage {
  return {
    role: message.role,
    content:
      message.content.length > HISTORY_ARCHIVE_CONTENT_LIMIT
        ? `${message.content.slice(0, HISTORY_ARCHIVE_CONTENT_LIMIT)}\n\n[历史记录已截断]`
        : message.content
  }
}

function splitContextHistory(
  messages: ChatContextMessage[],
  contextMemory?: { summary: string; updatedAt: number }
): {
  recent: ChatContextMessage[]
  archive: ChatContextMessage[]
} {
  const memoryMessage =
    contextMemory?.summary.trim()
      ? [
          {
            role: 'assistant' as const,
            content: `<compressed_history_summary updated_at="${contextMemory.updatedAt}">\n${contextMemory.summary.trim()}\n</compressed_history_summary>`
          }
        ]
      : []
  const archive = messages
    .slice(-HISTORY_ARCHIVE_MESSAGE_LIMIT)
    .map(buildArchivedHistoryMessage)
  return { recent: [], archive: [...memoryMessage, ...archive] }
}

function ResponseTimer({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (message.status !== 'streaming') return
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [message.status])
  if (!message.startedAt) return null
  const end = message.completedAt ?? now
  const duration = Math.max(0, end - message.startedAt)
  return (
    <span className={`response-timer ${message.status === 'streaming' ? 'running' : ''}`}>
      <Clock3 size={11} />
      {message.status === 'streaming' ? '思考中 ' : '用时 '}
      {formatDuration(duration)}
    </span>
  )
}

function AgentTimeline({ message }: { message: ChatMessage }): React.JSX.Element | null {
  if (!message.agentSteps?.length) return null
  return (
    <details className="agent-timeline" open={message.status === 'streaming'}>
      <summary>
        <span>执行流程 · {message.agentSteps.length} 步</span>
        <ChevronDown size={13} />
      </summary>
      <div className="agent-step-list">
        {message.agentSteps.map((step) => (
          <div className={`agent-step ${step.status}`} key={step.id}>
            <i>{step.status === 'done' ? <Check size={10} /> : null}</i>
            <div>
              <strong>{step.title}</strong>
              {step.detail && <span>{step.detail.slice(0, 220)}</span>}
            </div>
            {step.completedAt && (
              <small>{formatDuration(step.completedAt - step.startedAt)}</small>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}

function reactNodeText(value: React.ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(reactNodeText).join('')
  if (isValidElement(value)) {
    return reactNodeText((value.props as { children?: React.ReactNode }).children)
  }
  return ''
}

const runnableLanguages = new Set([
  'javascript',
  'js',
  'node',
  'python',
  'py',
  'powershell',
  'ps1',
  'shell',
  'cmd',
  'bat',
  'bash',
  'sh'
])

function MarkdownPre({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const root = useAppStore((state) => state.workspaceRoot)
  const [copied, setCopied] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{
    stdout: string
    stderr: string
    exitCode: number
    timedOut: boolean
  } | null>(null)
  const child = Children.toArray(children)[0]
  const className =
    isValidElement(child) && typeof child.props === 'object'
      ? String((child.props as { className?: string }).className ?? '')
      : ''
  const language = className.match(/language-([\w+-]+)/)?.[1]?.toLocaleLowerCase() ?? ''
  const code = reactNodeText(child).replace(/\n$/, '')
  const runnable = runnableLanguages.has(language)

  const copyCode = async (): Promise<void> => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const runCode = async (): Promise<void> => {
    if (!runnable || running) return
    setRunning(true)
    setResult(null)
    try {
      setResult(await window.localAgent.code.run({ language, code, cwd: root }))
    } catch (error) {
      setResult({
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
        timedOut: false
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="markdown-code-block">
      <header>
        <span>{language || '代码'}</span>
        <div>
          {runnable && (
            <button onClick={() => void runCode()} disabled={running}>
              {running ? <LoaderCircle size={12} className="spin" /> : <Play size={12} />}
              {running ? '运行中' : '运行'}
            </button>
          )}
          <button onClick={() => void copyCode()}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </header>
      <pre>{children}</pre>
      {result && (
        <div className={`code-run-result ${result.exitCode === 0 ? 'success' : 'error'}`}>
          <header>
            <span>
              {result.timedOut ? '运行超时' : `进程结束 · 退出码 ${result.exitCode}`}
            </span>
            <button onClick={() => setResult(null)}>
              <X size={11} /> 关闭
            </button>
          </header>
          {result.stdout && <pre>{result.stdout}</pre>}
          {result.stderr && <pre className="stderr">{result.stderr}</pre>}
        </div>
      )}
    </div>
  )
}

const MarkdownContent = memo(function MarkdownContent({
  content
}: {
  content: string
}): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, markdownKatexOptions], rehypeHighlight]}
      components={{
        pre: MarkdownPre,
        a: ({ children, href, ...props }) => (
          <a
            {...props}
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!href) return
              event.preventDefault()
              void window.localAgent.app.openExternal(href)
            }}
          >
            {children}
          </a>
        )
      }}
    >
      {normalizeMarkdownMath(content)}
    </ReactMarkdown>
  )
})

function normalizeUserMessageMarkdown(content: string): string {
  const proseLanguages = new Set(['', 'text', 'txt', 'plaintext', '正文', '小说', '文本', '代码'])
  return content.replace(
    /(^|\n)```([^\n`]*)\n([\s\S]*?)\n```(?=\n|$)/g,
    (match, prefix: string, languageValue: string, body: string) => {
      const language = languageValue.trim().toLocaleLowerCase()
      if (!proseLanguages.has(language)) return match
      const hanCharacters = body.match(/[\u3400-\u9fff]/g)?.length ?? 0
      const looksLikeSourceCode =
        /(?:^|\n)\s*(?:const|let|var|function|class|interface|type|import|export|return|if|for|while|def|from|public|private|package)\b|[{};]\s*(?:\n|$)|<\/?[A-Za-z][^>]*>/m.test(
          body
        )
      if (hanCharacters < 12 || looksLikeSourceCode) return match
      return `${prefix}\n${body.trim()}\n`
    }
  )
}

function useThrottledText(content: string, streaming: boolean): string {
  const contentRef = useRef(content)
  contentRef.current = content
  const [displayContent, setDisplayContent] = useState(content)

  useEffect(() => {
    const sync = (): void => {
      const next = contentRef.current
      setDisplayContent((current) => (current === next ? current : next))
    }
    sync()
    if (!streaming) return
    const timer = window.setInterval(sync, 100)
    return () => window.clearInterval(timer)
  }, [streaming])

  useEffect(() => {
    if (!streaming) setDisplayContent(content)
  }, [content, streaming])

  return displayContent
}

function ThrottledMarkdownContent({
  content,
  streaming
}: {
  content: string
  streaming: boolean
}): React.JSX.Element {
  const displayContent = useThrottledText(content, streaming)
  return <MarkdownContent content={displayContent} />
}

function OperationStatusIcon({
  status
}: {
  status: Extract<AgentExecutionBlock, { type: 'operation' }>['status']
}): React.JSX.Element {
  if (status === 'running') return <LoaderCircle size={11} className="spin" />
  if (status === 'waiting') return <ShieldCheck size={11} />
  if (status === 'error') return <X size={11} />
  return <Check size={11} />
}

function taskStatusIcon({
  status,
  messageStatus
}: {
  status: 'pending' | 'in_progress' | 'completed'
  messageStatus?: ChatMessage['status']
}): React.JSX.Element {
  if (status === 'completed') return <Check size={12} />
  if (status === 'in_progress' && messageStatus === 'streaming') {
    return <LoaderCircle size={12} className="spin" />
  }
  return <Square size={11} />
}

function FloatingTaskProgress({
  block,
  messageStatus
}: {
  block: Extract<AgentExecutionBlock, { type: 'tasks' }>
  messageStatus?: ChatMessage['status']
}): React.JSX.Element {
  const total = Math.max(1, block.items.length)
  const completed = block.items.filter((item) => item.status === 'completed').length
  const progress = Math.round((completed / total) * 100)
  const running =
    messageStatus === 'streaming' && block.items.some((item) => item.status === 'in_progress')
  const circumference = 2 * Math.PI * 18
  return (
    <div className={`floating-task-progress ${running ? 'running' : ''}`}>
      <button
        className="task-progress-orb"
        type="button"
        aria-label={`任务进度 ${completed}/${total}`}
      >
        <svg viewBox="0 0 44 44" aria-hidden="true">
          <circle className="track" cx="22" cy="22" r="18" />
          <circle
            className="value"
            cx="22"
            cy="22"
            r="18"
            style={{
              strokeDasharray: circumference,
              strokeDashoffset: circumference * (1 - progress / 100)
            }}
          />
        </svg>
        <span>{completed}/{total}</span>
      </button>
      <section className="task-progress-popover">
        <header>
          <strong>任务进度</strong>
          <span>{progress}%</span>
        </header>
        <div>
          {block.items.map((item) => (
            <article className={item.status} key={item.id}>
              <i>{taskStatusIcon({ status: item.status, messageStatus })}</i>
              <span>{item.content}</span>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function AssistantResponseBlock({
  content,
  footerExtra,
  streaming = false
}: {
  content: string
  footerExtra?: React.ReactNode
  streaming?: boolean
}): React.JSX.Element {
  return (
    <section className="assistant-content-wrap agent-response-block">
      <ThrottledMarkdownContent content={content} streaming={streaming} />
      <footer className="message-result-actions response-actions">
        {footerExtra}
        <button
          className="result-icon-button"
          onClick={() => void navigator.clipboard.writeText(content)}
          title="复制正文"
        >
          <Copy size={13} />
        </button>
      </footer>
    </section>
  )
}

function formatThinkingMarkdown(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/<\/?(?:think|thinking|thought|analysis|reasoning)\b[^>]*>/gi, '')
    .trim()
    .replace(/([^\n])\s+(\*\*[^*\n]{1,80}\*\*:)/g, '$1\n\n$2')
    .replace(/([^\n])\s+(\d+\.\s+\*\*[^*\n]+?\*\*)/g, '$1\n\n$2')
    .replace(/([^\n])\s+(-\s+\*\*[^*\n]+?\*\*)/g, '$1\n$2')
}

function splitThinkingContent(content: string): string[] {
  const minimumSegmentLength = 2_800
  const targetSegmentLength = 3_600
  const maximumSegmentLength = 4_600
  if (content.length <= maximumSegmentLength) return [content]

  const segments: string[] = []
  let start = 0
  while (content.length - start > maximumSegmentLength) {
    const target = start + targetSegmentLength
    let end = content.lastIndexOf('\n\n', target)
    if (end < start + minimumSegmentLength) {
      const forward = content.indexOf('\n\n', target)
      end = forward >= 0 && forward <= start + maximumSegmentLength ? forward : target
    }
    if (end <= start) end = target
    else end += 2
    segments.push(content.slice(start, end))
    start = end
  }
  if (start < content.length) segments.push(content.slice(start))
  return segments
}

const ThinkingMarkdownSegment = memo(function ThinkingMarkdownSegment({
  content
}: {
  content: string
}): React.JSX.Element {
  return (
    <div className="thinking-markdown-segment">
      <MarkdownContent content={formatThinkingMarkdown(content)} />
    </div>
  )
})

function CollapsibleStep({
  className,
  initiallyOpen = false,
  children
}: {
  className: string
  initiallyOpen?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      {children}
    </details>
  )
}

function StreamingThinkingContent({
  content,
  streaming
}: {
  content: string
  streaming: boolean
}): React.JSX.Element {
  const displayContent = useThrottledText(content, streaming)
  const segments = useMemo(
    () => splitThinkingContent(displayContent),
    [displayContent]
  )
  const virtualized = streaming || segments.length > 2
  const virtualHeight = Math.min(
    240,
    Math.max(88, 64 + Math.ceil(Math.min(displayContent.length, 1_000) / 90) * 18)
  )

  if (virtualized) {
    return (
      <Virtuoso
        className="agent-step-content thinking-markdown thinking-virtual-list"
        style={{ height: virtualHeight }}
        data={segments}
        computeItemKey={(index, segment) =>
          `${index}-${index < segments.length - 1 ? segment.length : 'tail'}`
        }
        followOutput={(atBottom) => (streaming && atBottom ? 'auto' : false)}
        atBottomThreshold={20}
        increaseViewportBy={{ top: 80, bottom: 100 }}
        itemContent={(_index, segment) => (
          <ThinkingMarkdownSegment content={segment} />
        )}
      />
    )
  }

  return (
    <div className="agent-step-content thinking-markdown">
      {segments.map((segment, index) => (
        <ThinkingMarkdownSegment
          content={segment}
          key={`${index}-${index < segments.length - 1 ? segment.length : 'tail'}`}
        />
      ))}
    </div>
  )
}

function AgentStepBlock({
  block,
  messageStatus,
  responseFooterExtra,
  lastResponseBlockId,
  onPreviewImage,
  onImageContextMenu
}: {
  block: AgentExecutionBlock
  messageStatus?: ChatMessage['status']
  responseFooterExtra?: React.ReactNode
  lastResponseBlockId?: string
  onPreviewImage: (image: { src: string; name: string }) => void
  onImageContextMenu: (
    event: React.MouseEvent,
    image: MessageAttachment
  ) => void
}): React.JSX.Element | null {
  const running = messageStatus === 'streaming'
  if (block.type === 'operation') {
    const title = block.title || block.toolName || '执行操作'
    const active = running && (block.status === 'running' || block.status === 'waiting')
    return (
      <CollapsibleStep
        className={`agent-step-card operation ${block.status}`}
        initiallyOpen={active}
      >
        <summary>
          <i>
            <OperationStatusIcon status={block.status} />
          </i>
          <span>{title}</span>
          {block.completedAt && <small>{formatDuration(block.completedAt - block.startedAt)}</small>}
          <ChevronDown size={13} />
        </summary>
        {block.detail && <div className="agent-step-detail">{block.detail}</div>}
      </CollapsibleStep>
    )
  }
  if (block.type === 'tasks') {
    return null
  }
  if (block.type === 'response') {
    if (!block.content.trim()) return null
    return (
      <AssistantResponseBlock
        content={block.content}
        streaming={running && block.id === lastResponseBlockId}
        footerExtra={block.id === lastResponseBlockId ? responseFooterExtra : undefined}
      />
    )
  }
  if (block.type === 'image') {
    return (
      <section className="generated-image-block">
        <header>
          <span><ImageIcon size={13} /> {block.title || '生成图片'}</span>
          <small>{block.images.length} 张</small>
        </header>
        <div className="generated-image-grid">
          {block.images.map((image, index) => {
            const source = image.data || image.thumbnail || ''
            if (!source) return null
            return (
              <button
                key={`${image.name}-${index}`}
                className="generated-image-item"
                onClick={() => onPreviewImage({ src: source, name: image.name })}
                onContextMenu={(event) => onImageContextMenu(event, image)}
                title="点击查看大图，右键打开更多操作"
              >
                <img src={image.thumbnail || source} alt={image.name} />
                <span>{image.name}</span>
              </button>
            )
          })}
        </div>
      </section>
    )
  }
  if (block.type === 'guidance') {
    return (
      <CollapsibleStep className="agent-step-card guidance">
        <summary>
          <i>
            <MessageSquareText size={12} />
          </i>
          <span>你的补充</span>
          <button
            className="ghost-copy-icon"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void navigator.clipboard.writeText(block.content)
            }}
            title="复制补充"
          >
            <Copy size={12} />
          </button>
          <ChevronDown size={13} />
        </summary>
        <div className="agent-step-content thinking-markdown">
          <MarkdownContent content={formatThinkingMarkdown(block.content)} />
        </div>
      </CollapsibleStep>
    )
  }
  if (block.type === 'thinking') {
    const thinking = messageStatus === 'streaming' && block.status !== 'done'
    return (
      <CollapsibleStep className="agent-step-card thinking" initiallyOpen={thinking}>
        <summary>
          <i>
            {thinking ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}
          </i>
          <span>思考</span>
          <button
            className="ghost-copy-icon"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void navigator.clipboard.writeText(block.content)
            }}
            title="复制思考"
          >
            <Copy size={12} />
          </button>
          <ChevronDown size={13} />
        </summary>
        <StreamingThinkingContent content={block.content} streaming={thinking} />
      </CollapsibleStep>
    )
  }
  return null
}

function AgentExecutionStream({
  blocks,
  messageStatus,
  responseFooterExtra,
  onPreviewImage,
  onImageContextMenu
}: {
  blocks: AgentExecutionBlock[]
  messageStatus?: ChatMessage['status']
  responseFooterExtra?: React.ReactNode
  onPreviewImage: (image: { src: string; name: string }) => void
  onImageContextMenu: (
    event: React.MouseEvent,
    image: MessageAttachment
  ) => void
}): React.JSX.Element {
  const lastResponseBlockId = [...blocks]
    .reverse()
    .find((block) => block.type === 'response' && Boolean(block.content.trim()))?.id
  return (
    <div className="agent-execution-stream">
      {blocks.map((block) => (
        <AgentStepBlock
          block={block}
          key={block.id}
          messageStatus={messageStatus}
          responseFooterExtra={responseFooterExtra}
          lastResponseBlockId={lastResponseBlockId}
          onPreviewImage={onPreviewImage}
          onImageContextMenu={onImageContextMenu}
        />
      ))}
    </div>
  )
}

function ThinkingPreview({ message }: { message: ChatMessage }): React.JSX.Element {
  const meta = message.meta?.trim() ?? ''
  return (
    <div className="thinking-preview">
      <header>
        <LoaderCircle size={15} className="spin" />
        <span>思考</span>
      </header>
      <p>{meta || '等待模型自己决定下一步'}</p>
    </div>
  )
}

function AssistantMessageMetaActions({
  message,
  onReview,
  onRetry
}: {
  message: ChatMessage
  onReview: (checkpointId: string) => void
  onRetry: () => void
}): React.JSX.Element {
  return (
    <>
      {message.usage && !message.usage.estimated && (
        <span
          className="token-usage"
          title={`输入 ${message.usage.promptTokens.toLocaleString()} Token，输出 ${message.usage.completionTokens.toLocaleString()} Token，合计 ${message.usage.totalTokens.toLocaleString()} Token`}
        >
          {`输入 ${message.usage.promptTokens.toLocaleString()} · 输出 ${message.usage.completionTokens.toLocaleString()} · 合计 ${message.usage.totalTokens.toLocaleString()} Token`}
        </span>
      )}
      <ResponseTimer message={message} />
      {message.status === 'error' && (
        <button onClick={onRetry}>
          <RotateCcw size={12} /> 重试任务
        </button>
      )}
      {message.checkpointId && (
        <button
          className="result-icon-button"
          onClick={() => onReview(message.checkpointId!)}
          title="查看行级 Diff"
          aria-label="查看行级 Diff"
        >
          <GitCompareArrows size={13} />
        </button>
      )}
    </>
  )
}

type MessageCardProps = {
  message: ChatMessage
  onReview: (checkpointId: string) => void
  onRetry: () => void
  userContentExpanded: boolean
  onToggleUserContent: () => void
  onPreviewImage: (image: { src: string; name: string }) => void
  onImageContextMenu: (
    event: React.MouseEvent,
    image: MessageAttachment
  ) => void
}

function completeAssistantTranscript(message: ChatMessage): string {
  const sections: string[] = []
  let responseIncluded = false
  for (const block of message.agentBlocks ?? []) {
    if (block.type === 'thinking') {
      sections.push(`【思考】\n${block.content}`)
      continue
    }
    if (block.type === 'operation') {
      sections.push(
        [`【操作】${block.title}`, block.detail || '', `状态：${block.status}`]
          .filter(Boolean)
          .join('\n')
      )
      continue
    }
    if (block.type === 'tasks') {
      sections.push(
        `【任务清单】\n${block.items
          .map((item) => `- [${item.status}] ${item.content}`)
          .join('\n')}`
      )
      continue
    }
    if (block.type === 'guidance') {
      sections.push(`【用户补充】\n${block.content}`)
      continue
    }
    if (block.type === 'response') {
      if (block.content.trim()) {
        sections.push(`【回复】\n${block.content}`)
        responseIncluded = true
      }
      continue
    }
    if (block.type === 'image') {
      sections.push(`【生成图片】\n${block.images.map((image) => image.name).join('\n')}`)
    }
  }
  if (!responseIncluded && message.content.trim()) {
    sections.push(`【回复】\n${message.content}`)
  }
  return sections.join('\n\n').trim()
}

const MessageCard = memo(function MessageCard({
  message,
  onReview,
  onRetry,
  userContentExpanded,
  onToggleUserContent,
  onPreviewImage,
  onImageContextMenu
}: MessageCardProps): React.JSX.Element {
  const isUser = message.role === 'user'
  const userContentRef = useRef<HTMLDivElement>(null)
  const [userMessageCopied, setUserMessageCopied] = useState(false)
  const likelyLongUserMessage =
    isUser &&
    (message.content.length > USER_MESSAGE_COLLAPSE_CHARACTERS ||
      message.content.split(/\r?\n/).length > 12)
  const [userContentCollapsible, setUserContentCollapsible] = useState(likelyLongUserMessage)
  const userDisplayContent = useMemo(
    () => (isUser ? normalizeUserMessageMarkdown(message.content) : message.content),
    [isUser, message.content]
  )
  const executionBlocks = !isUser ? (message.agentBlocks ?? []) : []
  const hasExecutionBlocks = executionBlocks.length > 0
  const hasResponseBlocks = executionBlocks.some(
    (block) => block.type === 'response' && Boolean(block.content.trim())
  )
  const assistantMetaActions = !isUser ? (
    <AssistantMessageMetaActions
      message={message}
      onReview={onReview}
      onRetry={onRetry}
    />
  ) : null
  const showMeta = Boolean(
    message.meta &&
      (isUser || !hasExecutionBlocks) &&
      !(message.status === 'streaming' && !message.content)
  )
  useEffect(() => {
    setUserContentCollapsible(likelyLongUserMessage)
  }, [message.id, likelyLongUserMessage])
  useLayoutEffect(() => {
    if (!isUser || !message.content.trim()) return
    const element = userContentRef.current
    if (!element) return
    const measure = (): void => {
      setUserContentCollapsible(
        likelyLongUserMessage || element.scrollHeight > USER_MESSAGE_COLLAPSE_HEIGHT
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [isUser, likelyLongUserMessage, message.content])
  const userContentCollapsed = userContentCollapsible && !userContentExpanded
  return (
    <article className={`message-card ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-avatar">
        {isUser ? <MessageSquareText size={16} /> : <Bot size={16} />}
      </div>
      <div className="message-body">
        <div className="message-role">
          <span>{isUser ? '你' : '星伴 AI'}</span>
          {isUser ? (
            <button
              className="message-complete-copy user-message-copy"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(message.content).then(() => {
                  setUserMessageCopied(true)
                  window.setTimeout(() => setUserMessageCopied(false), 1200)
                })
              }}
              title={userMessageCopied ? '已复制用户消息' : '复制用户消息'}
              aria-label="复制用户消息"
            >
              {userMessageCopied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          ) : (
            <button
              className="message-complete-copy"
              onClick={() =>
                void navigator.clipboard.writeText(completeAssistantTranscript(message))
              }
              title="复制本轮完整思考、工具操作与回复"
              aria-label="复制本轮完整过程"
            >
              <Copy size={13} />
            </button>
          )}
        </div>
        {showMeta && <div className="message-meta">{message.meta}</div>}
        {!hasExecutionBlocks && <AgentTimeline message={message} />}
        {isUser && message.attachments?.length ? (
          <div className="message-attachments">
            {message.attachments.map((attachment, index) => (
              attachment.kind === 'image' && attachment.thumbnail ? (
                <button
                  className="message-image-thumbnail"
                  key={`${attachment.name}-${index}`}
                  onClick={() =>
                    onPreviewImage({
                      src: attachment.data || attachment.thumbnail!,
                      name: attachment.name
                    })
                  }
                  title={`查看大图：${attachment.name}`}
                >
                  <img src={attachment.thumbnail} alt={attachment.name} />
                  <span>{attachment.name}</span>
                </button>
              ) : (
                <span key={`${attachment.name}-${index}`}>
                  {attachment.kind === 'image' ? <ImageIcon size={12} /> : <File size={12} />}
                  {attachment.name}
                </span>
              )
            ))}
          </div>
        ) : null}
        {hasExecutionBlocks && (
          <AgentExecutionStream
            blocks={executionBlocks}
            messageStatus={message.status}
            responseFooterExtra={assistantMetaActions}
            onPreviewImage={onPreviewImage}
            onImageContextMenu={onImageContextMenu}
          />
        )}
        {!isUser &&
        !executionBlocks.some((block) => block.type === 'image') &&
        message.attachments?.length ? (
          <div className="message-attachments legacy-generated-images">
            {message.attachments.map((attachment, index) => {
              const source = attachment.data || attachment.thumbnail || ''
              return attachment.kind === 'image' && source ? (
                <button
                  className="generated-image-item"
                  key={`${attachment.name}-${index}`}
                  onClick={() => onPreviewImage({ src: source, name: attachment.name })}
                  onContextMenu={(event) => onImageContextMenu(event, attachment)}
                >
                  <img src={attachment.thumbnail || source} alt={attachment.name} />
                  <span>{attachment.name}</span>
                </button>
              ) : null
            })}
          </div>
        ) : null}
        {message.content.trim() && (isUser || !hasResponseBlocks) ? (
          isUser ? (
            <div
              ref={userContentRef}
              className={`assistant-content-wrap user-message-content ${
                userContentCollapsed ? 'collapsed' : ''
              }`}
            >
              <MarkdownContent content={userDisplayContent} />
            </div>
          ) : (
            <AssistantResponseBlock
              content={message.content}
              streaming={message.status === 'streaming'}
              footerExtra={assistantMetaActions}
            />
          )
        ) : !hasExecutionBlocks && message.status === 'streaming' ? (
          <ThinkingPreview message={message} />
        ) : null}
        {isUser && userContentCollapsible && message.content.trim() ? (
          <button
            className="user-message-collapse-toggle"
            type="button"
            aria-expanded={userContentExpanded}
            onClick={onToggleUserContent}
          >
            <ChevronDown className={userContentExpanded ? 'expanded' : ''} size={13} />
            {userContentExpanded
              ? '收起消息'
              : `展开全文 · ${message.content.replace(/\s/g, '').length.toLocaleString()} 字`}
          </button>
        ) : null}
        {message.status === 'error' && <div className="inline-error">请求失败</div>}
        {!isUser && !message.content && !hasResponseBlocks && (
          <div className="message-result-actions">
            {assistantMetaActions}
          </div>
        )}
      </div>
    </article>
  )
}, (previous, next) =>
  previous.message === next.message &&
  previous.userContentExpanded === next.userContentExpanded
)

function InlineApprovalCard({
  approval,
  blocked,
  onResolve
}: {
  approval: AgentApproval
  blocked: boolean
  onResolve: (approved: boolean) => void
}): React.JSX.Element {
  return (
    <section className="inline-approval-card" aria-label="Agent 操作审批">
      <header>
        <span className="inline-approval-icon">
          <ShieldCheck size={17} />
        </span>
        <div>
          <span className="eyebrow">等待你的确认</span>
          <h3>{approval.title}</h3>
        </div>
      </header>
      <p>{approval.description}</p>
      <details className="inline-approval-detail">
        <summary>
          <span>
            <Code2 size={12} />
            {approval.toolName}
          </span>
          <ChevronDown size={13} />
        </summary>
        <pre>{JSON.stringify(approval.toolArgs, null, 2)}</pre>
      </details>
      {approval.changes?.length ? (
        <div className="inline-approval-files">
          <strong>将修改 {approval.changes.length} 个文件</strong>
          <span>{approval.changes.map((change) => change.path).join(' · ')}</span>
          <small>右侧编辑器已打开逐行 Diff，可先检查再决定。</small>
        </div>
      ) : null}
      {blocked && (
        <div className="inline-approval-warning">
          当前文件内容已经变化，请先处理编辑器中的冲突再允许修改。
        </div>
      )}
      <footer>
        <button className="ghost-button danger" onClick={() => onResolve(false)}>
          <X size={14} /> 拒绝
        </button>
        <button
          className="primary-button"
          disabled={blocked}
          onClick={() => onResolve(true)}
        >
          <Check size={14} /> 允许执行
        </button>
      </footer>
    </section>
  )
}

function ChatMinimap({
  messages,
  range,
  onJump
}: {
  messages: ChatMessage[]
  range: ListRange
  onJump: (index: number) => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null)
  const [expanded, setExpanded] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const userIndexes = useMemo(() => {
    return messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === 'user')
      .map(({ index }) => index)
  }, [messages.length, messages[0]?.id, messages.at(-1)?.id])
  const visibleCenter = Math.round((range.startIndex + range.endIndex) / 2)
  const currentIndex =
    [...userIndexes].reverse().find((index) => index <= visibleCenter) ?? userIndexes[0]

  const jumpByPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (userIndexes.length <= 1) return
    const rect = event.currentTarget.getBoundingClientRect()
    const percent = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    onJump(userIndexes[Math.round(percent * (userIndexes.length - 1))] ?? userIndexes[0])
  }

  useEffect(() => {
    if (!expanded) return
    listRef.current
      ?.querySelector<HTMLElement>('[data-current="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [expanded, currentIndex])

  if (!userIndexes.length) return <></>

  return (
    <div
      className={`chat-minimap ${expanded ? 'expanded' : ''}`}
      aria-label="聊天快捷导航"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => {
        setExpanded(false)
        setHovered(null)
      }}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="chat-minimap-markers" onPointerDown={jumpByPointer}>
        {userIndexes.map((messageIndex, markerIndex) => {
          const message = messages[messageIndex]
          const title = message.content.trim().slice(0, 140) || '空消息'
          return (
            <button
              key={message.id}
              className={`user ${messageIndex === currentIndex ? 'current' : ''}`}
              onPointerDown={(event) => {
                event.stopPropagation()
                onJump(messageIndex)
              }}
              onMouseEnter={() => setHovered(messageIndex)}
              title={title}
              data-marker-index={markerIndex}
            />
          )
        })}
      </div>
      {expanded && (
        <section
          className="chat-minimap-panel"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header>
            <strong>对话导航</strong>
            <span>{userIndexes.length} 条用户消息</span>
          </header>
          <div ref={listRef} className="chat-minimap-list">
            {userIndexes.map((messageIndex, markerIndex) => {
              const message = messages[messageIndex]
              const content =
                message.content.trim().replace(/\s+/g, ' ') ||
                message.attachments?.map((attachment) => attachment.name).join('、') ||
                '空消息'
              return (
                <button
                  key={message.id}
                  className={`${messageIndex === currentIndex ? 'current' : ''} ${
                    messageIndex === hovered ? 'hovered' : ''
                  }`}
                  data-current={messageIndex === currentIndex}
                  onMouseEnter={() => setHovered(messageIndex)}
                  onClick={() => {
                    onJump(messageIndex)
                    setExpanded(false)
                  }}
                  title={content}
                >
                  <span className="chat-minimap-number">{markerIndex + 1}</span>
                  <span className="chat-minimap-message">
                    <strong>{content}</strong>
                    <small>
                      {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                      {message.attachments?.length
                        ? ` · ${message.attachments.length} 个附件`
                        : ''}
                    </small>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

async function createImageThumbnail(file: globalThis.File): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file)
    const maxSide = 112
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return ''
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    return canvas.toDataURL('image/webp', 0.78)
  } catch {
    return ''
  }
}

async function attachmentFromFile(file: globalThis.File): Promise<ChatAttachment> {
  const mimeType = file.type || 'application/octet-stream'
  const image = mimeType.startsWith('image/')
  const text =
    mimeType.startsWith('text/') ||
    /\.(md|txt|json|ya?ml|xml|csv|ts|tsx|js|jsx|css|html|py|cs|go|rs|java|cpp|c|h|sh|ps1)$/i.test(
      file.name
    )
  if (image) {
    const thumbnail = await createImageThumbnail(file)
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    return { name: file.name, kind: 'image', mimeType, size: file.size, data, thumbnail }
  }
  if (text) {
    return {
      name: file.name,
      kind: 'text',
      mimeType,
      size: file.size,
      text: (await file.text()).slice(0, 600000)
    }
  }
  return { name: file.name, kind: 'file', mimeType, size: file.size }
}

export function ChatPanel(): React.JSX.Element {
  const model = useAppStore((state) => state.model)
  const setModel = useAppStore((state) => state.setModel)
  const globalInstructions = useAppStore((state) => state.globalInstructions)
  const skills = useAppStore((state) => state.skills)
  const agentPermissionMode = useAppStore((state) => state.agentPermissionMode)
  const setAgentPermissionMode = useAppStore((state) => state.setAgentPermissionMode)
  const agentApproval = useAppStore((state) => state.agentApproval)
  const setAgentApproval = useAppStore((state) => state.setAgentApproval)
  const workspaceRoot = useAppStore((state) => state.workspaceRoot)
  const workspaceRoots = useAppStore((state) => state.workspaceRoots)
  const workspaceTrees = useAppStore((state) => state.workspaceTrees)
  const activeFilePath = useAppStore((state) => state.activeFilePath)
  const editorSelection = useAppStore((state) => state.editorSelection)
  const openFiles = useAppStore((state) => state.openFiles)
  const conversations = useAppStore((state) => state.conversations)
  const activeConversationId = useAppStore((state) => state.activeConversationId)
  const pending = useAppStore((state) => state.pending)
  const comfyBaseUrl = useAppStore((state) => state.comfyBaseUrl)
  const setComfyBaseUrl = useAppStore((state) => state.setComfyBaseUrl)
  const comfyWorkflows = useAppStore((state) => state.comfyWorkflows)
  const setComfyWorkflows = useAppStore((state) => state.setComfyWorkflows)
  const selectedComfyWorkflowId = useAppStore((state) => state.selectedComfyWorkflowId)
  const setSelectedComfyWorkflowId = useAppStore(
    (state) => state.setSelectedComfyWorkflowId
  )
  const updateComfyWorkflow = useAppStore((state) => state.updateComfyWorkflow)
  const createConversation = useAppStore((state) => state.createConversation)
  const setConversationMode = useAppStore((state) => state.setConversationMode)
  const setActiveConversation = useAppStore((state) => state.setActiveConversation)
  const deleteConversation = useAppStore((state) => state.deleteConversation)
  const addMessage = useAppStore((state) => state.addMessage)
  const updateMessage = useAppStore((state) => state.updateMessage)
  const registerPending = useAppStore((state) => state.registerPending)
  const clearPending = useAppStore((state) => state.clearPending)
  const [input, setInput] = useState('')
  const [attachCurrent, setAttachCurrent] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [actionNotice, setActionNotice] = useState('')
  const [showSessions, setShowSessions] = useState(false)
  const [expandedUserMessageIds, setExpandedUserMessageIds] = useState<Set<string>>(
    () => new Set()
  )
  const [sessionQuery, setSessionQuery] = useState('')
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null)
  const [comfyInspection, setComfyInspection] = useState<ComfyWorkflowInspection | null>(null)
  const [inspectingComfy, setInspectingComfy] = useState(false)
  const [freeingComfy, setFreeingComfy] = useState(false)
  const [imageSettingsOpen, setImageSettingsOpen] = useState(false)
  const [discoveringWorkflows, setDiscoveringWorkflows] = useState(false)
  const [imageQueueOpen, setImageQueueOpen] = useState(false)
  const [imageContextMenu, setImageContextMenu] = useState<{
    x: number
    y: number
    image: MessageAttachment
  } | null>(null)
  const deferredSessionQuery = useDeferredValue(sessionQuery)
  const [visibleRange, setVisibleRange] = useState<ListRange>({ startIndex: 0, endIndex: 0 })
  const [atBottom, setAtBottom] = useState(true)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRegionRef = useRef<HTMLDivElement>(null)
  const sessionPanelRef = useRef<HTMLDivElement>(null)
  const comfyScanStartedRef = useRef(false)

  const conversation =
    conversations.find((item) => item.id === activeConversationId) ?? conversations[0]
  const messages = conversation?.messages ?? []
  const mode = conversation?.mode ?? 'chat'
  const floatingTaskState = useMemo(() => {
    const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!latestAssistant) return null
    for (
      let blockIndex = (latestAssistant.agentBlocks?.length ?? 0) - 1;
      blockIndex >= 0;
      blockIndex -= 1
    ) {
      const block = latestAssistant.agentBlocks?.[blockIndex]
      if (block?.type === 'tasks' && block.items.length) {
        return { block, messageStatus: latestAssistant.status }
      }
    }
    return null
  }, [messages])
  const approvalForConversation =
    agentApproval &&
    pending[agentApproval.requestId]?.conversationId === conversation?.id
      ? agentApproval
      : null
  const setMode = (nextMode: ConversationMode): void => {
    if (!conversation || nextMode === mode) return
    if (approvalForConversation && nextMode !== 'agent') {
      setActionNotice('请先确认或拒绝当前 Agent 操作')
      return
    }
    setShowSessions(false)
    setSessionQuery('')
    setImageSettingsOpen(false)
    setImageQueueOpen(false)
    setImageContextMenu(null)
    setPreviewImage(null)
    setActionNotice('')
    setAttachCurrent(false)
    setAttachments([])
    setWebSearchEnabled(false)
    setConversationMode(conversation.id, nextMode)
  }
  const filteredConversations = useMemo(() => {
    if (!showSessions) return []
    const query = deferredSessionQuery.trim().toLocaleLowerCase()
    return conversations
      .filter(
        (item) =>
          !query ||
          item.title.toLocaleLowerCase().includes(query) ||
          item.messages.some((message) => message.content.toLocaleLowerCase().includes(query))
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }, [conversations, deferredSessionQuery, showSessions])
  const conversationPendings = useMemo(
    () =>
      Object.entries(pending).filter(
        ([, value]) => value.conversationId === activeConversationId
      ),
    [pending, activeConversationId]
  )
  const imageQueueItems = useMemo(
    () => {
      const imagePendings = Object.entries(pending).filter(
        ([, value]) => value.kind === 'image'
      )
      if (!imagePendings.length) return []
      return imagePendings
        .map(([requestId, value]) => {
          const owner = conversations.find((item) => item.id === value.conversationId)
          const assistantIndex =
            owner?.messages.findIndex((message) => message.id === value.assistantId) ?? -1
          const assistant = assistantIndex >= 0 ? owner?.messages[assistantIndex] : undefined
          const user = assistantIndex > 0 ? owner?.messages[assistantIndex - 1] : undefined
          const status = assistant?.meta || '等待图片任务开始'
          return {
            requestId,
            title: user?.content || '图片生成任务',
            status,
            queued: /队列|前方|等待/.test(status)
          }
        })
    },
    [pending, conversations]
  )
  const activePending = conversationPendings[0]
  const imagePendingCount = imageQueueItems.length
  const hasBlockingPending = conversationPendings.some(([, value]) => value.kind !== 'image')
  const running = Boolean(activePending)
  const approvalBlocked = Boolean(
    approvalForConversation?.changes?.some((change) => {
      const current = openFiles.find((file) => file.path === change.path)
      return current && current.content !== change.before
    })
  )
  const selectedComfyWorkflow =
    comfyWorkflows.find((workflow) => workflow.id === selectedComfyWorkflowId) ??
    comfyWorkflows[0]
  const selectedImageModel =
    selectedComfyWorkflow?.selectedModel || selectedComfyWorkflow?.defaultModel || ''
  const selectedImageSteps =
    selectedComfyWorkflow?.selectedSteps || selectedComfyWorkflow?.defaultSteps || 20
  const selectedImageWidth =
    selectedComfyWorkflow?.selectedWidth || selectedComfyWorkflow?.defaultWidth || 1024
  const selectedImageHeight =
    selectedComfyWorkflow?.selectedHeight || selectedComfyWorkflow?.defaultHeight || 1024
  const selectedImageAspectRatio =
    selectedComfyWorkflow?.selectedAspectRatio ||
    selectedComfyWorkflow?.defaultAspectRatio ||
    '1:1 (Square)'
  const selectedImageMegapixels =
    selectedComfyWorkflow?.selectedMegapixels ||
    selectedComfyWorkflow?.defaultMegapixels ||
    1
  const selectedImageMultiple =
    selectedComfyWorkflow?.selectedMultiple ||
    selectedComfyWorkflow?.defaultMultiple ||
    8
  const imageAspectRatioOptions = [
    ...new Set(
      [
        selectedImageAspectRatio,
        ...(comfyInspection?.aspectRatios ?? []),
        ...(selectedComfyWorkflow?.aspectRatioOptions ?? [])
      ].filter(Boolean)
    )
  ]
  const selectedAspectResolution = aspectResolution(
    selectedImageAspectRatio,
    selectedImageMegapixels,
    selectedImageMultiple
  )
  const selectedImageSizeLabel =
    selectedComfyWorkflow?.sizeMode === 'aspect_ratio'
      ? `${selectedImageAspectRatio.split(' ')[0]} · ${selectedImageMegapixels} MP${
          selectedAspectResolution
            ? ` · 约 ${selectedAspectResolution.width}×${selectedAspectResolution.height}`
            : ''
        }`
      : selectedComfyWorkflow?.sizeMode === 'dimensions'
        ? `${selectedImageWidth}×${selectedImageHeight}`
        : '工作流原始尺寸'
  const imageModelOptions = [
    ...new Set(
      [
        selectedImageModel,
        ...(comfyInspection?.models ?? []),
        selectedComfyWorkflow?.defaultModel
      ].filter((value): value is string => Boolean(value))
    )
  ]
  const mentionEntries = useMemo(
    () =>
      workspaceRoots.flatMap((root) =>
        flattenFiles(root, workspaceTrees[root] ?? [])
      ),
    [workspaceRoots, workspaceTrees]
  )
  const mentionMatch = input.match(/@([^\s@\[\]]*)$/)
  const mentionQuery = mentionMatch?.[1]?.toLocaleLowerCase() ?? ''
  const mentionSuggestions = mentionMatch
    ? mentionEntries
        .filter(
          (entry) =>
            entry.name.toLocaleLowerCase().includes(mentionQuery) ||
            entry.label.toLocaleLowerCase().includes(mentionQuery)
        )
        .slice(0, 8)
    : []

  const discoverModels = async (): Promise<void> => {
    setDiscovering(true)
    try {
      const options = (await window.localAgent.model.discover()) as ModelOption[]
      setModelOptions(options)
      const current = useAppStore.getState().model
      const matched = options.find(
        (item) =>
          item.name === current.model &&
          item.provider === current.provider &&
          item.baseUrl === current.baseUrl
      )
      if (
        matched &&
        (matched.contextLength !== current.contextLength ||
          matched.maxContextLength !== current.maxContextLength)
      ) {
        setModel({
          ...current,
          contextLength: matched.contextLength,
          maxContextLength: matched.maxContextLength
        })
      }
    } finally {
      setDiscovering(false)
    }
  }

  useEffect(() => {
    void discoverModels()
  }, [])

  useEffect(() => {
    if (!showSessions) return
    const close = (event: PointerEvent): void => {
      if (!sessionPanelRef.current?.contains(event.target as Node)) setShowSessions(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [showSessions])

  useEffect(() => {
    if (!previewImage) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPreviewImage(null)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [previewImage])

  useEffect(() => {
    if (!selectedComfyWorkflowId && comfyWorkflows[0]) {
      setSelectedComfyWorkflowId(comfyWorkflows[0].id)
    }
  }, [selectedComfyWorkflowId, comfyWorkflows])

  const discoverComfyWorkflows = async (): Promise<void> => {
    setDiscoveringWorkflows(true)
    try {
      const discovered = await window.localAgent.comfy.discoverWorkflows()
      const savedByPath = new Map(
        comfyWorkflows.map((workflow) => [workflow.sourcePath, workflow])
      )
      const next = discovered.map((workflow) => {
        const saved = savedByPath.get(workflow.sourcePath)
        return {
          ...workflow,
          selectedModel: saved?.selectedModel,
          selectedSteps: saved?.selectedSteps,
          selectedWidth: saved?.selectedWidth,
          selectedHeight: saved?.selectedHeight,
          selectedAspectRatio: saved?.selectedAspectRatio,
          selectedMegapixels: saved?.selectedMegapixels,
          selectedMultiple: saved?.selectedMultiple
        }
      })
      setComfyWorkflows(next)
      const selectedStillExists = next.some(
        (workflow) => workflow.id === selectedComfyWorkflowId
      )
      setSelectedComfyWorkflowId(
        selectedStillExists ? selectedComfyWorkflowId : next[0]?.id || ''
      )
      setActionNotice(
        next.length
          ? `已刷新 ${next.length} 个可执行图片工作流`
          : '本地目录中未发现可执行的图片工作流'
      )
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setDiscoveringWorkflows(false)
    }
  }

  useEffect(() => {
    if (mode === 'image' && !comfyScanStartedRef.current) {
      comfyScanStartedRef.current = true
      void discoverComfyWorkflows()
    }
  }, [mode])

  useEffect(() => {
    if (!imageSettingsOpen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setImageSettingsOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [imageSettingsOpen])

  useEffect(() => {
    if (!imageContextMenu) return
    const close = (): void => setImageContextMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [imageContextMenu])

  useEffect(() => {
    if (mode !== 'image' || !selectedComfyWorkflow) {
      setComfyInspection(null)
      return
    }
    let active = true
    let checking = false
    let firstCheck = true
    const inspect = async (): Promise<void> => {
      if (checking) return
      checking = true
      if (firstCheck) setInspectingComfy(true)
      try {
        const result = await window.localAgent.comfy.inspect(
          comfyBaseUrl,
          selectedComfyWorkflow
        ) as ComfyWorkflowInspection
        if (active) setComfyInspection(result)
      } catch (error) {
        if (!active) return
        const message = (error instanceof Error ? error.message : String(error)).replace(
          /^Error invoking remote method '[^']+':\s*/,
          ''
        )
        setComfyInspection({
          connected: false,
          message,
          models: [selectedComfyWorkflow.defaultModel]
        })
      } finally {
        checking = false
        firstCheck = false
        if (active) setInspectingComfy(false)
      }
    }
    void inspect()
    const timer = window.setInterval(() => void inspect(), 4000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [mode, selectedComfyWorkflow?.id, comfyBaseUrl])

  const displayedModels = useMemo(() => {
    const available = [...KIMI_CODE_MODELS, ...modelOptions]
    if (
      model.model &&
      !available.some(
        (item) =>
          item.name === model.model &&
          item.provider === model.provider &&
          item.baseUrl === model.baseUrl
      )
    ) {
      return [
        {
          id: `saved:${model.model}`,
          name: model.model,
          provider: model.provider,
          baseUrl: model.baseUrl,
          source:
            model.preset === 'kimi-code'
              ? ('Kimi Code' as const)
              : model.provider === 'ollama'
                ? ('Ollama' as const)
                : ('LM Studio' as const),
          preset: model.preset,
          contextLength: model.contextLength,
          maxContextLength: model.maxContextLength
        },
        ...available
      ]
    }
    return available
  }, [model, modelOptions])

  const selectedModelId =
    displayedModels.find(
      (item) =>
        item.name === model.model &&
        item.provider === model.provider &&
        item.baseUrl === model.baseUrl
    )?.id ?? ''

  const addFiles = async (files: Iterable<globalThis.File>): Promise<void> => {
    const selected = [...files].slice(
      0,
      Math.max(0, MAX_MESSAGE_ATTACHMENTS - attachments.length)
    )
    const valid = selected.filter((file) => file.size <= 12 * 1024 * 1024)
    const next = await Promise.all(valid.map(attachmentFromFile))
    setAttachments((current) =>
      [...current, ...next].slice(0, MAX_MESSAGE_ATTACHMENTS)
    )
  }

  const addPastedTextAttachment = (value: string): void => {
    const content = value.replace(/\r\n?/g, '\n')
    const now = new Date()
    const stamp = [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
      String(now.getMilliseconds()).padStart(3, '0')
    ].join('')
    const characterCount = content.length
    const attachment: ChatAttachment = {
      name: `临时粘贴-${stamp}-${characterCount.toLocaleString('zh-CN')}字.txt`,
      kind: 'text',
      mimeType: 'text/plain',
      size: new Blob([content]).size,
      text: content
    }
    setAttachments((current) =>
      current.length >= MAX_MESSAGE_ATTACHMENTS ? current : [...current, attachment]
    )
    setActionNotice(
      `已将 ${characterCount.toLocaleString('zh-CN')} 字粘贴内容转为临时文本附件`
    )
  }

  const unloadComfyModels = async (): Promise<void> => {
    setFreeingComfy(true)
    try {
      await window.localAgent.comfy.free(comfyBaseUrl)
      setActionNotice('图片模型已卸载，显存释放请求已完成')
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setFreeingComfy(false)
    }
  }

  const openImageContextMenu = (
    event: React.MouseEvent,
    image: MessageAttachment
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    setImageContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 150),
      image
    })
  }

  const runImageAction = async (
    action: 'open' | 'reveal' | 'saveAs'
  ): Promise<void> => {
    const image = imageContextMenu?.image
    const source = image?.data || image?.thumbnail
    if (!image || !source) return
    setImageContextMenu(null)
    try {
      if (action === 'open') await window.localAgent.images.open(source)
      if (action === 'reveal') await window.localAgent.images.reveal(source)
      if (action === 'saveAs') await window.localAgent.images.saveAs(source, image.name)
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const stopImageRequest = async (requestId: string): Promise<void> => {
    await window.localAgent.image.stop(requestId, comfyBaseUrl)
  }

  const localFileContextBlock = (
    tag: 'file' | 'current_file',
    filePath: string,
    content: string
  ): string => {
    const totalLines = content.split(/\r?\n/).length
    if (mode === 'agent' && totalLines > 200) {
      return `\n\n<file_reference path="${filePath}" total_lines="${totalLines}">长文件未直接载入全文。请先调用 search_files 定位关键词，再用 read_file 读取命中行上下各约 50 行。</file_reference>`
    }
    return `\n\n<${tag} path="${filePath}">\n${content}\n</${tag}>`
  }

  const expandMentions = async (text: string): Promise<string> => {
    const labels = [...text.matchAll(/@\[(.+?)\]/g)].map((match) => match[1])
    const entries = labels
      .map((label) => mentionEntries.find((entry) => entry.label === label))
      .filter((entry): entry is MentionEntry => Boolean(entry))
    const blocks: string[] = []
    for (const entry of entries.slice(0, 8)) {
      try {
        const content = await window.localAgent.files.read(entry.root, entry.path)
        blocks.push(localFileContextBlock('file', entry.label, content))
      } catch {
        blocks.push(`\n\n无法读取文件：${entry.label}`)
      }
    }
    return text + blocks.join('')
  }

  const sendMessage = async (): Promise<void> => {
    const visibleText = input.trim()
    if ((!visibleText && (mode === 'image' || !attachments.length)) || !conversation) return
    if (running && mode !== 'image') {
      if (!activePending || activePending[1].kind !== 'agent') return
      let guidanceContent = await expandMentions(visibleText || '请查看补充附件')
      if (attachCurrent && activeFilePath) {
        const file = openFiles.find((item) => item.path === activeFilePath)
        if (file) {
          guidanceContent += localFileContextBlock('current_file', file.path, file.content)
        }
      }
      if (editorSelection?.text) {
        guidanceContent += `\n\n<selected_code path="${editorSelection.path}" lines="${editorSelection.startLine}-${editorSelection.endLine}">\n${editorSelection.text}\n</selected_code>`
      }
      await window.localAgent.agent.guide({
        requestId: activePending[0],
        content: guidanceContent,
        displayContent: visibleText || '补充了附件与上下文',
        attachments: [...attachments]
      })
      setInput('')
      setAttachments([])
      return
    }
    if (mode === 'image' && hasBlockingPending) {
      setActionNotice('当前聊天或 Agent 任务仍在运行，请结束后再加入图片队列')
      return
    }
    if (mode === 'image') {
      if (!selectedComfyWorkflow) {
        setActionNotice('请先在图片设置中选择本地工作流')
        return
      }
      if (!selectedImageModel) {
        setActionNotice('当前工作流没有可用模型')
        return
      }
      const imageContextCheckpointIndex = conversation.contextMemory
        ? conversation.messages.findIndex(
            (message) => message.id === conversation.contextMemory?.throughMessageId
          )
        : -1
      const imageHistory = conversation.messages
        .slice(imageContextCheckpointIndex + 1)
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => buildContextMessage(message))
      const imageContext = splitContextHistory(imageHistory, conversation.contextMemory)
      const startedAt = Date.now()
      const requestId = uid()
      const userMessage: ChatMessage = {
        id: uid(),
        role: 'user',
        content: visibleText,
        createdAt: startedAt,
        status: 'done',
        meta: `${selectedComfyWorkflow.name} · ${selectedImageModel} · ${selectedImageSizeLabel} · ${selectedImageSteps} Steps`
      }
      const assistantMessage: ChatMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        createdAt: startedAt,
        startedAt,
        status: 'streaming',
        meta: imagePendingCount > 0 ? '等待图片任务开始' : '正在准备图片生成'
      }
      addMessage(conversation.id, userMessage)
      addMessage(conversation.id, assistantMessage)
      registerPending(requestId, {
        conversationId: conversation.id,
        assistantId: assistantMessage.id,
        kind: 'image',
        model: model.model,
        provider: model.provider
      })
      setInput('')
      setAttachments([])
      try {
        await window.localAgent.image.start({
          requestId,
          model,
          baseUrl: comfyBaseUrl,
          workflow: selectedComfyWorkflow,
          prompt: visibleText,
          contextMessages: imageContext.recent,
          historyArchive: imageContext.archive,
          steps: selectedImageSteps,
          width: selectedImageWidth,
          height: selectedImageHeight,
          aspectRatio: selectedImageAspectRatio,
          megapixels: selectedImageMegapixels,
          multiple: selectedImageMultiple,
          checkpoint: selectedImageModel
        })
      } catch (error) {
        updateMessage(conversation.id, assistantMessage.id, (message) => ({
          ...message,
          status: 'error',
          meta: error instanceof Error ? error.message : String(error),
          completedAt: Date.now()
        }))
        clearPending(requestId)
      }
      return
    }
    if (!model.model || !model.baseUrl) {
      addMessage(conversation.id, {
        id: uid(),
        role: 'assistant',
        content: '请先在输入框下方选择一个本地模型。',
        createdAt: Date.now(),
        status: 'error'
      })
      return
    }
    if (mode === 'agent' && !workspaceRoot) {
      addMessage(conversation.id, {
        id: uid(),
        role: 'assistant',
        content: '请先添加项目并设置当前 CWD，Agent 才能操作文件。',
        createdAt: Date.now(),
        status: 'error'
      })
      return
    }

    let modelText = await expandMentions(visibleText)
    if (attachCurrent && activeFilePath) {
      const file = openFiles.find((item) => item.path === activeFilePath)
      if (file) {
        modelText += localFileContextBlock('current_file', file.path, file.content)
      }
    }
    if (editorSelection?.text) {
      modelText += `\n\n<selected_code path="${editorSelection.path}" lines="${editorSelection.startLine}-${editorSelection.endLine}">\n${editorSelection.text}\n</selected_code>`
    }

    const requestAttachments = [...attachments]
    const webToolsAvailable = mode === 'chat'
    const forceWebSearch = mode === 'chat' && webSearchEnabled
    const startedAt = Date.now()
    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      content: visibleText || '请查看附件',
      createdAt: startedAt,
      status: 'done',
      attachments: requestAttachments.map(({ name, kind, mimeType, size, thumbnail, data, text }) => ({
        name,
        kind,
        mimeType,
        size,
        thumbnail,
        data: kind === 'image' ? data : undefined,
        text: kind === 'text' ? text : undefined
      })),
      meta: forceWebSearch
        ? '已要求联网搜索与多来源核验'
        : editorSelection?.text
        ? `已携带 ${editorSelection.path.split(/[\\/]/).pop()} 第 ${editorSelection.startLine}-${editorSelection.endLine} 行`
        : attachCurrent && activeFilePath
          ? `已引用 ${activeFilePath.split(/[\\/]/).pop()}`
          : undefined
    }
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      createdAt: startedAt,
      startedAt,
      status: 'streaming',
      meta:
        mode === 'agent'
          ? '等待模型判断下一步'
          : '等待模型结合上下文自主判断'
    }
    const requestId = uid()
    const requestConversation =
      useAppStore
        .getState()
        .conversations.find((item) => item.id === conversation.id) ?? conversation
    addMessage(conversation.id, userMessage)
    addMessage(conversation.id, assistantMessage)
    registerPending(requestId, {
      conversationId: conversation.id,
      assistantId: assistantMessage.id,
      kind: mode,
      model: model.model,
      provider: model.provider
    })
    setInput('')
    setAttachments([])
    setWebSearchEnabled(false)

    const latestTaskMessageId = [...requestConversation.messages]
      .reverse()
      .find((message) => message.agentBlocks?.some((block) => block.type === 'tasks'))?.id
    const contextCheckpointIndex = requestConversation.contextMemory
      ? requestConversation.messages.findIndex(
          (message) => message.id === requestConversation.contextMemory?.throughMessageId
        )
      : -1
    const history = requestConversation.messages
      .slice(contextCheckpointIndex + 1)
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => buildContextMessage(message, latestTaskMessageId))
    const contextHistory = splitContextHistory(history, requestConversation.contextMemory)

    if (mode === 'agent') {
      await window.localAgent.agent.start({
        requestId,
        model,
        objective: modelText,
        workspaceRoot,
        instructions: globalInstructions,
        skills,
        attachments: requestAttachments,
        permissionMode: agentPermissionMode,
        contextMessages: contextHistory.recent,
        historyArchive: contextHistory.archive
      })
    } else {
      await window.localAgent.chat.start({
        requestId,
        model,
        instructions: globalInstructions,
        attachments: requestAttachments,
        webSearch: webToolsAvailable,
        forceWebSearch,
        messages: [...contextHistory.recent, { role: 'user', content: modelText }],
        historyArchive: contextHistory.archive
      })
    }
  }

  const stop = async (): Promise<void> => {
    if (!activePending) return
    const [requestId, info] = activePending
    if (info.kind === 'agent') await window.localAgent.agent.stop(requestId)
    else if (info.kind === 'image') {
      await window.localAgent.image.stop(requestId, comfyBaseUrl)
    } else await window.localAgent.chat.stop(requestId)
    updateMessage(info.conversationId, info.assistantId, (message) => ({
      ...message,
      status: 'done',
      meta: '用户已终止本轮任务',
      stoppedByUser: true,
      completedAt: Date.now(),
      agentBlocks: message.agentBlocks?.map((block) => {
        if (block.type === 'thinking' && block.status !== 'done') {
          return { ...block, status: 'done' as const, updatedAt: Date.now() }
        }
        if (
          block.type === 'operation' &&
          (block.status === 'running' || block.status === 'waiting')
        ) {
          return { ...block, status: 'done' as const, completedAt: Date.now() }
        }
        return block
      })
    }))
    clearPending(requestId)
  }

  const resolveApproval = async (approved: boolean): Promise<void> => {
    if (!agentApproval) return
    await window.localAgent.agent.approve(
      agentApproval.requestId,
      agentApproval.approvalId,
      approved
    )
    setAgentApproval(null)
  }

  const retryMessage = (messageIndex: number): void => {
    const previous = [...messages]
      .slice(0, messageIndex)
      .reverse()
      .find((message) => message.role === 'user')
    if (!previous) return
    setInput(previous.content)
    if (messages[messageIndex]?.agentSteps?.length) setMode('agent')
  }

  const chooseMention = (entry: MentionEntry): void => {
    setInput((current) => current.replace(/@([^\s@\[\]]*)$/, `@[${entry.label}] `))
  }

  const scrollToLatest = (): void => {
    const scroll = (): void => {
      virtuosoRef.current?.scrollToIndex({
        index: Math.max(0, messages.length - 1),
        align: 'end',
        behavior: 'auto'
      })
      virtuosoRef.current?.scrollTo({
        top: Number.MAX_SAFE_INTEGER,
        behavior: 'auto'
      })
    }
    scroll()
    window.requestAnimationFrame(scroll)
    window.setTimeout(scroll, 120)
  }

  return (
    <section className="chat-panel">
      <header className="panel-header chat-header">
        <div className="session-history-wrap" ref={sessionPanelRef}>
          <button
            className={`session-current ${showSessions ? 'active' : ''}`}
            onClick={() => setShowSessions((value) => !value)}
          >
            <History size={14} />
            <span>{conversation?.title || '新会话'}</span>
            <ChevronDown size={13} />
          </button>
          {mode === 'chat' && (
            <button
              className={`composer-tool ${webSearchEnabled ? 'active' : ''}`}
              onClick={() => setWebSearchEnabled((value) => !value)}
              title="默认由模型自主判断；点亮后强制本轮联网核验"
            >
              <Globe2 size={14} /> 强制联网
            </button>
          )}
          {showSessions && (
            <div className="session-popover">
              <header>
                <div className="session-search">
                  <SearchIcon size={13} />
                  <input
                    autoFocus
                    value={sessionQuery}
                    onChange={(event) => setSessionQuery(event.target.value)}
                    placeholder="搜索标题或聊天内容"
                  />
                </div>
                <button
                  className="primary-small subtle-small"
                  onClick={() => {
                    void window.localAgent.app
                      .openConversationCache()
                      .then((folder) => setActionNotice(`已打开会话缓存：${folder}`))
                      .catch((error) =>
                        setActionNotice(error instanceof Error ? error.message : String(error))
                      )
                  }}
                  title="打开会话缓存文件夹"
                >
                  <FolderOpen size={13} /> 缓存
                </button>
                <button
                  className="primary-small"
                  onClick={() => {
                    createConversation()
                    setShowSessions(false)
                  }}
                >
                  <Plus size={13} /> 新建
                </button>
              </header>
              <div className="session-list">
                {filteredConversations.length ? (
                  <Virtuoso
                    data={filteredConversations}
                    computeItemKey={(_index, item) => item.id}
                    itemContent={(_index, item) => (
                      <div
                        className={`session-row ${
                          item.id === activeConversationId ? 'active' : ''
                        }`}
                      >
                        <button
                          className="session-row-main"
                          onClick={() => {
                            setActiveConversation(item.id)
                            setShowSessions(false)
                          }}
                        >
                          <strong>{item.title}</strong>
                          <span>
                            {new Date(item.updatedAt).toLocaleString('zh-CN', {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                            {' · '}
                            {item.messages.length} 条消息
                          </span>
                        </button>
                        <button
                          className="session-row-delete"
                          onClick={() => deleteConversation(item.id)}
                          title="删除会话"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  />
                ) : (
                  <div className="session-empty">未找到聊天记录</div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="header-actions">
          <button className="icon-button" onClick={() => createConversation()} title="新会话">
            <Plus size={16} />
          </button>
          <button
            className="icon-button"
            onClick={() => deleteConversation(activeConversationId)}
            title="删除会话"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>

      <div className="chat-scroll-region" ref={scrollRegionRef}>
        {floatingTaskState && (
          <FloatingTaskProgress
            block={floatingTaskState.block}
            messageStatus={floatingTaskState.messageStatus}
          />
        )}
        <div className="message-list">
          {messages.length ? (
            <Virtuoso
              key={conversation?.id}
              ref={virtuosoRef}
              data={messages}
              computeItemKey={(_index, message) => message.id}
              followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
              atBottomThreshold={96}
              increaseViewportBy={{ top: 500, bottom: 700 }}
              rangeChanged={setVisibleRange}
              atBottomStateChange={setAtBottom}
              itemContent={(index, message) => (
                <MessageCard
                  message={message}
                  onReview={(checkpointId) =>
                    useAppStore.getState().setReviewCheckpointId(checkpointId)
                  }
                  onRetry={() => retryMessage(index)}
                  userContentExpanded={expandedUserMessageIds.has(message.id)}
                  onToggleUserContent={() =>
                    setExpandedUserMessageIds((current) => {
                      const next = new Set(current)
                      if (next.has(message.id)) next.delete(message.id)
                      else next.add(message.id)
                      return next
                    })
                  }
                  onPreviewImage={setPreviewImage}
                  onImageContextMenu={openImageContextMenu}
                />
              )}
              components={{ Footer: () => <div className="message-list-footer" /> }}
            />
          ) : (
            <div className="empty-chat">
              <div className="empty-orb">
                {mode === 'agent' ? (
                  <Bot size={32} />
                ) : mode === 'image' ? (
                  <ImageIcon size={30} />
                ) : (
                  <MessageSquareText size={30} />
                )}
              </div>
              <h2>
                {mode === 'agent'
                  ? '交给 Agent 处理'
                  : mode === 'image'
                    ? '使用本地工作流生成图片'
                    : '开始本地对话'}
              </h2>
              <p>
                {mode === 'agent'
                  ? '描述目标，Agent 会按专业流程读取、精准修改并验证文件。'
                  : mode === 'image'
                    ? '选择 ComfyUI 工作流、模型与 Steps，输入中文画面描述即可。'
                    : '支持文本、代码、Markdown、图片、文件和截图粘贴。'}
              </p>
            </div>
          )}
        </div>
        {messages.length > 0 && !atBottom && (
          <button
            className="scroll-to-bottom-button"
            onClick={scrollToLatest}
            title="回到底部"
          >
            <ChevronDown size={17} />
          </button>
        )}
        {messages.length > 3 && (
          <ChatMinimap
            messages={messages}
            range={visibleRange}
            onJump={(index) =>
              virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
            }
          />
        )}
      </div>

      {approvalForConversation && (
        <InlineApprovalCard
          approval={approvalForConversation}
          blocked={approvalBlocked}
          onResolve={(value) => void resolveApproval(value)}
        />
      )}

      <div
        className={`composer-wrap mode-${mode}`}
        onDragOver={(event) => {
          event.preventDefault()
          event.currentTarget.classList.add('dragging')
        }}
        onDragLeave={(event) => event.currentTarget.classList.remove('dragging')}
        onDrop={(event) => {
          event.preventDefault()
          event.currentTarget.classList.remove('dragging')
          void addFiles(event.dataTransfer.files)
        }}
      >
        <input
          ref={fileInputRef}
          className="hidden-file-input"
          type="file"
          multiple
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files)
            event.target.value = ''
          }}
        />

        {actionNotice && (
          <button className="composer-notice" onClick={() => setActionNotice('')}>
            {actionNotice}
            <X size={11} />
          </button>
        )}

        {mode === 'image' && imageQueueItems.length > 0 && (
          <section className={`image-queue-panel ${imageQueueOpen ? 'open' : ''}`}>
            <button
              className="image-queue-summary"
              onClick={() => setImageQueueOpen((value) => !value)}
            >
              <span>
                <ImageIcon size={13} />
                图片生成队列
                <i>{imageQueueItems.length}</i>
              </span>
              <small>
                {imageQueueItems.filter((item) => !item.queued).length} 项生成中
              </small>
              <ChevronDown size={14} />
            </button>
            {imageQueueOpen && (
              <div className="image-queue-list">
                {imageQueueItems.map((item, index) => (
                  <article className={item.queued ? 'queued' : 'running'} key={item.requestId}>
                    <span>{item.queued ? index + 1 : <LoaderCircle size={12} className="spin" />}</span>
                    <div>
                      <strong>{item.title}</strong>
                      <small>{item.status}</small>
                    </div>
                    <button
                      onClick={() => void stopImageRequest(item.requestId)}
                      title="停止此图片任务"
                    >
                      <X size={12} />
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {mode !== 'image' && (attachments.length > 0 || editorSelection?.text) && (
          <div className="attachment-strip">
            {editorSelection?.text && (
              <span className="selection-chip">
                <Code2 size={12} />
                {editorSelection.path.split(/[\\/]/).pop()}：第 {editorSelection.startLine}-
                {editorSelection.endLine} 行
              </span>
            )}
            {attachments.map((attachment, index) => (
              attachment.kind === 'image' && attachment.thumbnail ? (
                <figure
                  className="image-attachment-chip clickable"
                  key={`${attachment.name}-${index}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`预览图片：${attachment.name}`}
                  title="点击预览大图"
                  onClick={() =>
                    setPreviewImage({
                      src: attachment.data || attachment.thumbnail!,
                      name: attachment.name
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    setPreviewImage({
                      src: attachment.data || attachment.thumbnail!,
                      name: attachment.name
                    })
                  }}
                >
                  <img src={attachment.thumbnail} alt={attachment.name} />
                  <button
                    type="button"
                    title="移除图片"
                    onClick={(event) => {
                      event.stopPropagation()
                      setAttachments((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <X size={12} />
                  </button>
                  <figcaption>{attachment.name}</figcaption>
                </figure>
              ) : (
                <span className="attachment-chip" key={`${attachment.name}-${index}`}>
                  <File size={12} />
                  {attachment.name}
                  <button
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                  >
                    <X size={11} />
                  </button>
                </span>
              )
            ))}
          </div>
        )}

        <div className="composer-tools">
          {mode !== 'image' ? (
            <>
              <button className="composer-tool" onClick={() => fileInputRef.current?.click()}>
                <Paperclip size={14} /> 添加文件
              </button>
              <button
                className={`composer-tool ${attachCurrent ? 'active' : ''}`}
                onClick={() => setAttachCurrent((value) => !value)}
                disabled={!activeFilePath}
                title={activeFilePath ? '引用当前文件' : '请先打开文件'}
              >
                <FilePlus2 size={14} />
                {attachCurrent && activeFilePath
                  ? activeFilePath.split(/[\\/]/).pop()
                  : '当前文件'}
              </button>
            </>
          ) : (
            <>
              <button
                className="image-settings-trigger"
                onClick={() => setImageSettingsOpen(true)}
                title="打开图片生成设置"
              >
                <Settings2 size={13} />
                <span>
                  {selectedComfyWorkflow
                    ? `${selectedComfyWorkflow.name} · ${selectedImageSizeLabel} · ${selectedImageSteps} Steps`
                    : discoveringWorkflows
                      ? '正在读取本地工作流'
                      : '配置图片生成'}
                </span>
              </button>
              {imagePendingCount > 0 && (
                <span className="image-queue-badge">队列 {imagePendingCount}</span>
              )}
            </>
          )}
          {mode === 'agent' && (
            <span className="agent-scope">
              <FilePlus2 size={13} />
              {workspaceRoot ? `CWD：${workspaceRoot.split(/[\\/]/).pop()}` : '未设置 CWD'}
            </span>
          )}
        </div>

        <div
          className={`composer ${
            running && activePending?.[1].kind === 'agent' ? 'accepting-guidance' : ''
          } ${mode === 'image' && imagePendingCount > 0 ? 'image-queue-active' : ''}`}
        >
          <div className="composer-mode-indicator" aria-live="polite">
            {mode === 'agent' ? (
              <Bot size={12} />
            ) : mode === 'image' ? (
              <ImageIcon size={12} />
            ) : (
              <MessageSquareText size={12} />
            )}
            <strong>{mode === 'agent' ? 'Agent 执行' : mode === 'image' ? '图片生成' : 'Chat 对话'}</strong>
            <span>
              {mode === 'agent'
                ? '可读取并操作项目'
                : mode === 'image'
                  ? '调用 ComfyUI 工作流'
                  : '轻量问答与联网查询'}
            </span>
          </div>
          {mode !== 'image' && mentionSuggestions.length > 0 && (
            <div className="mention-popup">
              <div className="mention-title">
                <AtSign size={12} /> 引用文件
              </div>
              {mentionSuggestions.map((entry) => (
                <button key={entry.path} onMouseDown={() => chooseMention(entry)}>
                  <FileTextIcon />
                  <span>{entry.label}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            disabled={false}
            readOnly={false}
            aria-disabled="false"
            onChange={(event) => setInput(event.target.value)}
            onPaste={(event) => {
              if (mode === 'image') return
              const files = event.clipboardData.files
              if (files.length) {
                event.preventDefault()
                void addFiles(files)
                return
              }
              const pastedText = event.clipboardData.getData('text/plain')
              if (
                pastedText.length >= LONG_PASTE_ATTACHMENT_THRESHOLD &&
                attachments.length < MAX_MESSAGE_ATTACHMENTS
              ) {
                event.preventDefault()
                addPastedTextAttachment(pastedText)
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && mentionSuggestions.length === 0) {
                event.preventDefault()
                void sendMessage()
              }
            }}
            placeholder={
              running && activePending?.[1].kind === 'agent'
                ? 'Agent 正在工作，可随时补充细节或纠正方向'
                : mode === 'agent'
                ? '描述任务，输入 @ 引用文件，高亮代码会自动携带'
                : mode === 'image'
                  ? '用中文描述想要的画面，AI 会生成并丰富英文 Prompt'
                  : '输入消息，支持 @文件、拖入附件和粘贴截图'
            }
            rows={3}
          />
          {mode === 'image' ? (
            <>
              <button
                className={`send-button ${imagePendingCount > 0 ? 'queue-add' : ''}`}
                onClick={() => void sendMessage()}
                disabled={!input.trim() || !selectedComfyWorkflow || hasBlockingPending}
                title={imagePendingCount > 0 ? '加入图片队列' : '生成图片'}
              >
                {imagePendingCount > 0 ? <Plus size={16} /> : <Sparkles size={16} />}
              </button>
              {imagePendingCount > 0 && (
                <button
                  className="send-button stop image-stop"
                  onClick={() => void stop()}
                  title="停止当前图片生成"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              )}
            </>
          ) : running ? (
            <>
              {activePending?.[1].kind === 'agent' && (
                <button
                  className="send-button guide"
                  onClick={() => void sendMessage()}
                  disabled={!input.trim() && !attachments.length}
                  title="发送运行中引导"
                >
                  <Send size={16} />
                </button>
              )}
              <button className="send-button stop" onClick={() => void stop()} title="停止">
                <Square size={15} fill="currentColor" />
              </button>
            </>
          ) : (
            <button
              className="send-button"
              onClick={() => void sendMessage()}
              disabled={!input.trim() && !attachments.length}
              title="发送"
            >
              <Send size={17} />
            </button>
          )}
        </div>

        <div className="composer-footer-controls">
          <div className="mode-switch" aria-label="对话模式">
            <button
              className={mode === 'chat' ? 'active' : ''}
              onClick={() => setMode('chat')}
            >
              <MessageSquareText size={13} /> Chat
            </button>
            <button
              className={mode === 'agent' ? 'active' : ''}
              onClick={() => setMode('agent')}
            >
              <Bot size={13} /> Agent
            </button>
            <button
              className={mode === 'image' ? 'active' : ''}
              onClick={() => setMode('image')}
            >
              <ImageIcon size={13} /> 图片
            </button>
          </div>
          {mode === 'agent' && (
            <>
              <label className="permission-picker" title="控制 Agent 可执行的操作">
                <ShieldCheck size={13} />
                <select
                  value={agentPermissionMode}
                  onChange={(event) =>
                    setAgentPermissionMode(event.target.value as AgentPermissionMode)
                  }
                >
                  <option value="read-only">只读</option>
                  <option value="read-write-manual">读写（手动）</option>
                  <option value="read-write-auto">读写（自动）</option>
                </select>
              </label>
            </>
          )}
          <div className="model-picker">
            <span
              className={`status-dot ${
                selectedModelId && (model.preset !== 'kimi-code' || model.apiKey)
                  ? 'online'
                  : 'offline'
              }`}
            />
            <select
              value={selectedModelId}
              onChange={(event) => {
                const selected = displayedModels.find((item) => item.id === event.target.value)
                if (!selected) {
                  setModel({
                    ...model,
                    model: '',
                    baseUrl: '',
                    apiKey: undefined,
                    preset: undefined,
                    contextLength: undefined,
                    maxContextLength: undefined
                  })
                  return
                }
                void (async () => {
                  const apiKey =
                    selected.preset === 'kimi-code'
                      ? await window.localAgent.credentials.getKimiCodeApiKey()
                      : undefined
                  if (selected.preset === 'kimi-code' && !apiKey) {
                    setActionNotice('请先在设置中填写并保存 Kimi Code API Key')
                  } else {
                    setActionNotice('')
                  }
                  setModel({
                    provider: selected.provider,
                    baseUrl: selected.baseUrl,
                    model: selected.name,
                    apiKey: apiKey || undefined,
                    preset: selected.preset,
                    contextLength: selected.contextLength,
                    maxContextLength: selected.maxContextLength
                  })
                })()
              }}
            >
              <option value="">
                {discovering
                  ? '正在扫描本地模型…'
                  : '选择模型'}
              </option>
              {(['Kimi Code', 'Ollama', 'LM Studio', 'llama.cpp'] as const).map((source) => {
                const options = displayedModels.filter((item) => item.source === source)
                if (!options.length) return null
                return (
                  <optgroup key={source} label={source}>
                    {options.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.contextLength
                          ? ` · ${Math.round(item.contextLength / 1024)}K`
                          : ''}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
            </select>
            <button
              className="model-refresh"
              onClick={() => void discoverModels()}
              disabled={discovering}
              title="重新扫描 Ollama 与 LM Studio"
            >
              <RefreshCw size={13} className={discovering ? 'spin' : ''} />
            </button>
          </div>
        </div>
      </div>

      {mode === 'image' && imageSettingsOpen && (
        <div
          className="image-settings-backdrop"
          role="presentation"
          onPointerDown={() => setImageSettingsOpen(false)}
        >
          <section
            className="image-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="图片生成设置"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="image-settings-icon"><ImageIcon size={18} /></span>
                <div>
                  <strong>图片生成设置</strong>
                  <small>配置实时生效，直接调用本地 ComfyUI 工作流</small>
                </div>
              </div>
              <button onClick={() => setImageSettingsOpen(false)} title="关闭">
                <X size={17} />
              </button>
            </header>

            <div className="image-settings-content">
              <section className="image-settings-card">
                <div className="image-settings-card-title">
                  <div>
                    <strong>本地工作流</strong>
                    <small>自动读取 G:\StabilityMatrix\data</small>
                  </div>
                  <button
                    className="image-settings-refresh"
                    onClick={() => void discoverComfyWorkflows()}
                    disabled={discoveringWorkflows}
                    title="重新读取本地工作流"
                  >
                    <RefreshCw size={14} className={discoveringWorkflows ? 'spin' : ''} />
                    刷新
                  </button>
                </div>
                {selectedComfyWorkflow ? (
                  <label className="image-settings-field">
                    <span>工作流</span>
                    <select
                      value={selectedComfyWorkflow.id}
                      onChange={(event) => setSelectedComfyWorkflowId(event.target.value)}
                    >
                      {comfyWorkflows.map((workflow) => (
                        <option value={workflow.id} key={workflow.id}>
                          {workflow.name}
                        </option>
                      ))}
                    </select>
                    <small title={selectedComfyWorkflow.sourcePath}>
                      {selectedComfyWorkflow.sourcePath}
                    </small>
                  </label>
                ) : (
                  <div className="image-settings-empty">
                    {discoveringWorkflows ? (
                      <><LoaderCircle size={18} className="spin" /> 正在读取本地工作流</>
                    ) : (
                      <><ImageIcon size={18} /> 暂未发现可执行的图片工作流</>
                    )}
                  </div>
                )}
              </section>

              <section className="image-settings-card">
                <div className="image-settings-card-title">
                  <div>
                    <strong>生成参数</strong>
                    <small>保留工作流中的 VAE 与其余节点配置</small>
                  </div>
                </div>
                <div className="image-settings-grid">
                  <label className="image-settings-field">
                    <span>模型</span>
                    <select
                      value={selectedImageModel}
                      disabled={!selectedComfyWorkflow}
                      onChange={(event) =>
                        selectedComfyWorkflow &&
                        updateComfyWorkflow(selectedComfyWorkflow.id, {
                          selectedModel: event.target.value
                        })
                      }
                    >
                      {imageModelOptions.map((item) => (
                        <option value={item} key={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                  <label className="image-settings-field image-settings-steps">
                    <span>Steps</span>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={selectedImageSteps}
                      disabled={!selectedComfyWorkflow}
                      onChange={(event) =>
                        selectedComfyWorkflow &&
                        updateComfyWorkflow(selectedComfyWorkflow.id, {
                          selectedSteps: Math.max(
                            1,
                            Math.min(200, Number(event.target.value) || 1)
                          )
                        })
                      }
                    />
                  </label>
                </div>
                {selectedComfyWorkflow?.sizeMode === 'aspect_ratio' ? (
                  <>
                    <div className="image-settings-grid">
                      <label className="image-settings-field">
                        <span>画面比例</span>
                        <select
                          value={selectedImageAspectRatio}
                          onChange={(event) =>
                            updateComfyWorkflow(selectedComfyWorkflow.id, {
                              selectedAspectRatio: event.target.value
                            })
                          }
                        >
                          {imageAspectRatioOptions.map((ratio) => (
                            <option value={ratio} key={ratio}>
                              {ratio}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="image-settings-field image-settings-steps">
                        <span>百万像素</span>
                        <input
                          type="number"
                          min={0.1}
                          max={16}
                          step={0.1}
                          value={selectedImageMegapixels}
                          disabled={!selectedComfyWorkflow.megapixelsNodeId}
                          onChange={(event) =>
                            updateComfyWorkflow(selectedComfyWorkflow.id, {
                              selectedMegapixels: Math.max(
                                0.1,
                                Math.min(16, Number(event.target.value) || 0.1)
                              )
                            })
                          }
                        />
                      </label>
                    </div>
                    <small className="image-size-note">
                      已读取 {selectedComfyWorkflow.aspectRatioNodeClass || '比例节点'}
                      {selectedAspectResolution
                        ? `，预计输出 ${selectedAspectResolution.width}×${selectedAspectResolution.height}`
                        : '，生成尺寸由工作流计算'}
                    </small>
                  </>
                ) : selectedComfyWorkflow?.sizeMode === 'dimensions' ? (
                  <div className="image-size-grid">
                    <label className="image-settings-field">
                      <span>宽度</span>
                      <input
                        type="number"
                        min={64}
                        max={8192}
                        step={64}
                        value={selectedImageWidth}
                        onChange={(event) =>
                          updateComfyWorkflow(selectedComfyWorkflow.id, {
                            selectedWidth: Math.max(
                              64,
                              Math.min(8192, Number(event.target.value) || 64)
                            )
                          })
                        }
                      />
                    </label>
                    <span className="image-size-separator">×</span>
                    <label className="image-settings-field">
                      <span>高度</span>
                      <input
                        type="number"
                        min={64}
                        max={8192}
                        step={64}
                        value={selectedImageHeight}
                        onChange={(event) =>
                          updateComfyWorkflow(selectedComfyWorkflow.id, {
                            selectedHeight: Math.max(
                              64,
                              Math.min(8192, Number(event.target.value) || 64)
                            )
                          })
                        }
                      />
                    </label>
                  </div>
                ) : (
                  selectedComfyWorkflow && (
                    <small className="image-size-note">
                      尺寸由工作流节点链计算，应用会保留原始比例、缩放与输入图片配置
                    </small>
                  )
                )}
              </section>

              <section className="image-settings-card">
                <div className="image-settings-card-title">
                  <div>
                    <strong>ComfyUI 服务</strong>
                    <small>{comfyInspection?.message || '等待连接检测'}</small>
                  </div>
                  <span className={`comfy-state ${comfyInspection?.connected ? 'online' : ''}`}>
                    <i />
                    {inspectingComfy
                      ? '检测中'
                      : comfyInspection?.connected
                        ? '已连接'
                        : '未连接'}
                  </span>
                </div>
                <label className="image-settings-field">
                  <span>服务地址</span>
                  <input
                    value={comfyBaseUrl}
                    onChange={(event) => setComfyBaseUrl(event.target.value)}
                    placeholder="http://127.0.0.1:8188"
                  />
                </label>
                <button
                  className="image-unload-button"
                  onClick={() => void unloadComfyModels()}
                  disabled={freeingComfy || imagePendingCount > 0}
                  title={imagePendingCount > 0 ? '图片队列运行时不能卸载模型' : '卸载图片模型并释放显存'}
                >
                  {freeingComfy ? <LoaderCircle size={14} className="spin" /> : <Square size={12} />}
                  {freeingComfy ? '正在释放显存' : '卸载当前图片模型'}
                </button>
              </section>
            </div>
          </section>
        </div>
      )}

      {previewImage && (
        <div
          className="message-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`图片预览：${previewImage.name}`}
          onPointerDown={() => setPreviewImage(null)}
        >
          <div
            className="message-image-lightbox-stage"
          >
            <img
              src={previewImage.src}
              alt={previewImage.name}
              onPointerDown={(event) => event.stopPropagation()}
            />
          </div>
        </div>
      )}

      {imageContextMenu && (
        <div
          className="image-context-menu"
          style={{ left: imageContextMenu.x, top: imageContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button onClick={() => void runImageAction('open')}>
            <ExternalLink size={13} /> 打开图片
          </button>
          <button onClick={() => void runImageAction('reveal')}>
            <FolderOpen size={13} /> 在文件夹中显示
          </button>
          <button onClick={() => void runImageAction('saveAs')}>
            <Download size={13} /> 另存为
          </button>
        </div>
      )}
    </section>
  )
}

function FileTextIcon(): React.JSX.Element {
  return <File size={13} />
}
