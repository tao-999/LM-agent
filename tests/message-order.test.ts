import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSystemMessageOrder } from '../src/main/message-order.ts'

test('多个 system 片段合并为唯一首条消息', () => {
  const messages = normalizeSystemMessageOrder([
    { role: 'system', content: '全局指令' },
    { role: 'user', content: '当前任务' },
    { role: 'assistant', content: '准备执行' },
    { role: 'system', content: '运行时约束' },
    { role: 'tool', content: '工具结果' }
  ])

  assert.deepEqual(messages.map((message) => message.role), [
    'system',
    'user',
    'assistant',
    'tool'
  ])
  assert.equal(messages[0].content, '全局指令\n\n运行时约束')
})

test('没有 system 消息时保持原顺序', () => {
  const messages = [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答' }
  ]
  assert.deepEqual(normalizeSystemMessageOrder(messages), messages)
})
