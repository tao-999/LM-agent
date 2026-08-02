import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

test('Chat 模式只开放网页工具并隔离本地项目工具', async () => {
  const source = await fs.readFile(path.resolve('src/main/agent.ts'), 'utf8')
  const chatSource = source.slice(
    source.indexOf('export async function runWebChat'),
    source.indexOf('export async function runAgent')
  )
  assert.match(chatSource, /name: 'search_web'/)
  assert.match(chatSource, /name: 'fetch_webpage'/)
  assert.doesNotMatch(chatSource, /name: 'grep'/)
  assert.doesNotMatch(chatSource, /name: 'read_file'/)
  assert.match(chatSource, /禁止访问、检索或读取本地项目文件/)
})

test('图片模式不注入 grep、read_file 或本地资料索引', async () => {
  const source = await fs.readFile(path.resolve('src/main/index.ts'), 'utf8')
  const imageSource = source.slice(
    source.indexOf('async function processImageQueue'),
    source.indexOf('function requestAgentApproval')
  )
  assert.doesNotMatch(imageSource, /buildLocalResourceIndex/)
  assert.doesNotMatch(imageSource, /completeWithTools/)
  assert.doesNotMatch(imageSource, /name: 'grep'/)
  assert.doesNotMatch(imageSource, /name: 'read_file'/)
  assert.match(imageSource, /禁止访问、检索或读取本地项目文件/)
  assert.match(imageSource, /usage = await streamChat/)
})
