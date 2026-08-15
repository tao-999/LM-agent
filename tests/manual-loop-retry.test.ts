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

test('模型流只保留手动截断，不再加载自动重复检测器', () => {
  assert.match(modelsSource, /finishReason:\s*manuallyInterrupted\s*\?\s*'manual_interrupt'/)
  assert.doesNotMatch(modelsSource, /createStreamRepetitionGuard/)
  assert.doesNotMatch(modelsSource, /repetitionSamples/)
})
