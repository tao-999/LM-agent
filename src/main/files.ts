import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileNode, SearchResult } from '../shared/types'

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

export async function readTextFile(root: string, filePath: string): Promise<string> {
  const absolute = await resolveSecurelyInWorkspace(root, filePath)
  const stat = await fs.stat(absolute)
  if (stat.size > 8 * 1024 * 1024) throw new Error('文件超过 8MB，请使用外部程序打开')
  return fs.readFile(absolute, 'utf8')
}

export async function writeTextFile(root: string, filePath: string, content: string): Promise<void> {
  const absolute = await resolveSecurelyInWorkspace(root, filePath, true)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.local-agent-${Date.now()}.tmp`
  await fs.writeFile(temporary, content, 'utf8')
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

export async function searchWorkspace(
  root: string,
  query: string,
  scopePath = '',
  limit = 160
): Promise<SearchResult[]> {
  const results: SearchResult[] = []
  const groups = query
    .split('|')
    .map((group) =>
      group
        .split('&')
        .map((term) => term.trim().replace(/^(?:"|')|(?:"|')$/g, '').toLocaleLowerCase())
        .filter(Boolean)
    )
    .filter((group) => group.length > 0)
  if (!groups.length) return results
  let scanned = 0

  const searchFile = async (fullPath: string): Promise<void> => {
    if (results.length >= limit || scanned >= 2500) return
    scanned += 1
    const stat = await fs.stat(fullPath)
    if (stat.size > 8 * 1024 * 1024) return
    let content: string
    try {
      content = await fs.readFile(fullPath, 'utf8')
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
