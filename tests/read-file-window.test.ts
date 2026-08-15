import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { expandReadFileWindow } from '../src/main/read-file-window.ts'

test('模型指定的窄区间保持原样', () => {
  assert.deepEqual(expandReadFileWindow(420, 200, 210), { start: 200, end: 210 })
})

test('模型指定的大区间保持原样', () => {
  assert.deepEqual(expandReadFileWindow(5000, 800, 2200), { start: 800, end: 2200 })
})

test('越界行号只做安全截取，不扩大区间', () => {
  assert.deepEqual(expandReadFileWindow(5000, -20, 10), { start: 1, end: 10 })
  assert.deepEqual(expandReadFileWindow(5000, 4990, 9000), { start: 4990, end: 5000 })
})

test('起止行反向时自动排序', () => {
  assert.deepEqual(expandReadFileWindow(5000, 2410, 2400), { start: 2400, end: 2410 })
})

test('Agent 不再强制最小读取行数，但保留全文 50% 防爆拦截', async () => {
  const source = await fs.readFile(path.resolve('src/main/agent.ts'), 'utf8')
  assert.doesNotMatch(source, /MIN_READ_FILE_LINES|readFileMinimumLines/)
  assert.match(source, /超过当前模型上下文 50% 阈值/)
  assert.match(source, /工具不会强制扩展读取范围/)
})
