export type StreamRepetitionStop = {
  channel: 'content' | 'reasoning'
  periodCharacters: number
  kind?: 'repeated-tail' | 'emoji-flood' | 'completion-echo' | 'idle-drift'
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

function hasCompletionEchoLoop(value: string): boolean {
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
  return closureEchoes.length >= 12 || (highestFrequency >= 4 && repeatedRatio >= 0.35)
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

export function createStreamRepetitionGuard(
  channel: StreamRepetitionStop['channel'],
  onStop: (stop: StreamRepetitionStop) => void
): { push: (value: string) => boolean } {
  const maxHistoryCharacters = 16_000
  const signatureCharacters = 96
  let history = ''
  let stopped = false
  let nextInspectionAt = 160

  return {
    push: (value) => {
      if (stopped) return true
      if (!value) return false
      history += value
      if (history.length < nextInspectionAt) return false
      nextInspectionAt = history.length + 48

      const sample = history.slice(-maxHistoryCharacters)
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
      if (hasCompletionEchoLoop(sample)) {
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
            period >= 160 ? 2 : period >= 80 ? 3 : Math.max(6, Math.ceil(96 / period))
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
