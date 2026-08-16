export type StreamRepetitionChannel = 'reasoning' | 'content'

export type StreamRepetitionDetection = {
  channel: StreamRepetitionChannel
  sampledTokens: number
  ngramSize: number
  duplicateRatio: number
  repeatedCoverage: number
}

type StreamRepetitionGuardOptions = {
  channel: StreamRepetitionChannel
  windowTokens?: number
  minimumTokens?: number
  sampleEveryTokens?: number
  ngramSize?: number
}

const TOKEN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu

export function tokenizeRepetitionSample(text: string): string[] {
  return text.normalize('NFKC').toLocaleLowerCase().match(TOKEN_PATTERN) ?? []
}

export class StreamRepetitionGuard {
  private readonly channel: StreamRepetitionChannel
  private readonly windowTokens: number
  private readonly minimumTokens: number
  private readonly sampleEveryTokens: number
  private readonly ngramSize: number
  private text = ''
  private tokensSinceSample = 0
  private detected = false

  constructor(options: StreamRepetitionGuardOptions) {
    this.channel = options.channel
    this.windowTokens = Math.max(256, options.windowTokens ?? 1000)
    this.minimumTokens = Math.min(
      this.windowTokens,
      Math.max(256, options.minimumTokens ?? 600)
    )
    this.sampleEveryTokens = Math.max(32, options.sampleEveryTokens ?? 64)
    this.ngramSize = Math.max(8, options.ngramSize ?? 16)
  }

  push(chunk: string): StreamRepetitionDetection | null {
    if (this.detected || !chunk) return null
    this.text += chunk
    if (this.text.length > 32_000) this.text = this.text.slice(-32_000)
    this.tokensSinceSample += tokenizeRepetitionSample(chunk).length
    if (this.tokensSinceSample < this.sampleEveryTokens) return null
    this.tokensSinceSample = 0

    const allTokens = tokenizeRepetitionSample(this.text)
    if (allTokens.length < this.minimumTokens) return null
    const tokens = allTokens.slice(-this.windowTokens)
    const totalNgrams = tokens.length - this.ngramSize + 1
    if (totalNgrams <= 0) return null

    const occurrences = new Map<string, number[]>()
    for (let index = 0; index < totalNgrams; index += 1) {
      const key = tokens.slice(index, index + this.ngramSize).join('\u0001')
      const positions = occurrences.get(key)
      if (positions) positions.push(index)
      else occurrences.set(key, [index])
    }

    const covered = new Uint8Array(tokens.length)
    let duplicateNgrams = 0
    let repeatedKinds = 0
    let maximumFrequency = 0
    for (const positions of occurrences.values()) {
      maximumFrequency = Math.max(maximumFrequency, positions.length)
      if (positions.length < 2) continue
      repeatedKinds += 1
      duplicateNgrams += positions.length - 1
      for (const position of positions) {
        const end = Math.min(tokens.length, position + this.ngramSize)
        for (let cursor = position; cursor < end; cursor += 1) covered[cursor] = 1
      }
    }

    const duplicateRatio = duplicateNgrams / totalNgrams
    const repeatedCoverage = covered.reduce((sum, value) => sum + value, 0) / tokens.length
    const uniqueRatio = occurrences.size / totalNgrams
    const longSequenceLoop =
      repeatedKinds >= 12 && duplicateRatio >= 0.38 && repeatedCoverage >= 0.72
    const shortCycleLoop =
      maximumFrequency >= 8 && uniqueRatio <= 0.22 && repeatedCoverage >= 0.82
    if (!longSequenceLoop && !shortCycleLoop) return null

    this.detected = true
    return {
      channel: this.channel,
      sampledTokens: tokens.length,
      ngramSize: this.ngramSize,
      duplicateRatio,
      repeatedCoverage
    }
  }
}

export function createStreamRepetitionGuard(
  channel: StreamRepetitionChannel
): StreamRepetitionGuard {
  return new StreamRepetitionGuard({ channel })
}
