import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import iconv from 'iconv-lite'
import type {
  FileEncoding,
  FileNode,
  SearchResult,
  TextFileReadResult
} from '../shared/types'

const ignoredNames = new Set([
  '.git',
  'node_modules',
  'out',
  'release',
  'dist',
  'build',
  '.next',
  '.cache',
  '.idea'
])

export function resolveInWorkspace(root: string, inputPath: string): string {
  const absoluteRoot = path.resolve(root)
  const absolute = path.resolve(absoluteRoot, inputPath)
  const relative = path.relative(absoluteRoot, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('目标路径超出当前工作区')
  }
  return absolute
}

function assertContainedPath(root: string, candidate: string): void {
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('工具路径越出当前 CWD，已拒绝执行')
  }
}

export async function resolveSecurelyInWorkspace(
  root: string,
  inputPath: string,
  allowMissing = false
): Promise<string> {
  const candidate = resolveInWorkspace(root, inputPath)
  const realRoot = await fs.realpath(path.resolve(root))
  let probe = candidate
  while (true) {
    let exists = false
    try {
      await fs.lstat(probe)
      exists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (exists) {
      const realProbe = await fs.realpath(probe)
      assertContainedPath(realRoot, realProbe)
      return candidate
    }
    if (!allowMissing) {
      await fs.realpath(candidate)
      return candidate
    }
    const parent = path.dirname(probe)
    if (parent === probe) throw new Error('无法确认工具目标位于当前 CWD')
    probe = parent
  }
}

export async function buildFileTree(root: string, maxDepth = 7): Promise<FileNode[]> {
  let visited = 0

  const walk = async (directory: string, depth: number): Promise<FileNode[]> => {
    if (depth > maxDepth || visited > 6000) return []
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const visible = entries
      .filter((entry) => !ignoredNames.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-CN')
      })

    const nodes: FileNode[] = []
    for (const entry of visible) {
      visited += 1
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: fullPath,
          kind: 'directory',
          children: await walk(fullPath, depth + 1)
        })
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path: fullPath, kind: 'file' })
      }
    }
    return nodes
  }

  return walk(path.resolve(root), 0)
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
}

function hasUtf16LeBom(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
}

function hasUtf16BeBom(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff
}

function looksLikeUtf16(buffer: Buffer): FileEncoding | null {
  const sampleLength = Math.min(buffer.length, 4096)
  if (sampleLength < 4) return null
  let evenZeros = 0
  let oddZeros = 0
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] !== 0) continue
    if (index % 2 === 0) evenZeros += 1
    else oddZeros += 1
  }
  const pairs = Math.floor(sampleLength / 2)
  if (oddZeros / pairs > 0.25 && evenZeros / pairs < 0.08) return 'utf16le'
  if (evenZeros / pairs > 0.25 && oddZeros / pairs < 0.08) return 'utf16be'
  return null
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

export function detectTextEncoding(buffer: Buffer): FileEncoding {
  if (hasUtf8Bom(buffer)) return 'utf8bom'
  if (hasUtf16LeBom(buffer)) return 'utf16le'
  if (hasUtf16BeBom(buffer)) return 'utf16be'
  const utf16 = looksLikeUtf16(buffer)
  if (utf16) return utf16
  if (isValidUtf8(buffer)) return 'utf8'
  // GB18030 is a strict superset of GBK and is the safest automatic fallback
  // for legacy Simplified Chinese text. Users can manually reopen as Big5.
  return 'gb18030'
}

function decodeText(buffer: Buffer, encoding: FileEncoding): string {
  if (encoding === 'utf8bom') return iconv.decode(buffer, 'utf8')
  return iconv.decode(buffer, encoding)
}

function encodeText(content: string, encoding: FileEncoding): Buffer {
  if (encoding === 'utf8bom') return iconv.encode(content, 'utf8', { addBOM: true })
  return iconv.encode(content, encoding)
}

export async function readTextFileDetailed(
  root: string,
  filePath: string,
  requestedEncoding?: FileEncoding
): Promise<TextFileReadResult> {
  const absolute = await resolveSecurelyInWorkspace(root, filePath)
  const stat = await fs.stat(absolute)
  if (stat.size > 8 * 1024 * 1024) throw new Error('文件超过 8MB，请使用外部程序打开')
  const buffer = await fs.readFile(absolute)
  const encoding = requestedEncoding ?? detectTextEncoding(buffer)
  return {
    content: decodeText(buffer, encoding),
    encoding
  }
}

export async function readTextFile(root: string, filePath: string): Promise<string> {
  return (await readTextFileDetailed(root, filePath)).content
}

export async function writeTextFile(
  root: string,
  filePath: string,
  content: string,
  requestedEncoding?: FileEncoding
): Promise<void> {
  const absolute = await resolveSecurelyInWorkspace(root, filePath, true)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  let encoding = requestedEncoding
  if (!encoding) {
    try {
      encoding = detectTextEncoding(await fs.readFile(absolute))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      encoding = 'utf8'
    }
  }
  const temporary = `${absolute}.local-agent-${Date.now()}.tmp`
  await fs.writeFile(temporary, encodeText(content, encoding))
  await fs.rename(temporary, absolute)
}

export async function renameWorkspaceEntry(
  root: string,
  sourcePath: string,
  nextName: string
): Promise<string> {
  const cleanName = nextName.trim()
  if (!cleanName || cleanName.includes('/') || cleanName.includes('\\')) {
    throw new Error('文件名无效')
  }
  const source = await resolveSecurelyInWorkspace(root, sourcePath)
  const target = await resolveSecurelyInWorkspace(
    root,
    path.join(path.dirname(source), cleanName),
    true
  )
  await fs.rename(source, target)
  return target
}

export async function renameWorkspaceRoot(root: string, nextName: string): Promise<string> {
  const cleanName = nextName.trim()
  if (!cleanName || cleanName.includes('/') || cleanName.includes('\\')) {
    throw new Error('文件夹名称无效')
  }
  const source = path.resolve(root)
  const sourceStat = await fs.stat(source)
  if (!sourceStat.isDirectory()) throw new Error('项目根路径不是文件夹')
  const target = path.join(path.dirname(source), cleanName)
  if (path.resolve(target) === source) return source
  try {
    await fs.access(target)
    throw new Error('同级目录中已存在同名文件或文件夹')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await fs.rename(source, target)
  return target
}

export async function deleteWorkspaceEntry(root: string, targetPath: string): Promise<void> {
  const target = await resolveSecurelyInWorkspace(root, targetPath)
  if (path.resolve(target) === path.resolve(root)) throw new Error('不能删除工作区根目录')
  await fs.rm(target, { recursive: true, force: false })
}

export async function createWorkspaceEntry(
  root: string,
  parentPath: string,
  name: string,
  kind: 'file' | 'directory',
  recursive = false
): Promise<string> {
  const cleanName = name.trim()
  if (!cleanName || cleanName.includes('/') || cleanName.includes('\\')) {
    throw new Error('名称无效')
  }
  const parent = resolveInWorkspace(root, parentPath)
  const target = await resolveSecurelyInWorkspace(root, path.join(parent, cleanName), true)
  if (kind === 'directory') await fs.mkdir(target, { recursive })
  else await fs.writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
  return target
}

export async function duplicateWorkspaceEntry(root: string, sourcePath: string): Promise<string> {
  const source = await resolveSecurelyInWorkspace(root, sourcePath)
  const parsed = path.parse(source)
  let index = 1
  let target = ''
  while (true) {
    const suffix = index === 1 ? ' - 副本' : ` - 副本 ${index}`
    target = await resolveSecurelyInWorkspace(
      root,
      path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`),
      true
    )
    try {
      await fs.access(target)
      index += 1
    } catch {
      break
    }
  }
  await fs.cp(source, target, { recursive: true, errorOnExist: true })
  return target
}

export async function copyWorkspaceEntry(
  root: string,
  sourcePath: string,
  targetPath: string
): Promise<string> {
  const source = await resolveSecurelyInWorkspace(root, sourcePath)
  const target = await resolveSecurelyInWorkspace(root, targetPath, true)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(source, target, { recursive: true, errorOnExist: true })
  return target
}

export async function moveWorkspaceEntry(
  root: string,
  sourcePath: string,
  targetPath: string
): Promise<string> {
  const source = await resolveSecurelyInWorkspace(root, sourcePath)
  const target = await resolveSecurelyInWorkspace(root, targetPath, true)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.rename(source, target)
  return target
}

async function resolveWorkspaceTransfer(
  sourceRoot: string,
  sourcePath: string,
  targetRoot: string,
  targetDirectory: string,
  overwrite = false
): Promise<{ source: string; target: string; targetExists: boolean }> {
  const source = await resolveSecurelyInWorkspace(sourceRoot, sourcePath)
  const directory = await resolveSecurelyInWorkspace(targetRoot, targetDirectory)
  const directoryStat = await fs.stat(directory)
  if (!directoryStat.isDirectory()) throw new Error('粘贴或拖拽目标必须是文件夹')
  const sourceStat = await fs.stat(source)
  const target = await resolveSecurelyInWorkspace(
    targetRoot,
    path.join(directory, path.basename(source)),
    true
  )
  const sourceToDirectory = path.relative(source, directory)
  if (
    sourceStat.isDirectory() &&
    (sourceToDirectory === '' ||
      (!sourceToDirectory.startsWith('..') && !path.isAbsolute(sourceToDirectory)))
  ) {
    throw new Error('不能把文件夹移动或复制到自身内部')
  }
  if (path.resolve(source) === path.resolve(target)) {
    throw new Error('来源与目标位置相同')
  }
  let targetExists = false
  try {
    await fs.access(target)
    targetExists = true
  } catch {
    targetExists = false
  }
  if (targetExists && !overwrite) {
    throw new Error(`目标目录已存在“${path.basename(source)}”`)
  }
  return { source, target, targetExists }
}

export async function copyWorkspaceEntryToDirectory(
  sourceRoot: string,
  sourcePath: string,
  targetRoot: string,
  targetDirectory: string,
  overwrite = false
): Promise<string> {
  const { source, target, targetExists } = await resolveWorkspaceTransfer(
    sourceRoot,
    sourcePath,
    targetRoot,
    targetDirectory,
    overwrite
  )
  if (targetExists) await fs.rm(target, { recursive: true, force: false })
  await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false })
  return target
}

export async function moveWorkspaceEntryToDirectory(
  sourceRoot: string,
  sourcePath: string,
  targetRoot: string,
  targetDirectory: string,
  overwrite = false
): Promise<string> {
  const { source, target, targetExists } = await resolveWorkspaceTransfer(
    sourceRoot,
    sourcePath,
    targetRoot,
    targetDirectory,
    overwrite
  )
  if (targetExists) await fs.rm(target, { recursive: true, force: false })
  try {
    await fs.rename(source, target)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV')) {
      throw error
    }
    await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false })
    await fs.rm(source, { recursive: true })
  }
  return target
}

export async function workspaceEntryInfo(
  root: string,
  targetPath: string
): Promise<Record<string, unknown>> {
  const target = await resolveSecurelyInWorkspace(root, targetPath)
  const stat = await fs.stat(target)
  return {
    path: target,
    kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString()
  }
}

function parseSearchGroups(query: string): string[][] {
  return query
    .split('|')
    .map((group) =>
      group
        .split('&')
        .map((term) => term.trim().replace(/^(?:"|')|(?:"|')$/g, '').toLocaleLowerCase())
        .filter(Boolean)
    )
    .filter((group) => group.length > 0)
}

async function searchWorkspaceFallback(
  root: string,
  query: string,
  scopePath = '',
  limit = 160
): Promise<SearchResult[]> {
  const results: SearchResult[] = []
  const groups = parseSearchGroups(query)
  if (!groups.length) return results
  let scanned = 0

  const searchFile = async (fullPath: string): Promise<void> => {
    if (results.length >= limit || scanned >= 2500) return
    scanned += 1
    const stat = await fs.stat(fullPath)
    if (stat.size > 8 * 1024 * 1024) return
    let content: string
    try {
      const buffer = await fs.readFile(fullPath)
      content = decodeText(buffer, detectTextEncoding(buffer))
    } catch {
      return
    }
    if (content.includes('\u0000')) return
    const loweredContent = content.toLocaleLowerCase()
    const matchedGroups = groups.filter((group) =>
      group.every((term) => loweredContent.includes(term))
    )
    if (!matchedGroups.length) return
    const activeTerms = [...new Set(matchedGroups.flat())]
    const lines = content.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (results.length >= limit) return
      const loweredLine = line.toLocaleLowerCase()
      const matches = activeTerms.filter((term) => loweredLine.includes(term))
      if (matches.length) {
        results.push({
          path: fullPath,
          line: index + 1,
          preview: line.trim().slice(0, 220),
          matches
        })
      }
    })
  }

  const walk = async (directory: string): Promise<void> => {
    if (results.length >= limit || scanned >= 2500) return
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= limit || scanned >= 2500) return
      if (ignoredNames.has(entry.name)) continue
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      await searchFile(fullPath)
    }
  }

  const target = scopePath.trim()
    ? await resolveSecurelyInWorkspace(root, scopePath.trim())
    : await resolveSecurelyInWorkspace(root, '.')
  const targetStat = await fs.stat(target)
  if (targetStat.isFile()) await searchFile(target)
  else if (targetStat.isDirectory()) await walk(target)
  else throw new Error(`检索路径既非文件也非目录：${scopePath}`)
  return results
}

type RipgrepJsonMatch = {
  type?: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
  }
}

async function searchWorkspaceWithRipgrep(
  root: string,
  query: string,
  scopePath = '',
  limit = 160
): Promise<SearchResult[]> {
  const groups = parseSearchGroups(query)
  if (!groups.length) return []
  const terms = [...new Set(groups.flat())]
  const target = scopePath.trim()
    ? await resolveSecurelyInWorkspace(root, scopePath.trim())
    : await resolveSecurelyInWorkspace(root, '.')
  const targetStat = await fs.stat(target)
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw new Error(`检索路径既非文件也非目录：${scopePath}`)
  }

  const args = [
    '--json',
    '--line-number',
    '--with-filename',
    '--ignore-case',
    '--fixed-strings',
    '--hidden',
    '--no-messages',
    '--max-filesize',
    '8M'
  ]
  for (const ignoredName of ignoredNames) {
    args.push('--glob', `!${ignoredName}/**`)
  }
  for (const term of terms) args.push('-e', term)
  args.push(target)

  const matchesByFile = new Map<
    string,
    { terms: Set<string>; lines: Map<number, { preview: string; matches: Set<string> }> }
  >()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdoutBuffer = ''
    let stderr = ''
    const consumeLine = (rawLine: string): void => {
      if (!rawLine.trim()) return
      let event: RipgrepJsonMatch
      try {
        event = JSON.parse(rawLine) as RipgrepJsonMatch
      } catch {
        return
      }
      if (event.type !== 'match') return
      const rawPath = event.data?.path?.text
      const lineNumber = Number(event.data?.line_number)
      const lineText = event.data?.lines?.text ?? ''
      if (!rawPath || !Number.isSafeInteger(lineNumber) || lineNumber < 1) return
      const fullPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath)
      const loweredLine = lineText.toLocaleLowerCase()
      const lineMatches = terms.filter((term) => loweredLine.includes(term))
      if (!lineMatches.length) return
      const fileEntry = matchesByFile.get(fullPath) ?? {
        terms: new Set<string>(),
        lines: new Map<number, { preview: string; matches: Set<string> }>()
      }
      const lineEntry = fileEntry.lines.get(lineNumber) ?? {
        preview: lineText.trim().slice(0, 220),
        matches: new Set<string>()
      }
      for (const term of lineMatches) {
        fileEntry.terms.add(term)
        lineEntry.matches.add(term)
      }
      fileEntry.lines.set(lineNumber, lineEntry)
      matchesByFile.set(fullPath, fileEntry)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      consumeLine(stdoutBuffer)
      if (code === 0 || code === 1) resolve()
      else reject(new Error(`ripgrep 执行失败（退出码 ${String(code)}）：${stderr.trim()}`))
    })
  })

  const results: SearchResult[] = []
  for (const [fullPath, fileEntry] of matchesByFile) {
    const matchedGroups = groups.filter((group) => group.every((term) => fileEntry.terms.has(term)))
    if (!matchedGroups.length) continue
    const activeTerms = new Set(matchedGroups.flat())
    for (const [line, lineEntry] of [...fileEntry.lines].sort((left, right) => left[0] - right[0])) {
      const matches = [...lineEntry.matches].filter((term) => activeTerms.has(term))
      if (!matches.length) continue
      results.push({ path: fullPath, line, preview: lineEntry.preview, matches })
      if (results.length >= limit) return results
    }
  }
  return results
}

export async function searchWorkspace(
  root: string,
  query: string,
  scopePath = '',
  limit = 160
): Promise<SearchResult[]> {
  try {
    const results = await searchWorkspaceWithRipgrep(root, query, scopePath, limit)
    if (results.length) return results
  } catch {
    // 安装包缺少平台二进制、进程启动失败或输出异常时，继续使用内置文本扫描兜底。
  }
  // ripgrep 以 UTF-8 为主；GBK、GB18030、Big5 等文本由编码感知扫描补齐。
  return searchWorkspaceFallback(root, query, scopePath, limit)
}
