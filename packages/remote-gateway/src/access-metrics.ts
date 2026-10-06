// Fixed buckets and totals only: no prompt, path, device, session, or Run identifiers.
const bounds = [1, 5, 10, 25, 50, 100, 250, 1000, 5000, 30000, 125000] as const;
class Metric {
  count = 0;
  total = 0;
  max = 0;
  readonly buckets = Array<number>(bounds.length + 1).fill(0);
  record(value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    this.count++;
    this.total += value;
    this.max = Math.max(this.max, value);
    const index = bounds.findIndex((bound) => value <= bound);
    const slot = index < 0 ? bounds.length : index;
    this.buckets[slot] = (this.buckets[slot] ?? 0) + 1;
  }
  snapshot() {
    return {
      count: this.count,
      total: this.total,
      max: this.max,
      bounds: [...bounds],
      buckets: [...this.buckets],
    };
  }
}
export class GatewayAuthorizationMetrics {
  readonly authorizationMs = new Metric();
  readonly lookupMs = new Metric();
  readonly decodeMs = new Metric();
  readonly responseBytes = new Metric();
  readonly runCount = new Metric();
  recordTransport(metrics: { method: string; encodedBytes: number; decodeMs: number }) {
    if (!["runs.list", "run.get"].includes(metrics.method)) return;
    this.responseBytes.record(metrics.encodedBytes);
    this.decodeMs.record(metrics.decodeMs);
  }
  snapshot() {
    return {
      authorizationMs: this.authorizationMs.snapshot(),
      lookupMs: this.lookupMs.snapshot(),
      decodeMs: this.decodeMs.snapshot(),
      responseBytes: this.responseBytes.snapshot(),
      runCount: this.runCount.snapshot(),
    };
  }
}
export const gatewayAuthorizationMetrics = new GatewayAuthorizationMetrics();
