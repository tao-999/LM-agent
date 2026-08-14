export const MIN_READ_FILE_LINES = 1000

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
  requestedEnd: number,
  minimumLines = MIN_READ_FILE_LINES
): ReadFileWindow {
  const safeTotal = Math.max(1, Math.trunc(totalLines))
  const safeMinimum = Math.max(1, Math.trunc(minimumLines))
  if (safeTotal <= safeMinimum) return { start: 1, end: safeTotal }

  let start = clampLine(Math.min(requestedStart, requestedEnd), safeTotal)
  let end = clampLine(Math.max(requestedStart, requestedEnd), safeTotal)
  const currentLength = end - start + 1
  if (currentLength >= safeMinimum) return { start, end }

  const missing = safeMinimum - currentLength
  const availableBefore = start - 1
  const expandBefore = Math.min(availableBefore, Math.floor(missing / 2))
  start -= expandBefore
  end = Math.min(safeTotal, end + missing - expandBefore)

  const remaining = safeMinimum - (end - start + 1)
  if (remaining > 0) start = Math.max(1, start - remaining)

  return { start, end }
}
