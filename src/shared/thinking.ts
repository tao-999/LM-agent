import type { ModelConfig, ReasoningEffort, ThinkingMode } from './types'
import { isTokenHubHy3Model } from './model-profiles.ts'

export type ThinkingCapability = 'supported' | 'unsupported' | 'always' | 'unknown'

const normalizedModelName = (model: Pick<ModelConfig, 'model'>): string =>
  model.model.trim().toLocaleLowerCase()

export function isQwen38Model(model: Pick<ModelConfig, 'model'>): boolean {
  return /(?:^|[^a-z0-9])qwen[-_. ]?3[._-]?8(?:[^a-z0-9]|$)/i.test(
    normalizedModelName(model)
  )
}

export function qwen38ReasoningEffort(
  model: Pick<ModelConfig, 'model' | 'reasoningEffort'>,
  enabled: boolean
): ReasoningEffort | undefined {
  if (!enabled || !isQwen38Model(model)) return undefined
  return model.reasoningEffort ?? 'xhigh'
}

export function qwen38LmStudioThinkingOptions(
  model: Pick<ModelConfig, 'model' | 'reasoningEffort'>,
  enabled: boolean
): Record<string, unknown> {
  const effort = qwen38ReasoningEffort(model, enabled)
  return {
    ...(effort ? { reasoning_effort: effort } : {}),
    chat_template_kwargs: {
      enable_thinking: enabled,
      preserve_thinking: enabled
    }
  }
}

export function supportsReasoningEffort(
  model: Pick<ModelConfig, 'model' | 'reasoningOptions'>
): boolean {
  if (isQwen38Model(model)) return true
  return Boolean(
    model.reasoningOptions?.some((option) =>
      ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(option)
    )
  )
}

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
  if (isTokenHubHy3Model(model)) return 'supported'
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
