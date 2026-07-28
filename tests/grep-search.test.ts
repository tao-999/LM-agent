import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { rgPath } from '@vscode/ripgrep'
import { searchWorkspace } from '../src/main/files.ts'

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'star-companion-grep-'))
  try {
    await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('安装包依赖包含当前平台的 ripgrep 可执行文件', async () => {
  const stat = await fs.stat(rgPath)
  assert.equal(stat.isFile(), true)
})

test('省略 path 时递归检索 CWD 下全部项目文件', async () => {
  await withWorkspace(async (root) => {
    await fs.mkdir(path.join(root, 'docs'), { recursive: true })
    await fs.mkdir(path.join(root, 'src', 'feature'), { recursive: true })
    await fs.writeFile(path.join(root, 'docs', '设定.txt'), '风云世界的无名剑客。', 'utf8')
    await fs.writeFile(path.join(root, 'src', 'feature', 'logic.ts'), 'const hero = "无名"', 'utf8')

    const results = await searchWorkspace(root, '无名')
    const paths = results.map((result) => path.relative(root, result.path).replaceAll('\\', '/'))
    assert.deepEqual(paths.sort(), ['docs/设定.txt', 'src/feature/logic.ts'])
  })
})

test('传入文件或目录 path 时只检索指定范围', async () => {
  await withWorkspace(async (root) => {
    await fs.mkdir(path.join(root, 'docs'), { recursive: true })
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'docs', '人物.txt'), '叶孤星使用剑法。', 'utf8')
    await fs.writeFile(path.join(root, 'src', '剧情.txt'), '叶孤星进入地窖。', 'utf8')

    const directoryResults = await searchWorkspace(root, '叶孤星', 'docs')
    assert.equal(directoryResults.length, 1)
    assert.equal(path.basename(directoryResults[0].path), '人物.txt')

    const fileResults = await searchWorkspace(root, '叶孤星', 'src/剧情.txt')
    assert.equal(fileResults.length, 1)
    assert.equal(path.basename(fileResults[0].path), '剧情.txt')
  })
})

test('grep 表达式支持 OR 与同文件 AND', async () => {
  await withWorkspace(async (root) => {
    await fs.writeFile(path.join(root, 'a.txt'), '降龙十八掌\n乔峰', 'utf8')
    await fs.writeFile(path.join(root, 'b.txt'), '降龙十八掌\n郭靖', 'utf8')
    await fs.writeFile(path.join(root, 'c.txt'), '独孤九剑', 'utf8')

    const results = await searchWorkspace(root, '降龙十八掌 & 乔峰 | 独孤九剑')
    const paths = new Set(results.map((result) => path.basename(result.path)))
    assert.deepEqual([...paths].sort(), ['a.txt', 'c.txt'])
  })
})

test('Agent 暴露 grep 并默认合并本地会话历史', async () => {
  const source = await fs.readFile(path.resolve('src/main/agent.ts'), 'utf8')
  assert.match(source, /tools\.set\('grep'/)
  assert.match(source, /includeHistory[\s\S]*!scopePath/)
  assert.match(source, /searchConversationHistoryArchive\([\s\S]*request\.historyArchive/)
  assert.match(source, /includePapers[\s\S]*searchPaperCache\(query\)/)
})
