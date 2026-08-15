export class GenerationInterruptLatch {
  private readonly pending = new Set<string>()

  request(requestId: string): boolean {
    if (!requestId.trim()) return false
    this.pending.add(requestId)
    return true
  }

  take(requestId: string): boolean {
    return this.pending.delete(requestId)
  }

  clear(requestId: string): void {
    this.pending.delete(requestId)
  }
}
