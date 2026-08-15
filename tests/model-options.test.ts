import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldShowSavedModelFallback } from '../src/shared/model-options.ts'
import type { ModelConfig, ModelOption } from '../src/shared/types.ts'

const current: ModelConfig = {
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'qwen3.8-27b',
  contextLength: 99_328
}

const discovered: ModelOption[] = [
  {
    id: 'LM Studio:qwen3.8-27b@q6_k_xl',
    name: 'qwen3.8-27b@q6_k_xl',
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    source: 'LM Studio'
  },
  {
    id: 'LM Studio:qwen3.8-27b@q8_k_xl',
    name: 'qwen3.8-27b@q8_k_xl',
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    source: 'LM Studio'
  }
]

test('本地目录可用时不复活已保存但并不存在的模型别名', () => {
  assert.equal(shouldShowSavedModelFallback(current, discovered, discovered), false)
})

test('本地目录暂时不可用时保留已保存模型，方便恢复连接', () => {
  assert.equal(shouldShowSavedModelFallback(current, [], []), true)
})

test('精确存在的模型不会再生成 saved 重复项', () => {
  const exact = { ...discovered[0], name: current.model }
  assert.equal(shouldShowSavedModelFallback(current, [exact], [exact]), false)
})
