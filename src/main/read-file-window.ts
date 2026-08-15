export interface ReadFileWindow {
  start: number
  end: number
}

function clampLine(value: number, totalLines: number): number {
  return Math.min(totalLines, Math.max(1, Math.trunc(value)))
}

export function expandReadFileWindow(
  totalLines: number,
  requestedStart: number,
  requestedEnd: number
): ReadFileWindow {
  const safeTotal = Math.max(1, Math.trunc(totalLines))
  return {
    start: clampLine(Math.min(requestedStart, requestedEnd), safeTotal),
    end: clampLine(Math.max(requestedStart, requestedEnd), safeTotal)
  }
}
