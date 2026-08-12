export type StreamRepetitionStop = {
  channel: 'content' | 'reasoning'
  periodCharacters: number
  kind?:
    | 'repeated-tail'
    | 'emoji-flood'
    | 'completion-echo'
    | 'idle-drift'
    | 'cross-turn-repeat'
    | 'paraphrase-loop'
}

export type StreamRepetitionGuardOptions = {
  priorSamples?: string[]
}

const emojiGraphemePattern =
  /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u
const substantiveGraphemePattern = /[\p{L}\p{N}]/u
const graphemeSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })

function hasEmojiFlood(value: string): boolean {
  const tail = value.slice(-2_400)
  const graphemes = [...graphemeSegmenter.segment(tail)].map((entry) => entry.segment)
  let emojiCount = 0
  let nonWhitespaceDecorativeCount = 0

  for (let index = graphemes.length - 1; index >= 0; index -= 1) {
    const grapheme = graphemes[index]
    if (emojiGraphemePattern.test(grapheme)) {
      emojiCount += 1
      nonWhitespaceDecorativeCount += 1
      continue
    }
    if (/^\s+$/u.test(grapheme)) continue
    if (!substantiveGraphemePattern.test(grapheme)) {
      nonWhitespaceDecorativeCount += 1
      continue
    }
    break
  }

  return (
    emojiCount >= 40 &&
    nonWhitespaceDecorativeCount >= 40 &&
    emojiCount / nonWhitespaceDecorativeCount >= 0.7
  )
}

function hasCompletionEchoLoop(
  value: string,
  channel: StreamRepetitionStop['channel']
): boolean {
  const source = value.slice(-6_000)
  const closureEchoes =
    source.match(
      /(?:修改|修复|处理|改动|任务|验证|复查|检查)?(?:已经|已)?(?:完成|完毕|通过|搞定|改好|修正)|已改|等待(?:下一个|新的?|用户)?(?:任务|指令|输入)|(?:task\s*)?(?:complete|completed)|\b(?:done|final|end|stop|bye|period)\b|awaiting(?:\s+(?:your|the|next|new|user))*\s+(?:input|command|prompt|task)|end\s+of\s+(?:line|transmission)|(?:last|final)\s+line|no\s+more\s+(?:text|words)/giu
    ) ?? []
  if (closureEchoes.length < 6) return false

  const normalized = source
    .normalize('NFKC')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
  const tail = normalized.slice(-1_600)
  const gramSize = 8
  if (tail.length < 240) return false

  const frequencies = new Map<string, number>()
  for (let index = 0; index <= tail.length - gramSize; index += 1) {
    const gram = tail.slice(index, index + gramSize)
    frequencies.set(gram, (frequencies.get(gram) ?? 0) + 1)
  }
  const totalGrams = tail.length - gramSize + 1
  const uniqueGrams = frequencies.size
  const highestFrequency = Math.max(...frequencies.values())
  const repeatedRatio = (totalGrams - uniqueGrams) / totalGrams
  if (channel === 'content') {
    return false
  }
  return closureEchoes.length >= 12 || (highestFrequency >= 4 && repeatedRatio >= 0.35)
}

function normalizeEvidenceLine(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/(?:\uFFFD|�)+/gu, '')
    .replace(/\d+/gu, '#')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

function hasRepeatedCompletionStructure(
  value: string,
  channel: StreamRepetitionStop['channel']
): boolean {
  const source = value.slice(-12_000)
  const completionClaims =
    source.match(
      /(?:任务|修改|修复|处理|改动|验证|复查|检查)?(?:已经|已)?(?:完成|完毕|通过|搞定|改好|修正)|(?:task\s*)?(?:complete|completed)|\b(?:done|final|end)\b/giu
    ) ?? []
  if (completionClaims.length < (channel === 'content' ? 3 : 2)) return false

  const frequencies = new Map<string, number>()
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = normalizeEvidenceLine(rawLine)
    if (line.length < 16) continue
    frequencies.set(line, (frequencies.get(line) ?? 0) + 1)
  }

  const minimumCopies = channel === 'content' ? 3 : 2
  const repeatedLines = [...frequencies.entries()].filter(
    ([, count]) => count >= minimumCopies
  )
  const repeatedCharacters = repeatedLines.reduce(
    (sum, [line, count]) => sum + line.length * (count - 1),
    0
  )
  const minimumDistinctLines = channel === 'content' ? 2 : 1
  const minimumRepeatedCharacters = channel === 'content' ? 120 : 96

  return (
    repeatedLines.length >= minimumDistinctLines &&
    repeatedCharacters >= minimumRepeatedCharacters
  )
}

function hasPostCompletionIdleDrift(value: string): boolean {
  const source = value.slice(-3_000)
  const completionPattern =
    /(?:任务|修改|修复|处理|改动|验证|复查|检查)?(?:已经|已)?(?:完成|完毕|通过|搞定|改好|修正)|(?:task\s*)?(?:complete|completed)|\b(?:done|final)\b/iu
  const idlePattern =
    /等待(?:下一个|新的?|用户)?(?:任务|指令|输入)|在线待命|静默待命|准备好继续|awaiting(?:\s+(?:your|the|next|new|user))*\s+(?:input|command|prompt|task)|ready\s+for\s+(?:the\s+)?next|system\s+idle/iu
  const completionClaims = source.match(
    /(?:任务|修改|修复|处理|改动|验证|复查|检查)?(?:已经|已)?(?:完成|完毕|通过|搞定|改好|修正)|(?:task\s*)?(?:complete|completed)|\b(?:done|final)\b/giu
  )
  const completionAt = source.search(completionPattern)
  const idleAt = source.search(idlePattern)
  return (completionClaims?.length ?? 0) >= 2 && completionAt >= 0 && idleAt > completionAt
}

function normalizeCrossTurnSample(value: string, limit = 6_000): string {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\d+/gu, '#')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
  return limit > 0 ? normalized.slice(0, limit) : normalized
}

function ngrams(value: string, size: number): Set<string> {
  const result = new Set<string>()
  for (let index = 0; index <= value.length - size; index += 1) {
    result.add(value.slice(index, index + size))
  }
  return result
}

function ngramSimilarity(left: string, right: string): number {
  const size = 4
  const leftGrams = ngrams(left, size)
  const rightGrams = ngrams(right, size)
  if (!leftGrams.size || !rightGrams.size) return 0
  let intersection = 0
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) intersection += 1
  }
  return intersection / Math.max(leftGrams.size, rightGrams.size)
}

function ngramContainment(source: string, candidate: string, size = 5): number {
  const sourceGrams = ngrams(source, size)
  const candidateGrams = ngrams(candidate, size)
  if (!sourceGrams.size || !candidateGrams.size) return 0
  let intersection = 0
  for (const gram of sourceGrams) {
    if (candidateGrams.has(gram)) intersection += 1
  }
  return intersection / sourceGrams.size
}

function hasWithinTurnParaphraseLoop(value: string): boolean {
  const paragraphs = value
    .slice(-16_000)
    .split(/\r?\n\s*\r?\n/gu)
    .map((paragraph) => normalizeCrossTurnSample(paragraph, 2_000))
    .filter((paragraph) => paragraph.length >= 72)
  if (paragraphs.length < 5) return false

  for (let currentIndex = 4; currentIndex < paragraphs.length; currentIndex += 1) {
    const current = paragraphs[currentIndex]
    let matchCount = 0
    for (let earlierIndex = 0; earlierIndex <= currentIndex - 2; earlierIndex += 1) {
      const earlier = paragraphs[earlierIndex]
      const shorterLength = Math.min(current.length, earlier.length)
      if (shorterLength < 72) continue
      const score = Math.max(
        ngramContainment(current, earlier, 4),
        ngramContainment(earlier, current, 4)
      )
      if (score < 0.32) continue
      matchCount += 1
      if (matchCount >= 2) return true
    }
  }
  return false
}

function hasCrossTurnRepeat(value: string, priorSamples: string[]): boolean {
  if (priorSamples.length < 2) return false
  const current = normalizeCrossTurnSample(value)
  if (current.length < 40) return false
  const prior = priorSamples
    .map((sample) => normalizeCrossTurnSample(sample))
    .filter((sample) => sample.length >= 40)
    .slice(-8)
  if (prior.length < 2) return false

  const shortestPrior = Math.min(...prior.map((sample) => sample.length))
  const exactPrefixThreshold = Math.max(40, Math.min(160, Math.floor(shortestPrior * 0.82)))
  if (current.length >= exactPrefixThreshold) {
    const prefix = current.slice(0, exactPrefixThreshold)
    const exactMatches = prior.filter((sample) => sample.startsWith(prefix)).length
    if (exactMatches >= 2) return true
  }

  if (current.length < 120) return false
  const comparisonLength = Math.min(current.length, 1_200)
  const currentPrefix = current.slice(0, comparisonLength)
  const fuzzyMatches = prior.filter((sample) => {
    const priorPrefix = sample.slice(0, comparisonLength)
    if (priorPrefix.length < Math.floor(comparisonLength * 0.8)) return false
    return ngramSimilarity(currentPrefix, priorPrefix) >= 0.88
  }).length
  return fuzzyMatches >= 2
}

export function createStreamRepetitionGuard(
  channel: StreamRepetitionStop['channel'],
  onStop: (stop: StreamRepetitionStop) => void,
  options: StreamRepetitionGuardOptions = {}
): { push: (value: string) => boolean } {
  const maxHistoryCharacters = 16_000
  const signatureCharacters = 96
  let history = ''
  let stopped = false
  let nextInspectionAt = (options.priorSamples?.length ?? 0) >= 2 ? 40 : 160
  let nextParaphraseInspectionAt = 800

  return {
    push: (value) => {
      if (stopped) return true
      if (!value) return false
      history += value
      if (history.length < nextInspectionAt) return false
      nextInspectionAt = history.length + ((options.priorSamples?.length ?? 0) >= 2 ? 12 : 48)

      const sample = history.slice(-maxHistoryCharacters)
      if (hasCrossTurnRepeat(history, options.priorSamples ?? [])) {
        stopped = true
        onStop({ channel, periodCharacters: 0, kind: 'cross-turn-repeat' })
        return true
      }
      if (
        channel === 'reasoning' &&
        history.length >= nextParaphraseInspectionAt
      ) {
        nextParaphraseInspectionAt = history.length + 192
        if (hasWithinTurnParaphraseLoop(history)) {
          stopped = true
          onStop({ channel, periodCharacters: 0, kind: 'paraphrase-loop' })
          return true
        }
      }
      if (hasEmojiFlood(sample)) {
        stopped = true
        onStop({ channel, periodCharacters: 0, kind: 'emoji-flood' })
        return true
      }
      if (hasPostCompletionIdleDrift(sample)) {
        stopped = true
        onStop({ channel, periodCharacters: 0, kind: 'idle-drift' })
        return true
      }
      if (hasRepeatedCompletionStructure(sample, channel)) {
        stopped = true
        onStop({ channel, periodCharacters: 0, kind: 'completion-echo' })
        return true
      }
      if (hasCompletionEchoLoop(sample, channel)) {
        stopped = true
        onStop({ channel, periodCharacters: 0, kind: 'completion-echo' })
        return true
      }
      if (sample.length < signatureCharacters * 2) return false
      const currentStart = sample.length - signatureCharacters
      const signature = sample.slice(currentStart)
      let previousStart = sample.lastIndexOf(signature, currentStart - 1)
      let inspectedCandidates = 0
      while (previousStart >= 0 && inspectedCandidates < 12) {
        const period = currentStart - previousStart
        if (period > 6_000) break
        if (period >= 2) {
          const repetitions =
            channel === 'content'
              ? period >= 160
                ? 3
                : period >= 80
                  ? 4
                  : Math.max(8, Math.ceil(160 / period))
              : period >= 160
                ? 2
                : period >= 80
                  ? 3
                  : Math.max(6, Math.ceil(96 / period))
          const requiredCharacters = period * repetitions
          if (requiredCharacters <= sample.length) {
            const repeatedTail = sample.slice(-requiredCharacters)
            const unit = repeatedTail.slice(0, period)
            let identical = true
            for (let index = 1; index < repetitions; index += 1) {
              if (repeatedTail.slice(index * period, (index + 1) * period) !== unit) {
                identical = false
                break
              }
            }
            if (identical && /\S/.test(unit)) {
              stopped = true
              onStop({ channel, periodCharacters: period, kind: 'repeated-tail' })
              return true
            }
          }
        }
        inspectedCandidates += 1
        previousStart = sample.lastIndexOf(signature, previousStart - 1)
      }
      return false
    }
  }
}
