type NamedToolCall = {
  name: string
  arguments: Record<string, unknown>
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableValue(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function dedupeToolCalls<T extends NamedToolCall>(calls: T[]): T[] {
  const seen = new Set<string>()
  return calls.filter((call) => {
    const signature = `${call.name}\u0000${stableValue(call.arguments)}`
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  })
}
