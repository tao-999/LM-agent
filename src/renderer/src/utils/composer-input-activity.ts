import {
  markUiInteractionActive,
  resetUiInteractionActivity,
  uiInteractionIdleDelay
} from './ui-interaction-activity.ts'

export function markComposerInputActive(durationMs = 420): void {
  markUiInteractionActive(durationMs)
}

export function composerInputIdleDelay(): number {
  return uiInteractionIdleDelay()
}

export function resetComposerInputActivity(): void {
  resetUiInteractionActivity()
}
