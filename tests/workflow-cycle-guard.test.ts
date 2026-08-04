import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createStreamRepetitionGuard,
  type StreamRepetitionStop
} from '../src/main/repetition-guard.ts'

function inspectCrossTurn(
  current: string,
  priorSamples: string[]
): StreamRepetitionStop | undefined {
  let detected: StreamRepetitionStop | undefined
  const guard = createStreamRepetitionGuard(
    'reasoning',
    (stop) => {
      detected = stop
    },
    { priorSamples }
  )
  for (let index = 0; index < current.length; index += 13) {
    if (guard.push(current.slice(index, index + 13))) break
  }
  return detected
}

test('连续多轮复读相同思考内容时识别跨轮循环', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL('./fixtures/cross-turn-reasoning-loop.json', import.meta.url),
      'utf8'
    )
  ) as string[]
  const detected = inspectCrossTurn(fixture[2], fixture.slice(0, 2))

  assert.equal(detected?.kind, 'cross-turn-repeat')
  assert.equal(detected?.channel, 'reasoning')
})

test('同一读取工具调用多次但思考内容持续推进时不误判', () => {
  const prior = [
    '先读取第一处出场段落，确认断浪早期使用江兄作为称呼，并记录对应剧情时期。',
    '继续读取结尾告别段落，确认人物关系变化后改用大哥，同时核对前后事件跨度。'
  ]
  const current =
    '两处原文证据已经齐全，现在比较称呼变化与人物关系，随后只修改用户指出的目标句。'

  assert.equal(inspectCrossTurn(current, prior), undefined)
})

test('仅有一次相似历史内容时不判定为跨轮循环', () => {
  const content =
    '读取人物设定文件并核对称呼来源，确认当前句子是否符合既有关系和剧情阶段。'

  assert.equal(inspectCrossTurn(content, [content]), undefined)
})

test('Agent 以模型实际内容样本检测跨轮复读并撤销工具次数拦截', async () => {
  const source = await readFile(new URL('../src/main/agent.ts', import.meta.url), 'utf8')
  assert.match(source, /repetitionSamples:/)
  assert.match(source, /检测到跨轮内容复读/)
  assert.doesNotMatch(source, /WorkflowCycleGuard/)
  assert.doesNotMatch(source, /cycleGuardedTool/)
})
