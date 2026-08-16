export const CONTEXT_COMPRESSION_THRESHOLD = 0.95

export function shouldCompressContext(
  totalTokens: number,
  contextLength: number,
  disabledForCurrentRequest = false
): boolean {
  if (disabledForCurrentRequest) return false
  return totalTokens >= Math.max(2048, contextLength) * CONTEXT_COMPRESSION_THRESHOLD
}
