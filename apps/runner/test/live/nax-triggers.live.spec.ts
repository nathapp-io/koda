import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAX_TRIGGER_NAMES } from '../../src/approvals/nax-triggers';

const naxSource = process.env['NAX_SOURCE_DIR'];
const describeLive = naxSource ? describe : describe.skip;

describeLive('nax TriggerName drift (spec §4.1)', () => {
  test('the runner list equals nax\'s union', () => {
    const text = readFileSync(join(naxSource ?? '', 'packages/nax/src/interaction/types.ts'), 'utf8');
    const union = /export type TriggerName =([\s\S]*?);/.exec(text)?.[1] ?? '';
    expect([...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort()).toEqual([...NAX_TRIGGER_NAMES].sort());
  });
});
