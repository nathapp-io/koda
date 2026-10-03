/**
 * nax `TriggerName` (interaction/types.ts:78-87, identical at v0.83.2 and main). Spec §4.1 / A1: every trigger is set
 * to false in the per-job profile, so a relayed job behaves like a headless run apart from bash asks.
 * `test/live/nax-triggers.live.spec.ts` checks this list against a nax checkout (NAX_SOURCE_DIR).
 */
export const NAX_TRIGGER_NAMES = [
  'security-review', 'cost-exceeded', 'merge-conflict',
  'cost-warning', 'max-retries', 'pre-merge', 'human-review', 'story-oversized',
  'review-gate',
] as const;
