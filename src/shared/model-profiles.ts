import type { ModelConfig } from './types'

export type KnownModelContext = {
  contextLength: number
  maxContextLength: number
  source: string
}

const TOKENHUB_HOSTS = new Set([
  'tokenhub.tencentmaas.com',
  'tokenhub-intl.tencentmaas.com',
  'tokenhub.tencentcloudmaas.com',
  'tokenhub-intl.tencentcloudmaas.com'
])

function hostname(value: string): string {
  try {
    return new URL(value).hostname.toLocaleLowerCase()
  } catch {
    return ''
  }
}

export function isTencentTokenHubEndpoint(baseUrl: string): boolean {
  return TOKENHUB_HOSTS.has(hostname(baseUrl))
}

export function isTokenHubHy3Model(
  model: Pick<ModelConfig, 'provider' | 'baseUrl' | 'model'>
): boolean {
  return (
    model.provider === 'openai' &&
    isTencentTokenHubEndpoint(model.baseUrl) &&
    /^hy3(?:-preview)?$/i.test(model.model.trim())
  )
}

export function knownRemoteModelContext(
  model: Pick<ModelConfig, 'provider' | 'baseUrl' | 'model'>
): KnownModelContext | null {
  if (!isTokenHubHy3Model(model)) return null
  return {
    // TokenHub documents a 256K model window, a 192K maximum input and a
    // 128K maximum output. `contextLength` is the application's prompt budget,
    // so use the real maximum input instead of allowing a 256K prompt.
    contextLength: 192 * 1024,
    maxContextLength: 256 * 1024,
    source: '腾讯 TokenHub HY3 官方配置'
  }
}

export function applyKnownRemoteModelProfile(model: ModelConfig): ModelConfig {
  const context = knownRemoteModelContext(model)
  if (!context) {
    if (model.provider === 'openai' && model.connectionId && !model.preset) {
      return {
        ...model,
        contextLength: undefined,
        maxContextLength: undefined
      }
    }
    return model
  }
  if (
    model.contextLength === context.contextLength &&
    model.maxContextLength === context.maxContextLength
  ) {
    return model
  }
  return {
    ...model,
    contextLength: context.contextLength,
    maxContextLength: context.maxContextLength
  }
}

export function resolveOpenAiEndpoint(baseUrl: string, suffix: string): string {
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`
  let base = baseUrl.trim().replace(/\/+$/, '')

  // Accept either an OpenAI Base URL or a complete endpoint copied from a
  // provider console. Strip a known terminal endpoint before composing the
  // requested one, which prevents duplicated `/v1/chat/completions` paths.
  base = base.replace(/\/(?:chat\/completions|responses|models)$/i, '')

  if (/\/v\d+(?:beta)?$/i.test(base)) return `${base}${normalizedSuffix}`
  return `${base}/v1${normalizedSuffix}`
}

export function tokenHubHy3ReasoningOptions(
  model: Pick<ModelConfig, 'provider' | 'baseUrl' | 'model'>,
  enabled: boolean
): Record<string, unknown> {
  if (!isTokenHubHy3Model(model)) return {}
  return { reasoning_effort: enabled ? 'high' : 'no_think' }
}
