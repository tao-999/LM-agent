import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  isQwen38Model,
  qwen38LmStudioThinkingOptions,
  qwen38ReasoningEffort,
  resolveThinkingEnabled,
  supportsReasoningEffort
} from '../src/shared/thinking.ts'

const qwen38 = {
  provider: 'openai' as const,
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'Qwen3.8-27B'
}

test('Qwen3.8 默认开启 Thinking 并使用 xhigh', () => {
  assert.equal(isQwen38Model(qwen38), true)
  assert.equal(resolveThinkingEnabled({ ...qwen38, thinkingMode: 'auto' }), true)
  assert.equal(qwen38ReasoningEffort(qwen38, true), 'xhigh')
})

test('Qwen3.8 使用会话选择的思考等级', () => {
  assert.equal(qwen38ReasoningEffort({ ...qwen38, reasoningEffort: 'medium' }, true), 'medium')
  assert.equal(qwen38ReasoningEffort({ ...qwen38, reasoningEffort: 'low' }, true), 'low')
})

test('LM Studio 仅公布 on/off 时只发送 Thinking 开关', () => {
  assert.deepEqual(
    qwen38LmStudioThinkingOptions({
      ...qwen38,
      reasoningEffort: 'xhigh',
      reasoningOptions: ['off', 'on']
    }, true),
    {
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: true
      }
    }
  )
  assert.deepEqual(qwen38LmStudioThinkingOptions({ ...qwen38, reasoningOptions: ['off', 'on'] }, false), {
    chat_template_kwargs: {
      enable_thinking: false,
      preserve_thinking: false
    }
  })
  assert.equal(supportsReasoningEffort({ reasoningOptions: ['off', 'on'] }), false)
})

test('LM Studio 公布分级能力时才发送 reasoning_effort', () => {
  assert.deepEqual(
    qwen38LmStudioThinkingOptions({
      ...qwen38,
      reasoningEffort: 'low',
      reasoningOptions: ['off', 'low', 'medium', 'high']
    }, true),
    {
      reasoning_effort: 'low',
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: true,
        reasoning_effort: 'low'
      }
    }
  )
  assert.equal(supportsReasoningEffort({ reasoningOptions: ['off', 'low', 'high'] }), true)
})

test('关闭 Thinking 或使用旧版 Qwen 时不发送 Qwen3.8 思考等级', () => {
  assert.equal(qwen38ReasoningEffort(qwen38, false), undefined)
  assert.equal(qwen38ReasoningEffort({ ...qwen38, model: 'Qwen3.7-27B' }, true), undefined)
})

test('输入栏仅为 Qwen3.8 展示会话级思考等级并压缩自动控件', () => {
  const panel = readFileSync('src/renderer/src/components/ChatPanel.tsx', 'utf8')
  const styles = readFileSync('src/renderer/src/macos.css', 'utf8')
  assert.match(panel, /isQwen38Model\(model\) && supportsReasoningEffort\(model\)/)
  assert.match(panel, /className="reasoning-effort-picker"/)
  assert.match(panel, /setConversationReasoningEffort/)
  assert.match(styles, /\.permission-picker \.mac-select-trigger span[\s\S]*font-size:8px/)
  assert.match(styles, /\.reasoning-effort-picker[\s\S]*flex:0 0 auto[\s\S]*min-width:max-content/)
  assert.doesNotMatch(styles, /\.reasoning-effort-picker[^\n]*flex:0 0 47px/)
})
