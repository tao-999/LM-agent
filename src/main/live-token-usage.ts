import type { TokenUsage } from '../shared/types'

export type LiveTokenUsageTracker = {
  push: (value: string) => void
  flush: () => void
  snapshot: (mode?: 'rolling' | 'average') => TokenUsage | null
}

export function createLiveTokenUsageTracker(
  promptTokens: number,
  onUsage: (usage: TokenUsage) => void,
  options: { minIntervalMs?: number; now?: () => number } = {}
): LiveTokenUsageTracker {
  const minIntervalMs = Math.max(50, options.minIntervalMs ?? 250)
  const rollingWindowMs = 3_000
  const now = options.now ?? Date.now
  let asciiCharacters = 0
  let otherCharacters = 0
  let startedAt: number | null = null
  let lastReportedAt: number | null = null
  const tokenSamples: Array<{ at: number; tokens: number }> = []

  const estimatedTokens = (value: string): number => {
    let ascii = 0
    let other = 0
    for (const character of value) {
      if (character.charCodeAt(0) <= 127) ascii += 1
      else other += 1
    }
    return Math.ceil(ascii / 4 + other)
  }

  const usageAt = (currentTime: number, mode: 'rolling' | 'average'): TokenUsage | null => {
    if (startedAt === null) return null
    const completionTokens = Math.ceil(asciiCharacters / 4 + otherCharacters)
    const generationDurationMs = Math.max(1, currentTime - startedAt)
    let speed = completionTokens / (generationDurationMs / 1000)
    if (mode === 'rolling') {
      const windowStart = Math.max(startedAt, currentTime - rollingWindowMs)
      while (tokenSamples.length > 0 && tokenSamples[0].at < windowStart) tokenSamples.shift()
      const windowTokens = tokenSamples.reduce((sum, sample) => sum + sample.tokens, 0)
      const windowDurationMs = Math.max(1, currentTime - windowStart)
      speed = windowTokens / (windowDurationMs / 1000)
    }
    return {
      promptTokens: Math.max(0, Math.round(promptTokens)),
      completionTokens,
      totalTokens: Math.max(0, Math.round(promptTokens)) + completionTokens,
      estimated: true,
      generationDurationMs,
      tokensPerSecond: speed
    }
  }

  const report = (force: boolean): void => {
    if (startedAt === null) return
    const currentTime = now()
    if (
      !force &&
      lastReportedAt !== null &&
      currentTime - lastReportedAt < minIntervalMs
    ) return
    if (!force && currentTime - startedAt < minIntervalMs) return
    lastReportedAt = currentTime
    const usage = usageAt(currentTime, 'rolling')
    if (usage) onUsage(usage)
  }

  return {
    push(value) {
      if (!value) return
      const currentTime = now()
      if (startedAt === null) startedAt = currentTime
      for (const character of value) {
        if (character.charCodeAt(0) <= 127) asciiCharacters += 1
        else otherCharacters += 1
      }
      tokenSamples.push({ at: currentTime, tokens: estimatedTokens(value) })
      report(false)
    },
    flush() {
      report(true)
    },
    snapshot(mode = 'rolling') {
      return usageAt(now(), mode)
    }
  }
}
