import { expect, test } from 'bun:test';
import { NAX_TRIGGER_NAMES } from './nax-triggers';

test('pins nax TriggerName (interaction/types.ts:78-87, identical at v0.83.2 and main a755a5464)', () => {
  expect([...NAX_TRIGGER_NAMES]).toEqual([
    'security-review', 'cost-exceeded', 'merge-conflict', 'cost-warning', 'max-retries', 'pre-merge', 'human-review', 'story-oversized', 'review-gate',
  ]);
});
