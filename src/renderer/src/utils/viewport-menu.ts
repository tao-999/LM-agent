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

type ViewportMenuRectPlacementOptions = {
  anchorLeft: number
  anchorRight: number
  anchorTop: number
  anchorBottom: number
  menuWidth: number
  menuHeight: number
  viewportWidth: number
  viewportHeight: number
  gap?: number
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

export function placeViewportMenuBesideRect({
  anchorLeft,
  anchorRight,
  anchorTop,
  anchorBottom,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  gap = 4,
  margin = 8
}: ViewportMenuRectPlacementOptions): ViewportMenuPlacement {
  const safeWidth = Math.max(0, menuWidth)
  const safeHeight = Math.max(0, menuHeight)
  const rightLeft = anchorRight + gap
  const leftLeft = anchorLeft - gap - safeWidth
  const fitsRight = rightLeft + safeWidth <= viewportWidth - margin
  const fitsLeft = leftLeft >= margin
  const openLeft = !fitsRight && (fitsLeft || anchorLeft > viewportWidth - anchorRight)
  const openUp = anchorTop + safeHeight > viewportHeight - margin
  const preferredLeft = openLeft ? leftLeft : rightLeft
  const preferredTop = openUp ? anchorBottom - safeHeight : anchorTop

  return {
    left: clamp(preferredLeft, margin, viewportWidth - safeWidth - margin),
    top: clamp(preferredTop, margin, viewportHeight - safeHeight - margin),
    horizontal: openLeft ? 'left' : 'right',
    vertical: openUp ? 'up' : 'down'
  }
}
