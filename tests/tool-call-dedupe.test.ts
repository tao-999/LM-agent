import assert from 'node:assert/strict'
import test from 'node:test'

import { dedupeToolCalls } from '../src/main/tool-call-dedupe.ts'

test('同一模型响应内完全相同的工具调用只执行一次', () => {
  const calls = dedupeToolCalls([
    { id: 'a', name: 'grep', arguments: { query: '酒', path: '正文.txt', order: 'desc' } },
    { id: 'b', name: 'grep', arguments: { order: 'desc', path: '正文.txt', query: '酒' } },
    { id: 'c', name: 'read_file', arguments: { path: '正文.txt', start_line: 10, end_line: 30 } }
  ])

  assert.deepEqual(calls.map((call) => call.id), ['a', 'c'])
})

test('参数不同的重复读取仍然保留', () => {
  const calls = dedupeToolCalls([
    { id: 'a', name: 'read_file', arguments: { path: '正文.txt', start_line: 10, end_line: 30 } },
    { id: 'b', name: 'read_file', arguments: { path: '正文.txt', start_line: 20, end_line: 40 } }
  ])

  assert.equal(calls.length, 2)
})
