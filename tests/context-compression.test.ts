import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CONTEXT_COMPRESSION_THRESHOLD,
  shouldCompressContext
} from '../src/main/context-compression.ts'

const agentSource = readFileSync(new URL('../src/main/agent.ts', import.meta.url), 'utf8')

test('上下文达到 95% 时才触发语义压缩', () => {
  assert.equal(CONTEXT_COMPRESSION_THRESHOLD, 0.95)
  assert.equal(shouldCompressContext(94_999, 100_000), false)
  assert.equal(shouldCompressContext(95_000, 100_000), true)
})

test('同一请求完成一次压缩后禁止再次调用压缩模型', () => {
  assert.equal(shouldCompressContext(99_000, 100_000, true), false)
  assert.match(agentSource, /let contextCompressedThisRequest = false/g)
  assert.match(agentSource, /disableContextCompression: contextCompressedThisRequest/g)
  assert.match(agentSource, /contextCompressedThisRequest = true/g)
})
