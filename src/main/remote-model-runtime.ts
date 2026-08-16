type RuntimeModel = {
  provider: string
  baseUrl: string
  preset?: string
  contextLength?: number
  maxContextLength?: number
}

type RuntimeUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens?: number
  estimated?: boolean
  generationDurationMs?: number
  tokensPerSecond?: number
}

function isLmStudioEndpoint(model: RuntimeModel): boolean {
  return /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):1234(?:\/|$)/i.test(model.baseUrl)
}

function isRemoteOpenAiEndpoint(model: RuntimeModel): boolean {
  if (model.provider !== 'openai' || model.preset === 'kimi-code') return false
  try {
    const host = new URL(model.baseUrl).hostname.toLocaleLowerCase()
    return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
  } catch {
    return false
  }
}

export function runtimeContextLength(model: RuntimeModel): number | undefined {
  const configured = Number(model.contextLength || model.maxContextLength || 0)
  if (Number.isFinite(configured) && configured >= 2048) return Math.floor(configured)
  return isRemoteOpenAiEndpoint(model) ? undefined : 8192
}

export function attachRemoteGenerationDuration<T extends RuntimeUsage>(
  model: RuntimeModel,
  usage: T,
  startedAt?: number,
  endedAt = Date.now()
): T & RuntimeUsage {
  if (
    usage.estimated ||
    isLmStudioEndpoint(model) ||
    usage.generationDurationMs ||
    !startedAt
  ) return usage
  const generationDurationMs = Math.max(1, endedAt - startedAt)
  return {
    ...usage,
    generationDurationMs,
    tokensPerSecond: usage.completionTokens / (generationDurationMs / 1000)
  }
}
