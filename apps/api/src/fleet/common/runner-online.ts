/**
 * A runner is online while its last sync is at most `offlineSec` old (S1 spec §4 step 1, D130).
 * Placement's `offline` misfit and every runner DTO use this one rule.
 */
export function isRunnerOnline(lastSeenAt: Date, now: Date, offlineSec: number): boolean {
  return now.getTime() - lastSeenAt.getTime() <= offlineSec * 1000;
}
