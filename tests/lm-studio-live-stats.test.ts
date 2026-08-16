import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLmStudioServerStats } from '../src/main/lm-studio-live-stats.ts'

test('解析 LM Studio 每三秒推送的真实解码速度', () => {
  assert.deepEqual(
    parseLmStudioServerStats(
      '50.19.247.975 I slot print_timing: id  3 | task 31068 | n_decoded =    348, tg =  38.27 t/s, tg_3s =  50.77 t/s'
    ),
    {
      taskId: 31068,
      decodedTokens: 348,
      averageTokensPerSecond: 38.27,
      recentTokensPerSecond: 50.77,
      final: false
    }
  )
})

test('解析 LM Studio 结束时返回的纯生成平均速度', () => {
  assert.deepEqual(
    parseLmStudioServerStats(`0.52.357.586 I slot print_timing: id  3 | task 10483 | prompt eval time = 1105.16 ms / 652 tokens
0.52.357.592 I slot print_timing: id  3 | task 10483 |        eval time = 24668.14 ms / 300 tokens (82.23 ms per token, 12.16 tokens per second)`),
    {
      taskId: 10483,
      decodedTokens: 300,
      averageTokensPerSecond: 12.16,
      recentTokensPerSecond: 12.16,
      final: true
    }
  )
})

test('忽略与解码统计无关的 LM Studio 日志', () => {
  assert.equal(
    parseLmStudioServerStats(
      '[qwen3.8-27b@q4_k_xl] Prompt processing progress: 99.4%'
    ),
    null
  )
})
