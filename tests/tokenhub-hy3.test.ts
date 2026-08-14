import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTokenHubHy3Model,
  knownRemoteModelContext,
  resolveOpenAiEndpoint,
  tokenHubHy3ReasoningOptions
} from '../src/shared/model-profiles.ts'
import { inferThinkingCapability, resolveThinkingEnabled } from '../src/shared/thinking.ts'

const hy3 = {
  provider: 'openai' as const,
  baseUrl: 'https://tokenhub.tencentmaas.com/v1',
  model: 'hy3'
}

test('accepts TokenHub Base URL and complete Chat Completions URL', () => {
  assert.equal(
    resolveOpenAiEndpoint('https://tokenhub.tencentmaas.com/v1', '/chat/completions'),
    'https://tokenhub.tencentmaas.com/v1/chat/completions'
  )
  assert.equal(
    resolveOpenAiEndpoint(
      'https://tokenhub.tencentmaas.com/v1/chat/completions',
      '/chat/completions'
    ),
    'https://tokenhub.tencentmaas.com/v1/chat/completions'
  )
  assert.equal(
    resolveOpenAiEndpoint('https://tokenhub.tencentmaas.com/v1/chat/completions', '/models'),
    'https://tokenhub.tencentmaas.com/v1/models'
  )
})

test('recognizes official mainland and international HY3 endpoints', () => {
  assert.equal(isTokenHubHy3Model(hy3), true)
  assert.equal(
    isTokenHubHy3Model({
      ...hy3,
      baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
      model: 'hy3-preview'
    }),
    true
  )
  assert.equal(isTokenHubHy3Model({ ...hy3, model: 'other-model' }), false)
})

test('uses HY3 official prompt and model context limits', () => {
  assert.deepEqual(knownRemoteModelContext(hy3), {
    contextLength: 196608,
    maxContextLength: 262144,
    source: '腾讯 TokenHub HY3 官方配置'
  })
})

test('maps the conversation Thinking selector to HY3 reasoning_effort', () => {
  assert.equal(inferThinkingCapability(hy3), 'supported')
  assert.equal(resolveThinkingEnabled({ ...hy3, thinkingMode: 'auto' }), true)
  assert.deepEqual(tokenHubHy3ReasoningOptions(hy3, true), { reasoning_effort: 'high' })
  assert.deepEqual(tokenHubHy3ReasoningOptions(hy3, false), { reasoning_effort: 'no_think' })
})
