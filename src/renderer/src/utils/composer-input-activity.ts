let activeUntil = 0

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

export function markComposerInputActive(durationMs = 180): void {
  activeUntil = Math.max(activeUntil, now() + Math.max(0, durationMs))
}

export function composerInputIdleDelay(): number {
  return Math.max(0, activeUntil - now())
}

export function resetComposerInputActivity(): void {
  activeUntil = 0
}
