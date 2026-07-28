import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  cachePdfResponse,
  cleanupExpiredPaperCache,
  isPdfWebResponse,
  searchPaperCache
} from '../src/main/paper-cache.ts'

function responseBody(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength)
  copy.set(buffer)
  return copy.buffer
}

test('PDF 响应解析到 60 分钟缓存并由 grep 引擎检索', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'star-companion-paper-test-'))
  try {
    const pdf = await fs.readFile(
      path.resolve('node_modules/pdf-parse/test/data/01-valid.pdf')
    )
    const response = new Response(
      responseBody(pdf),
      {
      headers: { 'content-type': 'application/pdf' }
      }
    )
    assert.equal(isPdfWebResponse(response, 'https://example.com/paper.pdf'), true)

    const record = await cachePdfResponse(
      response,
      'https://example.com/paper.pdf',
      'Runtime Type Specialization Paper',
      root
    )
    assert.equal(record.pages, 14)
    assert.equal(record.expiresAt - record.createdAt, 60 * 60 * 1000)

    const matches = await searchPaperCache('traditional compilers', 10, root)
    assert.ok(matches.length >= 1)
    assert.equal(matches[0].cacheId, record.cacheId)
    assert.equal(matches[0].page, 1)
    assert.match(matches[0].context, /traditional compilers/i)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('过期论文缓存会同步删除元数据与正文', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'star-companion-paper-expiry-'))
  try {
    const pdf = await fs.readFile(
      path.resolve('node_modules/pdf-parse/test/data/01-valid.pdf')
    )
    const response = new Response(responseBody(pdf), {
      headers: { 'content-type': 'application/pdf' }
    })
    const record = await cachePdfResponse(
      response,
      'https://example.com/expiry.pdf',
      'Expiry Paper',
      root
    )
    const metadata = path.join(root, `${record.cacheId}.json`)
    const textFile = path.join(root, `${record.cacheId}.txt`)
    await fs.writeFile(metadata, JSON.stringify({ ...record, expiresAt: Date.now() - 1 }), 'utf8')
    await cleanupExpiredPaperCache(root)
    await assert.rejects(fs.access(metadata))
    await assert.rejects(fs.access(textFile))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
