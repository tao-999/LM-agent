import { useEffect, useMemo, useRef, useState } from 'react'
import Editor, { DiffEditor, type OnChange, type OnMount } from '@monaco-editor/react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Eye,
  FileCode2,
  FileText,
  FolderSearch,
  FolderOpen,
  GitCompareArrows,
  Image as ImageIcon,
  LoaderCircle,
  Palette,
  Play,
  SquareTerminal,
  X
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import {
  editorThemeOptions,
  registerEditorThemes,
  type EditorTheme
} from '../editorThemes'
import { markdownKatexOptions, normalizeMarkdownMath } from '../markdown'
import { useAppStore } from '../store'

type EditorViewState = ReturnType<Parameters<OnMount>[0]['saveViewState']>
type FindSessionState = {
  searchString: string
  replaceString: string
  isRevealed: boolean
  isReplaceRevealed: boolean
  isRegex: boolean
  wholeWord: boolean
  matchCase: boolean
  preserveCase: boolean
  searchScope: unknown
}
type FindController = {
  getState: () => FindSessionState & {
    change: (state: Partial<FindSessionState>, moveCursor: boolean, updateHistory?: boolean) => void
  }
  start: (
    options: {
      forceRevealReplace: boolean
      seedSearchStringFromSelection: 'none'
      seedSearchStringFromNonEmptySelection: boolean
      seedSearchStringFromGlobalClipboard: boolean
      shouldFocus: number
      shouldAnimate: boolean
      updateSearchScope: boolean
      loop: boolean
    },
    state?: Partial<FindSessionState>
  ) => Promise<void>
}

function findController(editor: Parameters<OnMount>[0]): FindController | null {
  return editor.getContribution('editor.contrib.findController') as unknown as FindController | null
}

function IndependentFileEditor({
  filePath,
  content,
  language,
  theme,
  viewStates,
  findSessions,
  onMount,
  onChange
}: {
  filePath: string
  content: string
  language: string
  theme: string
  viewStates: Map<string, EditorViewState>
  findSessions: Map<string, FindSessionState>
  onMount: OnMount
  onChange: OnChange
}): React.JSX.Element {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)

  useEffect(
    () => () => {
      const state = editorRef.current?.saveViewState()
      if (state) viewStates.set(filePath, state)
      if (editorRef.current) {
        const findState = findController(editorRef.current)?.getState()
        if (findState) {
          findSessions.set(filePath, {
            searchString: findState.searchString,
            replaceString: findState.replaceString,
            isRevealed: findState.isRevealed,
            isReplaceRevealed: findState.isReplaceRevealed,
            isRegex: findState.isRegex,
            wholeWord: findState.wholeWord,
            matchCase: findState.matchCase,
            preserveCase: findState.preserveCase,
            searchScope: findState.searchScope
          })
        }
      }
      editorRef.current = null
    },
    [filePath, findSessions, viewStates]
  )

  const mount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    const state = viewStates.get(filePath)
    if (state) editor.restoreViewState(state)
    const findSession = findSessions.get(filePath)
    const controller = findController(editor)
    if (findSession && controller) {
      if (findSession.isRevealed) {
        void controller.start(
          {
            forceRevealReplace: findSession.isReplaceRevealed,
            seedSearchStringFromSelection: 'none',
            seedSearchStringFromNonEmptySelection: false,
            seedSearchStringFromGlobalClipboard: false,
            shouldFocus: 0,
            shouldAnimate: false,
            updateSearchScope: Boolean(findSession.searchScope),
            loop: true
          },
          findSession
        )
      } else {
        controller.getState().change(findSession, false, false)
      }
    }
    onMount(editor, monaco)
  }

  return (
    <Editor
      path={filePath}
      beforeMount={registerEditorThemes}
      value={content}
      language={language}
      theme={theme}
      saveViewState={false}
      keepCurrentModel={false}
      onMount={mount}
      onChange={onChange}
      options={{ automaticLayout: true }}
    />
  )
}

function fileIcon(name: string): React.JSX.Element {
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'md' || extension === 'mdx') return <FileText size={15} />
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension ?? '')) {
    return <ImageIcon size={15} />
  }
  if (
    ['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'cs', 'go', 'rs', 'html', 'css', 'vue'].includes(
      extension ?? ''
    )
  ) {
    return <FileCode2 size={15} />
  }
  return <FileText size={15} />
}

function languageFor(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    py: 'python',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'shell',
    ps1: 'powershell'
  }
  return map[extension ?? ''] ?? 'plaintext'
}

function changedLineCount(before: string, after: string): number {
  const beforeLines = before.split(/\r?\n/)
  const afterLines = after.split(/\r?\n/)
  let start = 0
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1
  }
  let beforeEnd = beforeLines.length - 1
  let afterEnd = afterLines.length - 1
  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    beforeLines[beforeEnd] === afterLines[afterEnd]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  return Math.max(0, beforeEnd - start + 1) + Math.max(0, afterEnd - start + 1)
}

function TerminalPanel({
  root,
  height,
  onClose,
  onResizeStart
}: {
  root: string
  height: number
  onClose: () => void
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const id = crypto.randomUUID()
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: '#090c11',
        foreground: '#d0d6df',
        cursor: '#9d91fa',
        selectionBackground: '#40386e',
        black: '#161a22',
        red: '#ef6a78',
        green: '#48cf89',
        yellow: '#efa85b',
        blue: '#7297ef',
        magenta: '#aa8cf2',
        cyan: '#48c9c4',
        white: '#d8dde6',
        brightBlack: '#5d6675',
        brightWhite: '#ffffff'
      }
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()
    terminal.focus()

    let lineBuffer = ''
    const history: string[] = []
    let historyIndex = 0
    const replaceInput = (value: string): void => {
      for (let index = 0; index < lineBuffer.length; index += 1) terminal.write('\b \b')
      lineBuffer = value
      terminal.write(lineBuffer)
    }
    const input = terminal.onData((data) => {
      if (data === '\r') {
        terminal.write('\r\n')
        if (lineBuffer.trim()) history.push(lineBuffer)
        historyIndex = history.length
        void window.localAgent.terminal.write(id, `${lineBuffer}\r\n`)
        lineBuffer = ''
        return
      }
      if (data === '\u007F') {
        if (lineBuffer.length > 0) {
          lineBuffer = lineBuffer.slice(0, -1)
          terminal.write('\b \b')
        }
        return
      }
      if (data === '\u001b[A') {
        if (historyIndex > 0) historyIndex -= 1
        replaceInput(history[historyIndex] ?? '')
        return
      }
      if (data === '\u001b[B') {
        if (historyIndex < history.length) historyIndex += 1
        replaceInput(history[historyIndex] ?? '')
        return
      }
      if (data === '\u000c') {
        terminal.clear()
        return
      }
      if (/^[\x20-\x7E\u0080-\uFFFF]+$/.test(data)) {
        lineBuffer += data
        terminal.write(data)
      }
    })
    const removeEvent = window.localAgent.terminal.onEvent((event) => {
      if (event.id !== id) return
      terminal.write(event.data)
    })
    void window.localAgent.terminal.create({
      id,
      cwd: root,
      cols: terminal.cols,
      rows: terminal.rows
    })

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        void window.localAgent.terminal.resize(id, terminal.cols, terminal.rows)
      } catch {
        // The terminal may already be disposing.
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      input.dispose()
      removeEvent()
      void window.localAgent.terminal.close(id)
      terminal.dispose()
    }
  }, [root])

  return (
    <section className="terminal-panel real-terminal" style={{ height }}>
      <div
        className="terminal-resize-handle"
        onPointerDown={onResizeStart}
        title="拖动调整终端高度"
      />
      <header>
        <div>
          <SquareTerminal size={14} />
          命令提示符
        </div>
        <button className="icon-button" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div ref={containerRef} className="xterm-host" />
    </section>
  )
}

export function FileWorkspace(): React.JSX.Element {
  const root = useAppStore((state) => state.workspaceRoot)
  const editorTheme = useAppStore((state) => state.editorTheme)
  const setEditorTheme = useAppStore((state) => state.setEditorTheme)
  const workspaceRoots = useAppStore((state) => state.workspaceRoots)
  const openFiles = useAppStore((state) => state.openFiles)
  const activeFilePath = useAppStore((state) => state.activeFilePath)
  const setWorkspace = useAppStore((state) => state.setWorkspace)
  const setActiveFile = useAppStore((state) => state.setActiveFile)
  const openFile = useAppStore((state) => state.openFile)
  const setEditorSelection = useAppStore((state) => state.setEditorSelection)
  const closeFile = useAppStore((state) => state.closeFile)
  const closeOtherFiles = useAppStore((state) => state.closeOtherFiles)
  const closeAllFiles = useAppStore((state) => state.closeAllFiles)
  const reorderOpenFile = useAppStore((state) => state.reorderOpenFile)
  const updateFileContent = useAppStore((state) => state.updateFileContent)
  const markFileSaved = useAppStore((state) => state.markFileSaved)
  const agentApproval = useAppStore((state) => state.agentApproval)
  const agentCheckpoints = useAppStore((state) => state.agentCheckpoints)
  const reviewCheckpointId = useAppStore((state) => state.reviewCheckpointId)
  const setReviewCheckpointId = useAppStore((state) => state.setReviewCheckpointId)
  const [showDiff, setShowDiff] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [copiedSource, setCopiedSource] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const [showRunOutput, setShowRunOutput] = useState(false)
  const [runningFile, setRunningFile] = useState(false)
  const [runResult, setRunResult] = useState<{
    stdout: string
    stderr: string
    exitCode: number
    timedOut: boolean
  } | null>(null)
  const [terminalHeight, setTerminalHeight] = useState(() =>
    Number(localStorage.getItem('layout-terminal-height') || 260)
  )
  const [saveState, setSaveState] = useState('')
  const [draggingTab, setDraggingTab] = useState('')
  const [dragOverTab, setDragOverTab] = useState('')
  const [reviewChangeIndex, setReviewChangeIndex] = useState(0)
  const [tabContext, setTabContext] = useState<{ x: number; y: number; path: string } | null>(
    null
  )
  const tabsRef = useRef<HTMLDivElement>(null)
  const autoSaveTimers = useRef(new Map<string, number>())
  const userEditRevisions = useRef(new Map<string, number>())
  const editorViewStates = useRef(new Map<string, EditorViewState>())
  const editorFindSessions = useRef(new Map<string, FindSessionState>())

  const activeFile = openFiles.find((file) => file.path === activeFilePath)
  const dirty = Boolean(activeFile && activeFile.content !== activeFile.savedContent)
  const isMarkdown = activeFile?.name.toLowerCase().endsWith('.md')
  const hasMarkdownSyntax = Boolean(
    activeFile &&
      /(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\[[^\]]+\]\([^)]+\)|\*\*[^*\n]+\*\*)/m.test(
        activeFile.content
      )
  )
  const canPreviewMarkdown = Boolean(activeFile && (isMarkdown || hasMarkdownSyntax))
  const isImage = Boolean(
    activeFile && /\.(png|jpe?g|gif|webp|svg)$/i.test(activeFile.name)
  )
  const activeLanguage = activeFile ? languageFor(activeFile.name) : ''
  const canRunActive = Boolean(
    activeFile &&
      (/\.(?:html?|svg)$/i.test(activeFile.name) ||
        ['javascript', 'python', 'powershell', 'shell'].includes(activeLanguage) ||
        /\.(?:cmd|bat)$/i.test(activeFile.name))
  )
  const documentStats = useMemo(() => {
    if (!activeFile || isImage) return null
    const content = activeFile.content
    return {
      words: content.replace(/\s/g, '').length,
      characters: content.length,
      lines: content.length === 0 ? 0 : content.split(/\r?\n/).length
    }
  }, [activeFile?.content, activeFile?.path, isImage])
  const approvalChanges =
    agentApproval && ['write', 'create', 'delete'].includes(agentApproval.risk)
      ? agentApproval.changes ?? []
      : []
  const reviewCheckpoint = agentCheckpoints.find((item) => item.id === reviewCheckpointId)
  const reviewChanges = approvalChanges.length
    ? approvalChanges
    : reviewCheckpoint?.changes ?? []
  const reviewChange = reviewChanges[reviewChangeIndex]
  const reviewingApproval = approvalChanges.length > 0
  const reviewOpenFile = reviewChange
    ? openFiles.find((file) => file.path === reviewChange.path)
    : undefined
  const reviewBlocked = Boolean(
    reviewingApproval &&
      reviewOpenFile &&
      reviewOpenFile.content !== reviewChange?.before
  )

  useEffect(() => {
    setReviewChangeIndex(0)
  }, [agentApproval?.approvalId, reviewCheckpointId])

  useEffect(() => {
    if (!reviewChange) return
    const existing = openFiles.find((file) => file.path === reviewChange.path)
    if (existing) {
      setActiveFile(existing.path)
      return
    }
    const content = reviewingApproval ? reviewChange.before : reviewChange.after
    openFile({
      path: reviewChange.path,
      name: reviewChange.path.split(/[\\/]/).pop() ?? reviewChange.path,
      content,
      savedContent: content
    })
  }, [reviewChange?.path, reviewingApproval])

  const openWorkspace = async (): Promise<void> => {
    const result = await window.localAgent.workspace.open()
    if (result) setWorkspace(result.root, result.tree)
  }

  const save = async (): Promise<void> => {
    if (!activeFile) return
    const fileRoot = [...workspaceRoots]
      .sort((left, right) => right.length - left.length)
      .find(
        (item) =>
          activeFile.path === item ||
          activeFile.path.startsWith(`${item}\\`) ||
          activeFile.path.startsWith(`${item}/`)
      )
    if (!fileRoot) return
    await window.localAgent.files.write(fileRoot, activeFile.path, activeFile.content, {
      source: 'user',
      revision: userEditRevisions.current.get(activeFile.path) ?? 0
    })
    markFileSaved(activeFile.path)
    setSaveState('已保存')
    window.setTimeout(() => setSaveState(''), 1200)
  }

  const scheduleAutoSave = (filePath: string, content: string, revision: number): void => {
    const existingTimer = autoSaveTimers.current.get(filePath)
    if (existingTimer) window.clearTimeout(existingTimer)
    setSaveState('等待自动保存')
    const timer = window.setTimeout(async () => {
      autoSaveTimers.current.delete(filePath)
      const fileRoot = [...useAppStore.getState().workspaceRoots]
        .sort((left, right) => right.length - left.length)
        .find(
          (item) =>
            filePath === item ||
            filePath.startsWith(`${item}\\`) ||
            filePath.startsWith(`${item}/`)
        )
      if (!fileRoot) return
      setSaveState('正在自动保存')
      try {
        await window.localAgent.files.write(fileRoot, filePath, content, {
          source: 'user',
          revision
        })
        const current = useAppStore.getState().openFiles.find((file) => file.path === filePath)
        if (current?.content === content) markFileSaved(filePath)
        setSaveState('已自动保存')
        window.setTimeout(() => setSaveState(''), 1200)
      } catch (error) {
        setSaveState(`自动保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }, 450)
    autoSaveTimers.current.set(filePath, timer)
  }

  useEffect(
    () => () => {
      autoSaveTimers.current.forEach((timer) => window.clearTimeout(timer))
      autoSaveTimers.current.clear()
    },
    []
  )

  const runActiveFile = async (): Promise<void> => {
    if (!activeFile || !canRunActive || runningFile) return
    await save()
    if (/\.(?:html?|svg)$/i.test(activeFile.name)) {
      const error = await window.localAgent.files.openExternal(activeFile.path)
      setSaveState(error ? `打开失败：${error}` : '已在默认浏览器打开')
      window.setTimeout(() => setSaveState(''), 1800)
      return
    }
    setRunningFile(true)
    setShowTerminal(false)
    setShowRunOutput(true)
    setRunResult(null)
    try {
      setRunResult(
        await window.localAgent.code.run({
          language: /\.(?:cmd|bat)$/i.test(activeFile.name) ? 'cmd' : activeLanguage,
          code: activeFile.content,
          cwd: root
        })
      )
    } finally {
      setRunningFile(false)
    }
  }

  const closeWithCheck = (filePath: string): void => {
    const file = openFiles.find((item) => item.path === filePath)
    if (file && file.content !== file.savedContent) {
      const accepted = window.confirm(`“${file.name}”存在未保存改动，仍要关闭吗？`)
      if (!accepted) return
    }
    closeFile(filePath)
  }

  const beginTerminalResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = terminalHeight
    document.body.classList.add('is-resizing-vertical')
    const move = (pointerEvent: PointerEvent): void => {
      const next = startHeight + (startY - pointerEvent.clientY)
      setTerminalHeight(Math.max(150, Math.min(620, next)))
    }
    const stop = (): void => {
      document.body.classList.remove('is-resizing-vertical')
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
    localStorage.setItem('layout-terminal-height', String(terminalHeight))
  }, [terminalHeight])

  useEffect(() => {
    if (!tabContext) return
    const close = (): void => setTabContext(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [tabContext])

  useEffect(() => {
    const activeTab = tabsRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    activeTab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    setShowPreview(false)
    setCopiedSource(false)
  }, [activeFilePath])

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  })

  const editorMount: OnMount = (editor) => {
    if (activeFile?.revealLine) {
      editor.revealLineInCenter(activeFile.revealLine)
      editor.setPosition({ lineNumber: activeFile.revealLine, column: 1 })
    }
    editor.onDidChangeCursorSelection((event) => {
      const model = editor.getModel()
      const currentPath = useAppStore.getState().activeFilePath
      if (!model || !currentPath || event.selection.isEmpty()) {
        setEditorSelection(null)
        return
      }
      setEditorSelection({
        path: currentPath,
        text: model.getValueInRange(event.selection),
        startLine: event.selection.startLineNumber,
        endLine: event.selection.endLineNumber
      })
    })
  }

  const relativeRoot = root ? root.split(/[\\/]/).pop() : '未打开工作区'
  const title = useMemo(
    () => activeFile?.path.replace(`${root}\\`, '').replace(`${root}/`, '') ?? '',
    [activeFile, root]
  )
  return (
    <main className="workspace">
      <header className="workspace-toolbar">
        <div className="workspace-title">
          <span className="workspace-title-icon">
            <Code2 size={16} />
          </span>
          <button onClick={() => void openWorkspace()}>{relativeRoot}</button>
          {activeFile && (
            <>
              <span className="crumb">/</span>
              <span>{title}</span>
            </>
          )}
        </div>
        <div className="toolbar-actions">
          {saveState && <span className="save-state">{saveState}</span>}
          {activeFile && !isImage && (
            <label className="editor-theme-picker" title="切换编辑器主题">
              <Palette size={14} />
              <select
                value={editorTheme}
                onChange={(event) => setEditorTheme(event.target.value as EditorTheme)}
                aria-label="编辑器主题"
              >
                <optgroup label="现代主题">
                  {editorThemeOptions.slice(0, 7).map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Monaco 官方">
                  {editorThemeOptions.slice(7).map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          )}
          <button
            className={`toolbar-button ${showDiff ? 'active' : ''}`}
            onClick={() => setShowDiff((value) => !value)}
            disabled={!dirty}
          >
            <GitCompareArrows size={14} /> 差异
          </button>
          {activeFile && !isImage && (
            <button
              className="toolbar-button icon-only"
              onClick={() => {
                void navigator.clipboard.writeText(activeFile.content)
                setCopiedSource(true)
                window.setTimeout(() => setCopiedSource(false), 1200)
              }}
              title={copiedSource ? '原文已复制' : '复制原文'}
              aria-label="复制原文"
            >
              {copiedSource ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}
          {canPreviewMarkdown && (
            <button
              className={`toolbar-button icon-only ${showPreview ? 'active' : ''}`}
              onClick={() => setShowPreview((value) => !value)}
              title={showPreview ? '返回编辑' : '预览 Markdown'}
              aria-label={showPreview ? '返回编辑' : '预览 Markdown'}
            >
              <Eye size={15} />
            </button>
          )}
          {canRunActive && (
            <button
              className="toolbar-button run-file-button"
              onClick={() => void runActiveFile()}
              disabled={runningFile}
              title={/\.(?:html?|svg)$/i.test(activeFile?.name ?? '') ? '在默认浏览器打开' : '运行当前文件'}
            >
              {runningFile ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Play size={14} />
              )}
              {/\.(?:html?|svg)$/i.test(activeFile?.name ?? '') ? '浏览器打开' : '运行'}
            </button>
          )}
        </div>
      </header>

      <div className="workspace-body">
        <section className={`editor-area ${reviewChange ? 'reviewing' : ''}`}>
          {openFiles.length > 0 && (
            <div
              ref={tabsRef}
              className="editor-tabs"
              onWheel={(event) => {
                const target = event.currentTarget
                if (target.scrollWidth <= target.clientWidth) return
                event.preventDefault()
                target.scrollLeft += event.deltaX || event.deltaY
              }}
            >
              {openFiles.map((file) => {
                const fileDirty = file.content !== file.savedContent
                return (
                  <button
                    key={file.path}
                    className={`editor-tab ${file.path === activeFilePath ? 'active' : ''} ${
                      draggingTab === file.path ? 'dragging' : ''
                    } ${dragOverTab === file.path ? 'drag-over' : ''}`}
                    data-active={file.path === activeFilePath}
                    draggable
                    onDragStart={(event) => {
                      setDraggingTab(file.path)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', file.path)
                    }}
                    onDragOver={(event) => {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      setDragOverTab(file.path)
                    }}
                    onDragLeave={() =>
                      setDragOverTab((current) => (current === file.path ? '' : current))
                    }
                    onDrop={(event) => {
                      event.preventDefault()
                      const source = draggingTab || event.dataTransfer.getData('text/plain')
                      if (source) reorderOpenFile(source, file.path)
                      setDraggingTab('')
                      setDragOverTab('')
                    }}
                    onDragEnd={() => {
                      setDraggingTab('')
                      setDragOverTab('')
                    }}
                    onClick={() => setActiveFile(file.path)}
                    onAuxClick={(event) => {
                      if (event.button === 1) closeWithCheck(file.path)
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setActiveFile(file.path)
                      setTabContext({ x: event.clientX, y: event.clientY, path: file.path })
                    }}
                    title={file.path}
                  >
                    {fileIcon(file.name)}
                    <span>{file.name}</span>
                    {fileDirty ? (
                      <i className="dirty-dot" />
                    ) : (
                      <X
                        size={13}
                        className="tab-close"
                        onClick={(event) => {
                          event.stopPropagation()
                          closeWithCheck(file.path)
                        }}
                      />
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {reviewChange && (
            <div className="agent-inline-diff-bar">
              <div className="agent-inline-diff-title">
                <GitCompareArrows size={15} />
                <div>
                  <strong>
                    {reviewingApproval ? '智能体请求修改' : '智能体修改记录'}
                  </strong>
                  <span>
                    {reviewChange.path.split(/[\\/]/).pop()} · 约{' '}
                    {changedLineCount(reviewChange.before, reviewChange.after)} 行变化 · 第{' '}
                    {reviewChangeIndex + 1}/{reviewChanges.length} 项
                  </span>
                </div>
              </div>
              {reviewChanges.length > 1 && (
                <div className="diff-review-nav">
                  <button
                    className="icon-button"
                    disabled={reviewChangeIndex === 0}
                    onClick={() => setReviewChangeIndex((index) => Math.max(0, index - 1))}
                    title="上一项改动"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    className="icon-button"
                    disabled={reviewChangeIndex >= reviewChanges.length - 1}
                    onClick={() =>
                      setReviewChangeIndex((index) =>
                        Math.min(reviewChanges.length - 1, index + 1)
                      )
                    }
                    title="下一项改动"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
              <div className="diff-review-actions">
                {reviewingApproval ? (
                  <span className="diff-approval-hint">
                    请在左侧对话区确认或拒绝
                  </span>
                ) : (
                  <button className="ghost-button" onClick={() => setReviewCheckpointId('')}>
                    <X size={13} /> 关闭 Diff
                  </button>
                )}
              </div>
              {reviewBlocked && (
                <div className="diff-review-warning">
                  当前编辑内容与智能体读取版本冲突，请先保存或撤销手动改动
                </div>
              )}
            </div>
          )}

          <div className="editor-content">
            {reviewChange ? (
              <DiffEditor
                key={`${reviewChange.path}-${reviewChangeIndex}-${reviewingApproval ? 'approval' : 'history'}`}
                beforeMount={registerEditorThemes}
                original={reviewChange.before}
                modified={reviewChange.after}
                language={languageFor(reviewChange.path)}
                theme={editorTheme}
                options={{
                  automaticLayout: true,
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: false,
                  renderMarginRevertIcon: false
                }}
              />
            ) : !activeFile ? (
              <div className="editor-empty">
                <div className="editor-empty-mark">SA</div>
                <h1>星伴 AI</h1>
                <p>打开工作区后选择文件，或在左侧交给星伴处理。</p>
                <button className="primary-button" onClick={() => void openWorkspace()}>
                  <FolderOpen size={16} /> 打开工作区
                </button>
                <div className="shortcut-list">
                  <span>新会话</span>
                  <kbd>Ctrl N</kbd>
                  <span>文件保存</span>
                  <kbd>自动</kbd>
                  <span>搜索</span>
                  <kbd>Ctrl Shift F</kbd>
                </div>
              </div>
            ) : isImage ? (
              <div className="image-preview">
                <img src={`local-file:///${activeFile.path.replace(/\\/g, '/')}`} alt={activeFile.name} />
                <span>{activeFile.name}</span>
              </div>
            ) : showDiff && dirty ? (
              <DiffEditor
                beforeMount={registerEditorThemes}
                original={activeFile.savedContent}
                modified={activeFile.content}
                language={languageFor(activeFile.name)}
                theme={editorTheme}
                options={{
                  automaticLayout: true,
                  renderSideBySide: true
                }}
              />
            ) : showPreview && canPreviewMarkdown ? (
              <div className="markdown-preview">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[[rehypeKatex, markdownKatexOptions], rehypeHighlight]}
                  components={{
                    a: ({ children, ...props }) => (
                      <a {...props} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    )
                  }}
                >
                  {normalizeMarkdownMath(activeFile.content)}
                </ReactMarkdown>
              </div>
            ) : (
              <IndependentFileEditor
                key={activeFile.path}
                filePath={activeFile.path}
                content={activeFile.content}
                language={languageFor(activeFile.name)}
                theme={editorTheme}
                viewStates={editorViewStates.current}
                findSessions={editorFindSessions.current}
                onMount={editorMount}
                onChange={(value, event) => {
                  const content = value ?? ''
                  const currentFile = useAppStore
                    .getState()
                    .openFiles.find((file) => file.path === activeFile.path)
                  if (
                    currentFile?.content === content &&
                    currentFile.savedContent === content
                  ) {
                    const pendingTimer = autoSaveTimers.current.get(activeFile.path)
                    if (pendingTimer) window.clearTimeout(pendingTimer)
                    autoSaveTimers.current.delete(activeFile.path)
                    return
                  }
                  updateFileContent(activeFile.path, content)
                  const revision = (userEditRevisions.current.get(activeFile.path) ?? 0) + 1
                  userEditRevisions.current.set(activeFile.path, revision)
                  const changes = event.changes
                  const startLine = changes.length
                    ? Math.min(...changes.map((change) => change.range.startLineNumber))
                    : 1
                  const endLine = changes.length
                    ? Math.max(
                        ...changes.map((change) => {
                          const insertedEnd =
                            change.range.startLineNumber +
                            Math.max(0, change.text.split(/\r\n|\r|\n/).length - 1)
                          return Math.max(change.range.endLineNumber, insertedEnd)
                        })
                      )
                    : startLine
                  const fileRoot = [...useAppStore.getState().workspaceRoots]
                    .sort((left, right) => right.length - left.length)
                    .find(
                      (item) =>
                        activeFile.path === item ||
                        activeFile.path.startsWith(`${item}\\`) ||
                        activeFile.path.startsWith(`${item}/`)
                    )
                  if (fileRoot) {
                    window.localAgent.agent.noteUserFileEdit(
                      fileRoot,
                      activeFile.path,
                      revision,
                      startLine,
                      endLine
                    )
                  }
                  scheduleAutoSave(activeFile.path, content, revision)
                }}
              />
            )}
          </div>

          {showTerminal && (
            <TerminalPanel
              root={root}
              height={terminalHeight}
              onResizeStart={beginTerminalResize}
              onClose={() => setShowTerminal(false)}
            />
          )}
          {showRunOutput && (
            <section className="file-run-output">
              <header>
                <div>
                  <Play size={13} />
                  输出 · {activeFile?.name}
                </div>
                <button className="icon-button" onClick={() => setShowRunOutput(false)}>
                  <X size={13} />
                </button>
              </header>
              <pre>
                {runningFile
                  ? '正在运行当前文件…'
                  : runResult
                    ? [
                        runResult.timedOut ? '运行超时' : `退出码：${runResult.exitCode}`,
                        runResult.stdout,
                        runResult.stderr
                      ]
                        .filter(Boolean)
                        .join('\n')
                    : '等待运行结果'}
              </pre>
            </section>
          )}
          <footer className="workspace-bottom-panel-bar">
            <button
              className={showTerminal ? 'active' : ''}
              onClick={() => {
                setShowRunOutput(false)
                setShowTerminal((value) => !value)
              }}
              title={showTerminal ? '收起终端' : '打开终端'}
            >
              <SquareTerminal size={14} />
              终端
            </button>
            {runResult && (
              <button
                className={showRunOutput ? 'active' : ''}
                onClick={() => {
                  setShowTerminal(false)
                  setShowRunOutput((value) => !value)
                }}
              >
                <Play size={13} />
                输出
              </button>
            )}
            {documentStats && (
              <div className="workspace-document-stats" title={`共 ${documentStats.characters.toLocaleString()} 个字符`}>
                <span>总字数 {documentStats.words.toLocaleString()}</span>
                <span>{documentStats.lines.toLocaleString()} 行</span>
              </div>
            )}
            {root && <span className="workspace-root-path">{root}</span>}
          </footer>
        </section>
      </div>
      {tabContext && (
        <div
          className="editor-tab-context"
          style={{ left: tabContext.x, top: tabContext.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            onClick={() => {
              closeWithCheck(tabContext.path)
              setTabContext(null)
            }}
          >
            <X size={14} /> 关闭
          </button>
          <button
            onClick={() => {
              const hasDirtyOthers = openFiles.some(
                (file) =>
                  file.path !== tabContext.path && file.content !== file.savedContent
              )
              if (
                !hasDirtyOthers ||
                window.confirm('其他标签中存在未保存改动，仍要全部关闭吗？')
              ) {
                closeOtherFiles(tabContext.path)
              }
              setTabContext(null)
            }}
          >
            关闭其他
          </button>
          <button
            onClick={() => {
              const hasDirty = openFiles.some((file) => file.content !== file.savedContent)
              if (!hasDirty || window.confirm('存在未保存改动，仍要关闭全部标签吗？')) {
                closeAllFiles()
              }
              setTabContext(null)
            }}
          >
            关闭全部
          </button>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(tabContext.path)
              setTabContext(null)
            }}
          >
            <Copy size={14} /> 复制路径
          </button>
          <button
            onClick={() => {
              void window.localAgent.files.reveal(tabContext.path)
              setTabContext(null)
            }}
          >
            <FolderSearch size={14} /> 在资源管理器中显示
          </button>
        </div>
      )}
    </main>
  )
}
