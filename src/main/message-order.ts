export type OrderedMessage = {
  role: string
  content: string
}

/**
 * Several llama.cpp chat templates accept at most one system message and require
 * it to be the first message. Runtime guidance can be produced between tool
 * rounds, so merge every system fragment into a single leading message before
 * token fitting and again immediately before provider serialization.
 */
export function normalizeSystemMessageOrder<T extends OrderedMessage>(messages: T[]): T[] {
  const systemMessages = messages.filter((message) => message.role === 'system')
  if (!systemMessages.length) return messages

  const content = systemMessages
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n')
  const firstSystem = systemMessages[0]
  return [
    { ...firstSystem, content },
    ...messages.filter((message) => message.role !== 'system')
  ]
}
