const REPORT_INTERVAL_MS = 60_000;

/**
 * Counts what a path that must never wait or throw had to drop (a trace Valkey did not take, a request
 * not captured), and reports the count since start through `report` at most once a minute.
 */
export class DropCounter {
  private dropped = 0;
  private lastReport = 0;

  constructor(private readonly report: (droppedSinceStart: number) => void) {}

  count(): void {
    this.dropped++;
    const now = Date.now();
    if (now - this.lastReport < REPORT_INTERVAL_MS) return;
    this.lastReport = now;
    this.report(this.dropped);
  }

  get total(): number {
    return this.dropped;
  }
}
