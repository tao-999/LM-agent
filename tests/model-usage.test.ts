import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyAverageSpeed,
  cachedPromptTokensFromOpenAiPayload,
  generationDurationFromOpenAiTimings,
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

test('LM Studio 输出速度只采用模型生成耗时，不包含预加载与提示词处理', () => {
  assert.equal(
    generationDurationFromOpenAiTimings(400, {
      prompt_n: 20_000,
      predicted_n: 400,
      predicted_ms: 10_000,
      predicted_per_second: 40
    }),
    10_000
  )
})

test('缺少 predicted_ms 时按 LM Studio predicted_per_second 还原纯生成耗时', () => {
  assert.equal(
    generationDurationFromOpenAiTimings(600, {
      predicted_n: 600,
      predicted_per_second: 40
    }),
    15_000
  )
})

test('合并流式 timings 时保留最终生成速度', () => {
  assert.deepEqual(
    mergeOpenAiTimingsPayload(
      { predicted_n: 100, predicted_ms: 2_500, predicted_per_second: 40 },
      { predicted_n: 200, predicted_ms: 5_000, predicted_per_second: 41.25 }
    ),
    {
      cache_n: undefined,
      prompt_n: undefined,
      predicted_n: 200,
      predicted_ms: 5_000,
      predicted_per_second: 41.25
    }
  )
})


test('会话结束时平均 tok 速度取各轮 eval time 速度的算术平均值', () => {
  const usage = applyAverageSpeed(
    { promptTokens: 100_000, completionTokens: 3_000, totalTokens: 103_000 },
    [40, 41, 42]
  )
  // (40+41+42)/3 = 41 t/s；汇总时长仅用于展示，由平均速度反推
  assert.ok(Math.abs(usage.tokensPerSecond! - 41) < 1e-9)
  assert.ok(Math.abs(usage.generationDurationMs! - (3_000 * 1000) / 41) < 1e-6)
})

test('缺少速度的轮次不参与平均，全部缺失时保持原速度不变', () => {
  const base = { promptTokens: 10, completionTokens: 2_000, totalTokens: 2_010 }
  const withSomeMissing = applyAverageSpeed(base, [undefined, 40, undefined, 60])
  assert.ok(Math.abs(withSomeMissing.tokensPerSecond! - 50) < 1e-9)

  const none = applyAverageSpeed({ ...base, tokensPerSecond: 33 }, [undefined, 0])
  assert.equal(none.tokensPerSecond, 33)
})
