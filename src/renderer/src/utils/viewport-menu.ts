export type ViewportMenuPlacement = {
  left: number
  top: number
  horizontal: 'right' | 'left'
  vertical: 'down' | 'up'
}

type ViewportMenuPlacementOptions = {
  anchorX: number
  anchorY: number
  menuWidth: number
  menuHeight: number
  viewportWidth: number
  viewportHeight: number
  margin?: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

export function placeViewportMenu({
  anchorX,
  anchorY,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = 8
}: ViewportMenuPlacementOptions): ViewportMenuPlacement {
  const safeWidth = Math.max(0, menuWidth)
  const safeHeight = Math.max(0, menuHeight)
  const openLeft = anchorX + safeWidth + margin > viewportWidth
  const openUp = anchorY + safeHeight + margin > viewportHeight
  const preferredLeft = openLeft ? anchorX - safeWidth : anchorX
  const preferredTop = openUp ? anchorY - safeHeight : anchorY

  return {
    left: clamp(preferredLeft, margin, viewportWidth - safeWidth - margin),
    top: clamp(preferredTop, margin, viewportHeight - safeHeight - margin),
    horizontal: openLeft ? 'left' : 'right',
    vertical: openUp ? 'up' : 'down'
  }
}
