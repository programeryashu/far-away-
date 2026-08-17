/**
 * Failure-window rate limiter for the human-friendly join code.
 *
 * The 6-character code is intentionally typeable, which makes failed attempts
 * the signal to watch: a legitimate user fails a couple of times, a brute
 * force fails continuously. Only FAILURES count — successful joins never
 * accumulate — and a success clears the key. When failures within the window
 * reach the cap, the key is locked out until the oldest counted failure ages
 * out of the window.
 */
export class FailureRateLimiter {
  private failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor(maxFailures: number, windowMs: number) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
  }

  check(key: string, now: number = Date.now()): { blocked: boolean; retryAfterSec: number } {
    this.pruneKey(key, now);
    const hits = this.failures.get(key) ?? [];
    if (hits.length >= this.maxFailures) {
      const oldest = Math.min(...hits);
      const retryAfterMs = oldest + this.windowMs - now;
      return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    return { blocked: false, retryAfterSec: 0 };
  }

  recordFailure(key: string, now: number = Date.now()): void {
    this.pruneKey(key, now);
    const hits = this.failures.get(key) ?? [];
    hits.push(now);
    this.failures.set(key, hits);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  private pruneKey(key: string, now: number): void {
    const hits = this.failures.get(key);
    if (!hits) return;
    const kept = hits.filter((ts) => now - ts < this.windowMs);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
  }
}
