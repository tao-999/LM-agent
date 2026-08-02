import assert from 'node:assert/strict'
import test from 'node:test'
import { cachedPromptTokensFromOpenAiPayload } from '../src/main/model-usage.ts'

test('本地 llama.cpp 顶层 timings.cache_n 计入缓存命中', () => {
  assert.equal(
    cachedPromptTokensFromOpenAiPayload(
      { prompt_tokens: 206_819, completion_tokens: 3_550 },
      { cache_n: 203_269, prompt_n: 3_550, predicted_n: 3_550 }
    ),
    203_269
  )
})

test('多个缓存统计字段同时存在时采用真实最大值', () => {
  assert.equal(
    cachedPromptTokensFromOpenAiPayload(
      { prompt_tokens_details: { cached_tokens: 12_000 } },
      { cache_n: 18_000 }
    ),
    18_000
  )
})

test('服务未返回缓存统计时保持为零', () => {
  assert.equal(
    cachedPromptTokensFromOpenAiPayload({ prompt_tokens: 8_000, completion_tokens: 600 }),
    0
  )
})
