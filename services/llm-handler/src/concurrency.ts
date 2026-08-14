// Per-caller concurrency cap (08-llm-handlers.md section 5: "the Handler A
// service additionally applies a per-caller concurrency cap (default 2) so
// one consumer cannot starve another"). In-memory only, matching this
// service's own single-process deployment (compose.yaml runs one
// replica) -- a distributed cap would need a shared store, not justified
// at this scale.

export class ConcurrencyGate {
  private readonly limit: number;
  private readonly active = new Map<string, number>();

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Reserves one slot for `callerApp`, or returns false if that caller is
   * already at its cap. Every true result must be paired with exactly one
   * release() call, however the request ends (success, error, or abort). */
  tryAcquire(callerApp: string): boolean {
    const count = this.active.get(callerApp) ?? 0;
    if (count >= this.limit) {
      return false;
    }
    this.active.set(callerApp, count + 1);
    return true;
  }

  release(callerApp: string): void {
    const count = this.active.get(callerApp) ?? 0;
    if (count <= 1) {
      this.active.delete(callerApp);
    } else {
      this.active.set(callerApp, count - 1);
    }
  }
}
