import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cachedPromptTokensFromOpenAiPayload,
  mergeOpenAiTimingsPayload,
  mergeOpenAiUsagePayload
} from '../src/main/model-usage.ts'

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

test('流式 usage 后续分片缺少 cached_tokens 时保留真实缓存命中', () => {
  const first = mergeOpenAiUsagePayload(undefined, {
    prompt_tokens_details: { cached_tokens: 82_000 },
    cached_tokens: 82_000
  })
  const merged = mergeOpenAiUsagePayload(first, {
    prompt_tokens: 90_000,
    completion_tokens: 1_200
  })

  assert.equal(merged.cached_tokens, 82_000)
  assert.equal(merged.prompt_tokens_details?.cached_tokens, 82_000)
  assert.equal(cachedPromptTokensFromOpenAiPayload(merged), 82_000)
})

test('流式 timings 后续分片不会覆盖已经返回的 cache_n', () => {
  const first = mergeOpenAiTimingsPayload(undefined, { cache_n: 203_269 })
  const merged = mergeOpenAiTimingsPayload(first, { prompt_n: 3_550, predicted_n: 3_550 })

  assert.equal(merged.cache_n, 203_269)
  assert.equal(cachedPromptTokensFromOpenAiPayload(undefined, merged), 203_269)
})

test('Responses API 的 input_tokens_details.cached_tokens 会被保留', () => {
  const usage = mergeOpenAiUsagePayload(undefined, {
    input_tokens: 688,
    output_tokens: 8,
    total_tokens: 696,
    input_tokens_details: { cached_tokens: 667 }
  })
  assert.equal(usage.input_tokens, 688)
  assert.equal(usage.output_tokens, 8)
  assert.equal(usage.total_tokens, 696)
  assert.equal(cachedPromptTokensFromOpenAiPayload(usage), 667)
})
