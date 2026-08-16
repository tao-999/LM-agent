import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { StreamRepetitionGuard } from '../src/main/stream-repetition-guard.ts'

function feedInChunks(guard: StreamRepetitionGuard, text: string, size = 53) {
  let detection = null
  for (let offset = 0; offset < text.length && !detection; offset += size) {
    detection = guard.push(text.slice(offset, offset + size))
  }
  return detection
}

test('单个思考模块在 1000 Token 滑动区间出现大段 n-gram 重复时自动命中', () => {
  const paragraph =
    '用户要求修复当前剧情中的身份冲突。先核对人物设定，再读取目标区间，确认修改不会破坏前后逻辑，最后完成局部替换并复查结果。'
  const guard = new StreamRepetitionGuard({ channel: 'reasoning' })
  const detection = feedInChunks(guard, Array.from({ length: 18 }, () => paragraph).join('\n'))

  assert.ok(detection)
  assert.equal(detection.channel, 'reasoning')
  assert.equal(detection.ngramSize, 16)
  assert.ok(detection.sampledTokens <= 1000)
  assert.ok(detection.duplicateRatio >= 0.38)
  assert.ok(detection.repeatedCoverage >= 0.72)
})

test('正文模块连续生成短周期 Emoji 序列时也能命中', () => {
  const guard = new StreamRepetitionGuard({ channel: 'content' })
  const detection = feedInChunks(
    guard,
    Array.from({ length: 180 }, () => '✅🎯🏁✨🔒📡').join('')
  )

  assert.ok(detection)
  assert.equal(detection.channel, 'content')
})

test('有相似句式但内容持续推进的长文本不会误判', () => {
  const guard = new StreamRepetitionGuard({ channel: 'reasoning' })
  const progressive = Array.from(
    { length: 180 },
    (_, index) =>
      `第${index}项检查聚焦唯一目标 unit_${index}，读取证据 ref_${index * 17 + 3} 后得出结论 result_${index * 31 + 9}。`
  ).join('\n')

  assert.equal(feedInChunks(guard, progressive), null)
})

test('思考与正文分别维护滑动区间，不会跨模块拼接误判', () => {
  const paragraph = '这是用于验证模块边界的重复句段，单独一侧的长度不足以形成高置信度循环。'
  const reasoning = new StreamRepetitionGuard({ channel: 'reasoning' })
  const content = new StreamRepetitionGuard({ channel: 'content' })

  assert.equal(feedInChunks(reasoning, paragraph.repeat(4)), null)
  assert.equal(feedInChunks(content, paragraph.repeat(4)), null)
})

test('模型流接入高重复检测并通过独立完成原因触发原地重发', () => {
  const modelsSource = readFileSync(
    new URL('../src/main/models.ts', import.meta.url),
    'utf8'
  )
  const agentSource = readFileSync(
    new URL('../src/main/agent.ts', import.meta.url),
    'utf8'
  )

  assert.match(modelsSource, /createStreamRepetitionGuard\('reasoning'\)/)
  assert.match(modelsSource, /createStreamRepetitionGuard\('content'\)/)
  assert.match(modelsSource, /'repetition_interrupt'/)
  assert.match(agentSource, /检测到高重复输出，已自动截断重发/)
  assert.doesNotMatch(modelsSource, /palindrome|回文/i)
})
