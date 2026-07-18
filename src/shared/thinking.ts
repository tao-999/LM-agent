import type { ModelConfig, ThinkingMode } from './types'

export type ThinkingCapability = 'supported' | 'unsupported' | 'always' | 'unknown'

const normalizedModelName = (model: Pick<ModelConfig, 'model'>): string =>
  model.model.trim().toLocaleLowerCase()

export function thinkingModelKey(
  model: Pick<ModelConfig, 'provider' | 'baseUrl' | 'model' | 'preset' | 'connectionId'>
): string {
  return [
    model.provider,
    model.preset ?? '',
    model.connectionId ?? '',
    model.baseUrl.replace(/\/+$/, '').toLocaleLowerCase(),
    normalizedModelName(model)
  ].join('|')
}

export function inferThinkingCapability(
  model: Pick<ModelConfig, 'provider' | 'baseUrl' | 'model' | 'preset'>
): ThinkingCapability {
  const name = normalizedModelName(model)
  if (!name) return 'unknown'
  if (model.preset === 'kimi-code') return 'always'
  if (/(?:^|[-_.\s])(?:qwq|deepseek[-_.]?r1|reasoner)(?:$|[-_.\s])/.test(name)) return 'always'
  if (/(?:embed|embedding|rerank|whisper|speech|tts|image|vision-encoder)/.test(name)) {
    return 'unsupported'
  }
  if (
    /(?:^|[^a-z0-9])qwen\s*3(?:[._-]?\d+)?(?:[^a-z0-9]|$)/.test(name) ||
    /(?:gpt-oss|thinking|reasoning|claude.*(?:thinking|opus|sonnet)|gemini[-_.]?(?:2\.5|3)|(?:^|[-_.])o[134](?:$|[-_.])|gpt[-_.]?5)/.test(
      name
    )
  ) {
    return 'supported'
  }
  return 'unknown'
}

export function resolveThinkingEnabled(
  model: Pick<ModelConfig, 'provider' | 'baseUrl' | 'model' | 'preset' | 'thinkingMode'>,
  overrideMode?: ThinkingMode
): boolean | undefined {
  const capability = inferThinkingCapability(model)
  if (capability === 'always') return true
  if (capability === 'unsupported') return undefined
  const mode = overrideMode ?? model.thinkingMode ?? 'auto'
  if (mode === 'on') return true
  if (mode === 'off') return false
  return capability === 'supported' ? true : undefined
}
