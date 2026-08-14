import assert from 'node:assert/strict'
import test from 'node:test'
import {
  expandReadFileWindow,
  MIN_READ_FILE_LINES
} from '../src/main/read-file-window.ts'

test('小于最小区间的文件始终读取全文', () => {
  assert.deepEqual(expandReadFileWindow(420, 200, 210), { start: 1, end: 420 })
})

test('窄区间围绕目标扩展为至少一千行', () => {
  const window = expandReadFileWindow(5000, 2400, 2410)
  assert.equal(window.end - window.start + 1, MIN_READ_FILE_LINES)
  assert.ok(window.start <= 2400)
  assert.ok(window.end >= 2410)
})

test('文件开头和结尾仍保持一千行完整窗口', () => {
  assert.deepEqual(expandReadFileWindow(5000, 1, 10), { start: 1, end: 1000 })
  assert.deepEqual(expandReadFileWindow(5000, 4990, 5000), { start: 4001, end: 5000 })
})

test('模型主动请求超过一千行时保留原区间', () => {
  assert.deepEqual(expandReadFileWindow(5000, 800, 2200), { start: 800, end: 2200 })
})
