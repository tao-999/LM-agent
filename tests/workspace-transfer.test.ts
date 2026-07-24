import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  copyWorkspaceEntryToDirectory,
  moveWorkspaceEntryToDirectory
} from '../src/main/files.ts'

test('文件可以复制到另一个项目目录', async (context) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'star-companion-copy-'))
  context.after(() => fs.rm(base, { force: true, recursive: true }))
  const sourceRoot = path.join(base, 'source')
  const targetRoot = path.join(base, 'target')
  await fs.mkdir(sourceRoot)
  await fs.mkdir(targetRoot)
  const source = path.join(sourceRoot, 'a.txt')
  await fs.writeFile(source, 'hello', 'utf8')

  const copied = await copyWorkspaceEntryToDirectory(
    sourceRoot,
    source,
    targetRoot,
    targetRoot
  )

  assert.equal(copied, path.join(targetRoot, 'a.txt'))
  assert.equal(await fs.readFile(copied, 'utf8'), 'hello')
  assert.equal(await fs.readFile(source, 'utf8'), 'hello')
})

test('文件夹可以拖拽移动到另一个项目目录', async (context) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'star-companion-move-'))
  context.after(() => fs.rm(base, { force: true, recursive: true }))
  const sourceRoot = path.join(base, 'source')
  const targetRoot = path.join(base, 'target')
  const sourceDirectory = path.join(sourceRoot, 'assets')
  await fs.mkdir(sourceDirectory, { recursive: true })
  await fs.mkdir(targetRoot)
  await fs.writeFile(path.join(sourceDirectory, 'icon.txt'), 'asset', 'utf8')

  const moved = await moveWorkspaceEntryToDirectory(
    sourceRoot,
    sourceDirectory,
    targetRoot,
    targetRoot
  )

  assert.equal(moved, path.join(targetRoot, 'assets'))
  assert.equal(await fs.readFile(path.join(moved, 'icon.txt'), 'utf8'), 'asset')
  await assert.rejects(fs.access(sourceDirectory))
})

test('禁止把文件夹复制到自身内部', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'star-companion-self-'))
  context.after(() => fs.rm(root, { force: true, recursive: true }))
  const source = path.join(root, 'folder')
  const child = path.join(source, 'child')
  await fs.mkdir(child, { recursive: true })

  await assert.rejects(
    copyWorkspaceEntryToDirectory(root, source, root, child),
    /不能把文件夹移动或复制到自身内部/
  )
})

test('同名文件默认拒绝覆盖，确认后完整替换', async (context) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'star-companion-overwrite-'))
  context.after(() => fs.rm(base, { force: true, recursive: true }))
  const sourceRoot = path.join(base, 'source')
  const targetRoot = path.join(base, 'target')
  await fs.mkdir(sourceRoot)
  await fs.mkdir(targetRoot)
  const source = path.join(sourceRoot, 'same.txt')
  const target = path.join(targetRoot, 'same.txt')
  await fs.writeFile(source, 'new content', 'utf8')
  await fs.writeFile(target, 'old content', 'utf8')

  await assert.rejects(
    copyWorkspaceEntryToDirectory(sourceRoot, source, targetRoot, targetRoot),
    /目标目录已存在/
  )
  assert.equal(await fs.readFile(target, 'utf8'), 'old content')

  await copyWorkspaceEntryToDirectory(sourceRoot, source, targetRoot, targetRoot, true)
  assert.equal(await fs.readFile(target, 'utf8'), 'new content')
})

test('覆盖文件夹会移除目标中的旧内容而非合并', async (context) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'star-companion-overwrite-dir-'))
  context.after(() => fs.rm(base, { force: true, recursive: true }))
  const sourceRoot = path.join(base, 'source')
  const targetRoot = path.join(base, 'target')
  const source = path.join(sourceRoot, 'assets')
  const target = path.join(targetRoot, 'assets')
  await fs.mkdir(source, { recursive: true })
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(path.join(source, 'new.txt'), 'new', 'utf8')
  await fs.writeFile(path.join(target, 'stale.txt'), 'stale', 'utf8')

  await copyWorkspaceEntryToDirectory(sourceRoot, source, targetRoot, targetRoot, true)

  assert.equal(await fs.readFile(path.join(target, 'new.txt'), 'utf8'), 'new')
  await assert.rejects(fs.access(path.join(target, 'stale.txt')))
})
