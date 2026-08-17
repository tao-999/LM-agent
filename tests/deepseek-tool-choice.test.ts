import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isDeepSeekModelName,
  resolveCompatibleToolChoice
} from '../src/main/tool-choice-compat.ts'

test('远程 DeepSeek Thinking 模式省略 tool_choice', () => {
  assert.equal(isDeepSeekModelName('deepseek-v4-flash'), true)
  assert.equal(
    resolveCompatibleToolChoice(
      {
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        thinkingMode: 'auto'
      },
      'required'
    ),
    undefined
  )
})

test('DeepSeek 明确关闭 Thinking 后保留 required', () => {
  assert.equal(
    resolveCompatibleToolChoice(
      {
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        thinkingMode: 'off'
      },
      'required'
    ),
    'required'
  )
})

test('本地 DeepSeek 与普通远程模型不受远程兼容逻辑影响', () => {
  assert.equal(
    resolveCompatibleToolChoice(
      {
        model: 'deepseek-r1',
        baseUrl: 'http://127.0.0.1:1234/v1',
        thinkingMode: 'auto'
      },
      'required'
    ),
    'required'
  )
  assert.equal(
    resolveCompatibleToolChoice(
      {
        model: 'grok-4.5',
        baseUrl: 'https://api.x.ai/v1',
        thinkingMode: 'auto'
      },
      'required'
    ),
    'required'
  )
})
