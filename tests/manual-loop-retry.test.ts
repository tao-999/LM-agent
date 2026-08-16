import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const chatPanelSource = readFileSync(
  new URL('../src/renderer/src/components/ChatPanel.tsx', import.meta.url),
  'utf8'
)
const modelsSource = readFileSync(
  new URL('../src/main/models.ts', import.meta.url),
  'utf8'
)

test('终止重发在当前请求内触发截断，不停止请求或重发用户消息', () => {
  const start = chatPanelSource.indexOf('const stopLoopAndRetry')
  const end = chatPanelSource.indexOf('const resolveApproval', start)
  assert.ok(start >= 0 && end > start)
  const implementation = chatPanelSource.slice(start, end)
  assert.match(implementation, /interruptRepetition\(requestId\)/)
  assert.doesNotMatch(implementation, /\.stop\(requestId\)/)
  assert.doesNotMatch(implementation, /sendMessage\(/)
  assert.doesNotMatch(implementation, /setComposerInput\(/)
  assert.doesNotMatch(implementation, /excludeFromContext/)
})

test('模型流保留手动截断，并只恢复单模块高重复 n-gram 检测', () => {
  assert.match(modelsSource, /finishReason:\s*manuallyInterrupted\s*\?\s*'manual_interrupt'/)
  assert.match(modelsSource, /createStreamRepetitionGuard/)
  assert.match(modelsSource, /repetition_interrupt/)
  assert.doesNotMatch(modelsSource, /repetitionSamples/)
})
