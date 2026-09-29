const BASE_MS = 1_000;
const MAX_MS = 60_000;

/** Full jitter: uniform in [0, min(60 s, 1 s * 2^attempt)). */
export function backoffDelay(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_MS, BASE_MS * 2 ** Math.min(Math.max(attempt, 0), 16));
  return Math.floor(random() * ceiling);
}
