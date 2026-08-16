import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachRemoteGenerationDuration,
  runtimeContextLength
} from '../src/main/remote-model-runtime.ts'

const remoteModel = {
  provider: 'openai' as const,
  baseUrl: 'https://api.example.com/v1',
  model: 'remote-model',
  connectionId: 'remote-1'
}

test('远程模型没有元数据时不伪造 8K 上下文窗口', () => {
  assert.equal(runtimeContextLength(remoteModel), undefined)
})

test('远程流使用真实 completion Token 与实际生成区间计算速度', () => {
  const usage = attachRemoteGenerationDuration(
    remoteModel,
    { promptTokens: 100, completionTokens: 80, totalTokens: 180, estimated: false },
    1_000,
    3_000
  )
  assert.equal(usage.generationDurationMs, 2_000)
  assert.equal(usage.tokensPerSecond, 40)
})

test('服务未返回真实 Token 时不展示估算速度', () => {
  const usage = attachRemoteGenerationDuration(
    remoteModel,
    { promptTokens: 100, completionTokens: 80, totalTokens: 180, estimated: true },
    1_000,
    3_000
  )
  assert.equal(usage.tokensPerSecond, undefined)
})
