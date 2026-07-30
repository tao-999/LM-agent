let activeUntil = 0

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

export function markUiInteractionActive(durationMs = 360): void {
  activeUntil = Math.max(activeUntil, now() + Math.max(0, durationMs))
}

export function uiInteractionIdleDelay(): number {
  return Math.max(0, activeUntil - now())
}

export function resetUiInteractionActivity(): void {
  activeUntil = 0
}
