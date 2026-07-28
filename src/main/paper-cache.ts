import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { searchWorkspace } from './files.ts'

export const PAPER_CACHE_TTL_MS = 60 * 60 * 1000
const MAX_PDF_BYTES = 50 * 1024 * 1024
const MAX_EXTRACTED_CHARACTERS = 6_000_000
const PAPER_CACHE_DIRECTORY_NAME = 'star-companion-paper-cache'
let pdfParseQueue: Promise<void> = Promise.resolve()
const pdfParseModulePath = createRequire(import.meta.url).resolve('pdf-parse/lib/pdf-parse.js')
const PDF_PARSE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const pdfParse = require(workerData.modulePath)
let renderedPage = 0

async function renderPage(page) {
  renderedPage += 1
  const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
  const lines = []
  let current = ''
  let previousY = null
  for (const item of content.items) {
    const value = typeof item.str === 'string' ? item.str.trim() : ''
    if (!value) continue
    const y = Array.isArray(item.transform) ? Number(item.transform[5]) : Number.NaN
    const newLine = item.hasEOL || (previousY !== null && Number.isFinite(y) && Math.abs(previousY - y) > 2)
    if (newLine && current.trim()) {
      lines.push(current.trim())
      current = ''
    }
    current += (current ? ' ' : '') + value
    if (Number.isFinite(y)) previousY = y
  }
  if (current.trim()) lines.push(current.trim())
  return '\\n\\n===== PDF 第 ' + renderedPage + ' 页 =====\\n' + lines.join('\\n')
}

pdfParse(Buffer.from(workerData.data), { pagerender: renderPage })
  .then((parsed) => parentPort.postMessage({
    ok: true,
    parsed: { numpages: parsed.numpages, info: parsed.info || {}, text: parsed.text || '' }
  }))
  .catch((error) => parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }))
`

export type PaperCacheRecord = {
  cacheId: string
  title: string
  sourceUrl: string
  createdAt: number
  expiresAt: number
  pages: number
  characters: number
  truncated: boolean
  textFile: string
}

export type PaperCacheMatch = {
  cacheId: string
  title: string
  sourceUrl: string
  page: number | null
  line: number
  preview: string
  context: string
  expiresAt: number
}

export function paperCacheDirectory(): string {
  return path.join(os.tmpdir(), PAPER_CACHE_DIRECTORY_NAME)
}

function metadataPath(root: string, cacheId: string): string {
  return path.join(root, `${cacheId}.json`)
}

function textPath(root: string, cacheId: string): string {
  return path.join(root, `${cacheId}.txt`)
}

function cacheIdForUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function titleFromResult(info: Record<string, unknown> | undefined, titleHint: string): string {
  return text(info?.Title) || titleHint.trim() || '未命名论文'
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

type ParsedPdf = {
  numpages: number
  info: Record<string, unknown>
  text: string
}

async function parsePdfInWorker(data: Buffer): Promise<ParsedPdf> {
  return new Promise<ParsedPdf>((resolve, reject) => {
    const worker = new Worker(PDF_PARSE_WORKER_SOURCE, {
      eval: true,
      workerData: { modulePath: pdfParseModulePath, data }
    })
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }
    const timeout = setTimeout(() => {
      finish(() => reject(new Error('PDF 解析超过 90 秒，已停止后台解析')))
      void worker.terminate()
    }, 90_000)
    worker.once('message', (message: { ok?: boolean; parsed?: ParsedPdf; error?: string }) => {
      finish(() => {
        if (message.ok && message.parsed) resolve(message.parsed)
        else reject(new Error(message.error || 'PDF 后台解析失败'))
      })
      void worker.terminate()
    })
    worker.once('error', (error) => finish(() => reject(error)))
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`PDF 解析进程异常退出：${code}`)))
    })
  })
}

async function parsePdfSerially(data: Buffer): Promise<ParsedPdf> {
  const parse = pdfParseQueue.then(() => parsePdfInWorker(data))
  pdfParseQueue = parse.then(
    () => undefined,
    () => undefined
  )
  return parse
}

async function readBoundedPdf(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
    throw new Error(`PDF 文件超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB 安全上限`)
  }
  if (!response.body) throw new Error('PDF 响应没有可读取内容')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_PDF_BYTES) {
        await reader.cancel()
        throw new Error(`PDF 文件超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB 安全上限`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received)
}

async function readRecord(root: string, cacheId: string): Promise<PaperCacheRecord | null> {
  try {
    const record = JSON.parse(
      await fs.readFile(metadataPath(root, cacheId), 'utf8')
    ) as PaperCacheRecord
    if (record.expiresAt <= Date.now()) return null
    await fs.access(textPath(root, cacheId))
    return record
  } catch {
    return null
  }
}

export async function cleanupExpiredPaperCache(root = paperCacheDirectory()): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  const entries = await fs.readdir(root, { withFileTypes: true })
  const now = Date.now()
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const cacheId = entry.name.slice(0, -5)
        try {
          const record = JSON.parse(
            await fs.readFile(path.join(root, entry.name), 'utf8')
          ) as PaperCacheRecord
          if (record.expiresAt > now) return
        } catch {
          // Corrupt metadata is removed with its paired text cache.
        }
        await Promise.allSettled([
          fs.rm(metadataPath(root, cacheId), { force: true }),
          fs.rm(textPath(root, cacheId), { force: true })
        ])
      })
  )
}

export function isPdfWebResponse(response: Response, requestedUrl: string): boolean {
  const contentType = (response.headers.get('content-type') ?? '').toLocaleLowerCase()
  const disposition = (response.headers.get('content-disposition') ?? '').toLocaleLowerCase()
  let pathname = ''
  try {
    pathname = new URL(response.url || requestedUrl).pathname.toLocaleLowerCase()
  } catch {
    pathname = requestedUrl.toLocaleLowerCase()
  }
  return (
    contentType.includes('application/pdf') ||
    disposition.includes('.pdf') ||
    pathname.endsWith('.pdf')
  )
}

export async function cachePdfResponse(
  response: Response,
  requestedUrl: string,
  titleHint = '',
  root = paperCacheDirectory()
): Promise<PaperCacheRecord> {
  await cleanupExpiredPaperCache(root)
  const finalUrl = response.url || requestedUrl
  const cacheId = cacheIdForUrl(finalUrl)
  const cached = await readRecord(root, cacheId)
  if (cached) return cached
  const data = await readBoundedPdf(response)
  const parsed = await parsePdfSerially(data)
  const normalized = normalizeExtractedText(parsed.text)
  if (normalized.length < 80) {
    throw new Error('PDF 没有可检索文本层，可能属于扫描版；当前需要 OCR 才能识别')
  }
  const truncated = normalized.length > MAX_EXTRACTED_CHARACTERS
  const body = normalized.slice(0, MAX_EXTRACTED_CHARACTERS)
  const createdAt = Date.now()
  const expiresAt = createdAt + PAPER_CACHE_TTL_MS
  const title = titleFromResult(parsed.info, titleHint)
  const content = [
    `论文标题：${title}`,
    `来源地址：${finalUrl}`,
    `缓存编号：${cacheId}`,
    `缓存过期：${new Date(expiresAt).toISOString()}`,
    `PDF 页数：${parsed.numpages}`,
    '',
    body,
    truncated ? '\n[本地论文文本达到缓存字符上限，后续内容未写入]' : ''
  ]
    .filter((line) => line !== '')
    .join('\n')
  const record: PaperCacheRecord = {
    cacheId,
    title,
    sourceUrl: finalUrl,
    createdAt,
    expiresAt,
    pages: parsed.numpages,
    characters: body.length,
    truncated,
    textFile: `${cacheId}.txt`
  }
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(textPath(root, cacheId), content, 'utf8')
  await fs.writeFile(metadataPath(root, cacheId), JSON.stringify(record, null, 2), 'utf8')
  return record
}

async function recordsById(root: string): Promise<Map<string, PaperCacheRecord>> {
  const records = new Map<string, PaperCacheRecord>()
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const cacheId = entry.name.slice(0, -5)
    const record = await readRecord(root, cacheId)
    if (record) records.set(cacheId, record)
  }
  return records
}

function pageAtLine(lines: string[], line: number): number | null {
  for (let index = Math.min(lines.length - 1, line - 1); index >= 0; index -= 1) {
    const match = lines[index].match(/^===== PDF 第 (\d+) 页 =====$/)
    if (match) return Number(match[1])
  }
  return null
}

export async function searchPaperCache(
  query: string,
  limit = 40,
  root = paperCacheDirectory()
): Promise<PaperCacheMatch[]> {
  await cleanupExpiredPaperCache(root)
  const records = await recordsById(root)
  if (!records.size) return []
  const matches = await searchWorkspace(root, query, '', Math.max(1, Math.min(80, limit)))
  const linesById = new Map<string, string[]>()
  const output: PaperCacheMatch[] = []
  for (const match of matches) {
    const cacheId = path.basename(match.path, '.txt')
    const record = records.get(cacheId)
    if (!record) continue
    let lines = linesById.get(cacheId)
    if (!lines) {
      lines = (await fs.readFile(match.path, 'utf8')).split(/\r?\n/)
      linesById.set(cacheId, lines)
    }
    const start = Math.max(0, match.line - 6)
    const end = Math.min(lines.length, match.line + 5)
    output.push({
      cacheId,
      title: record.title,
      sourceUrl: record.sourceUrl,
      page: pageAtLine(lines, match.line),
      line: match.line,
      preview: match.preview,
      context: lines
        .slice(start, end)
        .map((lineText, index) => `${start + index + 1} | ${lineText}`)
        .join('\n'),
      expiresAt: record.expiresAt
    })
  }
  return output
}

export async function readPaperCacheText(
  cacheIdValue: string,
  root = paperCacheDirectory()
): Promise<string> {
  const cacheId = cacheIdValue.trim()
  if (!/^[a-f0-9]{24}$/i.test(cacheId)) throw new Error('论文缓存路径无效')
  await cleanupExpiredPaperCache(root)
  const record = await readRecord(root, cacheId)
  if (!record) throw new Error('论文缓存不存在或已超过 60 分钟有效期')
  return fs.readFile(textPath(root, cacheId), 'utf8')
}

export function formatPaperCacheSummary(record: PaperCacheRecord): string {
  return [
    `标题：${record.title}`,
    `地址：${record.sourceUrl}`,
    '来源类型：论文 PDF',
    `PDF 页数：${record.pages}`,
    `本地缓存编号：${record.cacheId}`,
    `缓存文本字符数：${record.characters}`,
    `缓存有效期：${new Date(record.expiresAt).toLocaleString('zh-CN', { hour12: false })}`,
    '正文未直接放入模型上下文。请调用 grep 检索论文关键词；grep 会自动返回本地论文缓存中的页码、行号和相关上下文。'
  ].join('\n')
}
