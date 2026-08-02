export type OpenAiUsagePayload = {
  prompt_tokens?: number
  completion_tokens?: number
  cached_tokens?: number
  prompt_cache_hit_tokens?: number
  cache_read_input_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  input_tokens_details?: { cached_tokens?: number }
}

export type OpenAiTimingsPayload = {
  cache_n?: number
  prompt_n?: number
  predicted_n?: number
}

export function cachedPromptTokensFromOpenAiPayload(
  usage?: OpenAiUsagePayload,
  timings?: OpenAiTimingsPayload
): number {
  return Math.max(
    0,
    usage?.prompt_tokens_details?.cached_tokens ?? 0,
    usage?.input_tokens_details?.cached_tokens ?? 0,
    usage?.prompt_cache_hit_tokens ?? 0,
    usage?.cache_read_input_tokens ?? 0,
    usage?.cached_tokens ?? 0,
    timings?.cache_n ?? 0
  )
}
