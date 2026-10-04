// ══════════════════════════════════════════════
// Token-bucket rate limiter for historical-data fetchers.
// Async-aware: callers `await limiter.take()` before each request.
// ══════════════════════════════════════════════

export class TokenBucket {
  private tokens: number;
  private lastRefill: number = Date.now();

  constructor(
    private capacity: number,
    private refillPerSec: number,
    private label = "tokens",
  ) {
    this.tokens = capacity;
  }

  async take(n = 1): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const deficit = n - this.tokens;
      const waitMs = Math.ceil((deficit / this.refillPerSec) * 1000);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  private refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }

  state(): { tokens: number; capacity: number; label: string } {
    this.refill();
    return { tokens: Math.floor(this.tokens), capacity: this.capacity, label: this.label };
  }
}
