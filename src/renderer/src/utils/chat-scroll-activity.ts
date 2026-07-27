type ChatScrollActivityListener = (active: boolean) => void

let chatScrollActive = false
const listeners = new Set<ChatScrollActivityListener>()

export function isChatScrollActive(): boolean {
  return chatScrollActive
}

export function setChatScrollActive(active: boolean): void {
  if (chatScrollActive === active) return
  chatScrollActive = active
  for (const listener of listeners) listener(active)
}

export function subscribeChatScrollActivity(
  listener: ChatScrollActivityListener
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
