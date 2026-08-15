export type OpenAiUsagePayload = {
  prompt_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
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

function maxDefined(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) return undefined
  return Math.max(0, left ?? 0, right ?? 0)
}

export function mergeOpenAiUsagePayload(
  previous: OpenAiUsagePayload | undefined,
  incoming: OpenAiUsagePayload
): OpenAiUsagePayload {
  const promptDetailsCached = maxDefined(
    previous?.prompt_tokens_details?.cached_tokens,
    incoming.prompt_tokens_details?.cached_tokens
  )
  const inputDetailsCached = maxDefined(
    previous?.input_tokens_details?.cached_tokens,
    incoming.input_tokens_details?.cached_tokens
  )
  return {
    prompt_tokens: maxDefined(previous?.prompt_tokens, incoming.prompt_tokens),
    completion_tokens: maxDefined(previous?.completion_tokens, incoming.completion_tokens),
    input_tokens: maxDefined(previous?.input_tokens, incoming.input_tokens),
    output_tokens: maxDefined(previous?.output_tokens, incoming.output_tokens),
    total_tokens: maxDefined(previous?.total_tokens, incoming.total_tokens),
    cached_tokens: maxDefined(previous?.cached_tokens, incoming.cached_tokens),
    prompt_cache_hit_tokens: maxDefined(
      previous?.prompt_cache_hit_tokens,
      incoming.prompt_cache_hit_tokens
    ),
    cache_read_input_tokens: maxDefined(
      previous?.cache_read_input_tokens,
      incoming.cache_read_input_tokens
    ),
    ...(promptDetailsCached !== undefined
      ? { prompt_tokens_details: { cached_tokens: promptDetailsCached } }
      : {}),
    ...(inputDetailsCached !== undefined
      ? { input_tokens_details: { cached_tokens: inputDetailsCached } }
      : {})
  }
}

export function mergeOpenAiTimingsPayload(
  previous: OpenAiTimingsPayload | undefined,
  incoming: OpenAiTimingsPayload
): OpenAiTimingsPayload {
  return {
    cache_n: maxDefined(previous?.cache_n, incoming.cache_n),
    prompt_n: maxDefined(previous?.prompt_n, incoming.prompt_n),
    predicted_n: maxDefined(previous?.predicted_n, incoming.predicted_n)
  }
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
