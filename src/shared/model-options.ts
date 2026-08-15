import type { ModelConfig, ModelOption } from './types'

const normalizedEndpoint = (value: string): string => value.trim().replace(/\/+$/, '').toLowerCase()

const sameEndpoint = (option: ModelOption, model: ModelConfig): boolean =>
  option.provider === model.provider &&
  normalizedEndpoint(option.baseUrl) === normalizedEndpoint(model.baseUrl)

export function shouldShowSavedModelFallback(
  model: ModelConfig,
  available: ModelOption[],
  discovered: ModelOption[]
): boolean {
  if (!model.model) return false
  if (
    available.some(
      (item) => sameEndpoint(item, model) && item.name === model.model
    )
  ) {
    return false
  }

  const isLocalDiscoveredModel = !model.preset && !model.connectionId
  const endpointCatalogIsAvailable = discovered.some((item) => sameEndpoint(item, model))

  // A responsive local catalog is authoritative. Do not resurrect a stale saved
  // alias (for example qwen3.8-27b) beside the concrete installed quantizations.
  if (isLocalDiscoveredModel && endpointCatalogIsAvailable) return false

  // Keep an unavailable saved cloud/custom selection visible so the user can
  // repair credentials or a temporarily unreachable endpoint.
  return true
}
