import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createStreamRepetitionGuard,
  type StreamRepetitionStop
} from '../src/main/repetition-guard.ts'

function inspectReasoning(value: string): StreamRepetitionStop | undefined {
  let detected: StreamRepetitionStop | undefined
  const guard = createStreamRepetitionGuard('reasoning', (stop) => {
    detected = stop
  })
  for (let index = 0; index < value.length; index += 31) {
    if (guard.push(value.slice(index, index + 31))) break
  }
  return detected
}

test('detects completion summaries that repeatedly rephrase the same result', () => {
  const variants = [
    '修改完成。正文.txt 第12644行已修正，练武之人不再显得虚弱，同时保留箱子的沉重感。✅',
    '已完成修改。第12644行前后文逻辑一致，仅改动一行。✅',
    '改动位置为正文.txt 第12644行，修改完成，验证通过。✅'
  ]
  const reasoning = Array.from({ length: 24 }, (_, index) => variants[index % variants.length]).join(
    '\n'
  )

  assert.equal(inspectReasoning(reasoning)?.kind, 'completion-echo')
})

test('detects a short completion phrase repeated at the tail', () => {
  const prefix =
    '已经读取目标区间并核对人物身份、前后称呼、文件行号与真实改动结果，当前只需结束本轮任务。'.repeat(
      3
    )
  const reasoning = `${prefix}${'已改。✅'.repeat(60)}`

  assert.equal(inspectReasoning(reasoning)?.kind, 'repeated-tail')
})

test('detects a dense emoji tail', () => {
  const prefix =
    '工具已经返回成功，文件内容已经复查，当前任务信息完整，模型却开始连续输出装饰符号。'.repeat(
      4
    )
  const emojis = ['🎞️', '✅', '🎉', '✨', '🔒', '🚀', '🔥', '🛡️']
  const reasoning = `${prefix}${Array.from({ length: 64 }, (_, index) => emojis[index % emojis.length]).join(' ')}`

  assert.equal(inspectReasoning(reasoning)?.kind, 'emoji-flood')
})

test('detects changing DONE and END claims as a closure echo loop', () => {
  const lines = [
    '任务结束。无需进一步操作。',
    '[FINAL] Task: Complete | Verification: Passed ✅',
    'Awaiting your next command... ⏳',
    'END | Status: Complete | Next: Awaiting Input',
    'This is the absolute end of this task response. No more text will follow.',
    'DONE FOR REAL. ✅',
    'Actually stopping now. STOP.',
    'End of transmission. Goodbye!',
    'TRULY FINAL LINE. Task Complete.',
    'Waiting for the next task. Awaiting Input.',
    'PERIOD. No more words.',
    'END. Really done.'
  ]
  const reasoning = `${'文件改动已经完成并通过上下文复查。'.repeat(10)}\n${lines.join('\n---\n')}`

  assert.equal(inspectReasoning(reasoning)?.kind, 'idle-drift')
})

test('detects post-completion waiting chatter before it grows into a long loop', () => {
  const reasoning = [
    '修改完成，前后文逻辑流畅。',
    '任务已经完成，无需进一步操作。',
    '等待下一个指令中...',
    '系统提示：当前会话活跃，AI 助手在线待命。'
  ].join('\n')

  assert.equal(inspectReasoning(reasoning.repeat(3))?.kind, 'idle-drift')
})

test('keeps a structured but non-repeating reasoning sequence', () => {
  const reasoning = Array.from(
    { length: 20 },
    (_, index) =>
      `阶段${index + 1}需要检查不同文件与规则，读取新的上下文证据，并根据第${index + 3}项真实结果调整执行方向。`
  ).join('\n')

  assert.equal(inspectReasoning(reasoning), undefined)
})
