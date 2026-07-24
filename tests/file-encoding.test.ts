import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import iconv from 'iconv-lite'
import {
  detectTextEncoding,
  readTextFile,
  readTextFileDetailed,
  searchWorkspace,
  writeTextFile
} from '../src/main/files.ts'

async function withWorkspace(
  run: (root: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'star-companion-encoding-'))
  try {
    await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('自动识别并读取 UTF-8 与 UTF-8 BOM', async () => {
  await withWorkspace(async (root) => {
    const utf8Path = path.join(root, 'utf8.txt')
    const bomPath = path.join(root, 'utf8-bom.txt')
    await fs.writeFile(utf8Path, Buffer.from('星伴 UTF-8', 'utf8'))
    await fs.writeFile(bomPath, iconv.encode('星伴 BOM', 'utf8', { addBOM: true }))

    assert.equal(detectTextEncoding(await fs.readFile(utf8Path)), 'utf8')
    assert.equal(detectTextEncoding(await fs.readFile(bomPath)), 'utf8bom')
    assert.deepEqual(await readTextFileDetailed(root, utf8Path), {
      content: '星伴 UTF-8',
      encoding: 'utf8'
    })
    assert.deepEqual(await readTextFileDetailed(root, bomPath), {
      content: '星伴 BOM',
      encoding: 'utf8bom'
    })
  })
})

test('非 UTF-8 中文自动按 GB18030 读取，也允许手动以 GBK 重开', async () => {
  await withWorkspace(async (root) => {
    const filePath = path.join(root, 'legacy.txt')
    await fs.writeFile(filePath, iconv.encode('江湖风云，中文编码。', 'gbk'))

    assert.equal(detectTextEncoding(await fs.readFile(filePath)), 'gb18030')
    assert.equal(await readTextFile(root, filePath), '江湖风云，中文编码。')
    assert.deepEqual(await readTextFileDetailed(root, filePath, 'gbk'), {
      content: '江湖风云，中文编码。',
      encoding: 'gbk'
    })
  })
})

test('保存时保持原文件编码，显式编码可转换格式', async () => {
  await withWorkspace(async (root) => {
    const filePath = path.join(root, 'keep-gbk.txt')
    await fs.writeFile(filePath, iconv.encode('原文', 'gbk'))

    await writeTextFile(root, filePath, '修改后的中文')
    assert.equal(iconv.decode(await fs.readFile(filePath), 'gbk'), '修改后的中文')
    assert.equal(detectTextEncoding(await fs.readFile(filePath)), 'gb18030')

    await writeTextFile(root, filePath, '转换为 UTF-8', 'utf8')
    assert.equal((await fs.readFile(filePath)).toString('utf8'), '转换为 UTF-8')
    assert.equal(detectTextEncoding(await fs.readFile(filePath)), 'utf8')
  })
})

test('工作区搜索可以检索 GBK 文件内容', async () => {
  await withWorkspace(async (root) => {
    const filePath = path.join(root, '人物设定.txt')
    await fs.writeFile(filePath, iconv.encode('叶孤星使出降龙十八掌。', 'gbk'))

    const results = await searchWorkspace(root, '降龙十八掌', filePath)
    assert.equal(results.length, 1)
    assert.equal(results[0].line, 1)
    assert.match(results[0].preview, /叶孤星/)
  })
})
