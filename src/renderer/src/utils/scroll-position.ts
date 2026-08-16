export const CHAT_BOTTOM_TOLERANCE_PX = 12

export interface ScrollViewportMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export function isScrollViewportAtBottom(
  metrics: ScrollViewportMetrics,
  tolerance = CHAT_BOTTOM_TOLERANCE_PX
): boolean {
  const scrollHeight = Number.isFinite(metrics.scrollHeight) ? metrics.scrollHeight : 0
  const scrollTop = Number.isFinite(metrics.scrollTop) ? Math.max(0, metrics.scrollTop) : 0
  const clientHeight = Number.isFinite(metrics.clientHeight) ? Math.max(0, metrics.clientHeight) : 0
  const safeTolerance = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0
  return scrollHeight - clientHeight - scrollTop <= safeTolerance
}

export function scrollViewportBottomTop(metrics: ScrollViewportMetrics): number {
  const scrollHeight = Number.isFinite(metrics.scrollHeight) ? Math.max(0, metrics.scrollHeight) : 0
  const clientHeight = Number.isFinite(metrics.clientHeight) ? Math.max(0, metrics.clientHeight) : 0
  return Math.max(0, scrollHeight - clientHeight)
}

export function shouldRestoreBottomAfterLayoutGrowth(
  metrics: ScrollViewportMetrics,
  growth: number,
  tolerance = CHAT_BOTTOM_TOLERANCE_PX
): boolean {
  const scrollHeight = Number.isFinite(metrics.scrollHeight) ? Math.max(0, metrics.scrollHeight) : 0
  const scrollTop = Number.isFinite(metrics.scrollTop) ? Math.max(0, metrics.scrollTop) : 0
  const clientHeight = Number.isFinite(metrics.clientHeight) ? Math.max(0, metrics.clientHeight) : 0
  const safeGrowth = Number.isFinite(growth) ? Math.max(0, growth) : 0
  const safeTolerance = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0
  const distanceFromBottom = Math.max(0, scrollHeight - clientHeight - scrollTop)
  return distanceFromBottom <= safeGrowth + safeTolerance
}
