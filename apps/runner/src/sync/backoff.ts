const BASE_MS = 1_000;
const MAX_MS = 60_000;

/** Full jitter: uniform in [0, min(maxMs, 1 s * 2^attempt)). The sync loop uses the 60 s default; logs pass their own (S2a D326). */
export function backoffDelay(attempt: number, random: () => number, maxMs: number = MAX_MS): number {
  const ceiling = Math.min(maxMs, BASE_MS * 2 ** Math.min(Math.max(attempt, 0), 16));
  return Math.floor(random() * ceiling);
}
