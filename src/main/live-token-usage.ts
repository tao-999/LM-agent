import type { TokenUsage } from '../shared/types'

export type LiveTokenUsageTracker = {
  push: (value: string) => void
  flush: () => void
}

export function createLiveTokenUsageTracker(
  promptTokens: number,
  onUsage: (usage: TokenUsage) => void,
  options: { minIntervalMs?: number; now?: () => number } = {}
): LiveTokenUsageTracker {
  const minIntervalMs = Math.max(50, options.minIntervalMs ?? 250)
  const now = options.now ?? Date.now
  let asciiCharacters = 0
  let otherCharacters = 0
  let startedAt: number | null = null
  let lastReportedAt: number | null = null

  const report = (force: boolean): void => {
    if (startedAt === null) return
    const currentTime = now()
    if (
      !force &&
      lastReportedAt !== null &&
      currentTime - lastReportedAt < minIntervalMs
    ) return
    if (!force && currentTime - startedAt < minIntervalMs) return
    const completionTokens = Math.ceil(asciiCharacters / 4 + otherCharacters)
    const generationDurationMs = Math.max(1, currentTime - startedAt)
    lastReportedAt = currentTime
    onUsage({
      promptTokens: Math.max(0, Math.round(promptTokens)),
      completionTokens,
      totalTokens: Math.max(0, Math.round(promptTokens)) + completionTokens,
      estimated: true,
      generationDurationMs,
      tokensPerSecond: completionTokens / (generationDurationMs / 1000)
    })
  }

  return {
    push(value) {
      if (!value) return
      if (startedAt === null) startedAt = now()
      for (const character of value) {
        if (character.charCodeAt(0) <= 127) asciiCharacters += 1
        else otherCharacters += 1
      }
      report(false)
    },
    flush() {
      report(true)
    }
  }
}
