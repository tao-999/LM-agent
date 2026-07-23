export type WorkflowCycleObservation = {
  toolName: string
  arguments: Record<string, unknown>
  taskState: string
  progressRevision: number
}

export type WorkflowCycleResult = {
  detected: boolean
  occurrences: number
  toolName: string
}

type RecordedObservation = WorkflowCycleObservation & {
  comparableArgument: string
}

const COMMON_QUERY_WORDS = new Set([
  '查询',
  '搜索',
  '检索',
  '历史',
  '记录',
  '会话',
  '内容',
  '相关',
  '当前',
  '任务',
  '用户',
  '系统',
  '继续'
])

function normalizedText(value: unknown): string {
  return typeof value === 'string'
    ? value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/<[^>]+>/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : ''
}

function argumentFingerprint(
  toolName: string,
  args: Record<string, unknown>
): string {
  if (toolName === 'search_conversation_history') {
    return normalizedText(args.query)
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(args)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, typeof value === 'string' ? normalizedText(value) : value])
    )
  )
}

function queryTerms(value: string): Set<string> {
  const terms = new Set<string>()
  for (const token of value.split(/\s+/).filter(Boolean)) {
    if (!COMMON_QUERY_WORDS.has(token)) terms.add(token)
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length >= 2) {
      for (let index = 0; index < token.length - 1; index += 1) {
        terms.add(token.slice(index, index + 2))
      }
    }
  }
  return terms
}

function similarity(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right || left.includes(right) || right.includes(left)) return 1
  const leftTerms = queryTerms(left)
  const rightTerms = queryTerms(right)
  if (!leftTerms.size || !rightTerms.size) return 0
  let intersection = 0
  for (const term of leftTerms) {
    if (rightTerms.has(term)) intersection += 1
  }
  return intersection / Math.min(leftTerms.size, rightTerms.size)
}

export class WorkflowCycleGuard {
  private observations: RecordedObservation[] = []

  observe(observation: WorkflowCycleObservation): WorkflowCycleResult {
    const comparableArgument = argumentFingerprint(
      observation.toolName,
      observation.arguments
    )
    const current: RecordedObservation = {
      ...observation,
      comparableArgument
    }
    this.observations.push(current)
    if (this.observations.length > 16) this.observations.shift()

    const peers = this.observations.filter(
      (item) =>
        item.progressRevision === current.progressRevision &&
        item.taskState === current.taskState &&
        item.toolName === current.toolName &&
        similarity(item.comparableArgument, current.comparableArgument) >=
          (current.toolName === 'search_conversation_history' ? 0.42 : 0.9)
    )
    return {
      detected: peers.length >= 3,
      occurrences: peers.length,
      toolName: current.toolName
    }
  }

  reset(): void {
    this.observations = []
  }
}

