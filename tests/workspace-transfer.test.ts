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
