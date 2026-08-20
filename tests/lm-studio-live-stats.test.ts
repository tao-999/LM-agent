import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLmStudioStatsLogState,
  parseLmStudioServerLog,
  parseLmStudioServerStats,
  type LmStudioLiveStats
} from '../src/main/lm-studio-live-stats.ts'

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
    parseLmStudioServerStats(`0.52.357.586 I slot print_timing: id  3 | task 10483 | prompt eval time = 1105.16 ms / 652 tokens (3.79 ms per token, 263.37 tokens per second)
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

test('短轮次（<3s、无 tg_3s）实时速度回退为墙钟估算，结束速度取 eval time', () => {
  let now = 1000
  const state = createLmStudioStatsLogState(() => now)
  // launch 行记录任务起点
  parseLmStudioServerLog(state, '50.19.247.001 I slot launch_slot_: id 3 | task 9000 | processing task ... is_child = 0')
  // 思考很短，LM Studio 只推一条 tg/tg_3s=0 的 live 行，没有真实速度
  now = 2400
  const live: Array<LmStudioLiveStats | null> = parseLmStudioServerLog(
    state,
    '50.19.247.975 I slot print_timing: id  3 | task 9000 | n_decoded =     60, tg =   0.00 t/s, tg_3s =   0.00 t/s'
  )
  assert.equal(live.length, 1)
  const liveStats = live[0]!
  assert.equal(liveStats.final, false)
  // 墙钟估算：60 token / 1400ms ≈ 42.857 t/s，仅作实时视觉参考
  assert.ok(Math.abs(liveStats.recentTokensPerSecond - (60 / 1400) * 1000) < 0.01, String(liveStats.recentTokensPerSecond))
  // 结束时直接取 LM 返回的 eval time t/s，不自行重算
  now = 3200
  const finals: Array<LmStudioLiveStats | null> = parseLmStudioServerLog(
    state,
    '50.19.247.999 I slot print_timing: id  3 | task 9000 |        eval time =   800.00 ms /  60 tokens (13.33 ms per token, 75.00 tokens per second)'
  )
  const finalStats = finals.find((item) => item?.final)!
  assert.equal(finalStats.decodedTokens, 60)
  assert.equal(finalStats.averageTokensPerSecond, 75)
})

test('一次调用内多段思考各产生一条 eval time，逐条上报供上层平均', () => {
  let now = 1000
  const state = createLmStudioStatsLogState(() => now)
  parseLmStudioServerLog(state, '50.19.247.001 I slot launch_slot_: id 3 | task 9100 | processing task ... is_child = 0')
  // 第一段思考结束（如工具调用前的推理）
  now += 5000
  const first: Array<LmStudioLiveStats | null> = parseLmStudioServerLog(
    state,
    '50.19.247.999 I slot print_timing: id  3 | task 9100 |        eval time =  1000.00 ms / 160 tokens (6.25 ms per token, 160.00 tokens per second)'
  )
  const firstFinal = first.find((item) => item?.final)!
  assert.equal(firstFinal.averageTokensPerSecond, 160)
  // 工具执行后第二段输出结束
  now += 8000
  const second: Array<LmStudioLiveStats | null> = parseLmStudioServerLog(
    state,
    '50.19.247.999 I slot print_timing: id  3 | task 9100 |        eval time =  2000.00 ms /  80 tokens (25.00 ms per token,  40.00 tokens per second)'
  )
  const secondFinal = second.find((item) => item?.final)!
  assert.equal(secondFinal.averageTokensPerSecond, 40)
  // release 后状态被清理，避免 Map 无限增长
  parseLmStudioServerLog(state, '50.19.248.000 I slot release: id 3 | task 9100 | stop processing')
  assert.equal(state.tasks.has(9100), false)
})
