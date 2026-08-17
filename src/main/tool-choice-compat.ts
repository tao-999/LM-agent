type ToolChoiceModel = {
  model: string
  baseUrl: string
  preset?: string
  thinkingMode?: 'auto' | 'on' | 'off'
}

export function isDeepSeekModelName(modelName: string): boolean {
  return /(?:^|[^a-z0-9])deepseek(?:[^a-z0-9]|$)/i.test(modelName.trim())
}

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLocaleLowerCase()
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

export function resolveCompatibleToolChoice(
  model: ToolChoiceModel,
  requested: 'auto' | 'required'
): 'auto' | 'required' | undefined {
  if (
    isDeepSeekModelName(model.model) &&
    !isLocalEndpoint(model.baseUrl) &&
    model.thinkingMode !== 'off'
  ) {
    return undefined
  }
  if (model.preset === 'kimi-code' && requested === 'required') return 'auto'
  return requested
}
