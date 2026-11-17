import { ValidationAppException } from '@nathapp/nestjs-common';
import { describe, expect, it } from 'vitest';
import { HANDOFF_RECORD_MAX_BYTES, parseFlowHandoffInput } from './flow-handoff-input';

const headSha = '0123456789abcdef0123456789abcdef01234567';
const result = JSON.stringify({ schemaVersion: 1, featureWorkflow: { step: 'done', outcome: 'pushed', head: headSha } });
const entry = (patch: Record<string, unknown> = {}) => ({ runId: '8bd38595-ffbf-4092-89d0-f1ebbf375786', file: 'result.json', mtimeMs: 1763370000000, content: result, ...patch });
const handoff = (patch: Record<string, unknown> = {}) => ({ feature: 'chat-layout-overflow', headSha, record: [entry()], ...patch });
const body = (patch: Record<string, unknown> = {}) => ({ remoteUrl: 'https://github.com/acme/widgets', branch: 'feat/x', roles: { reviewer: 'acp:claude', supervisor: 'acp:claude' }, costCapUsd: '5', handoff: handoff(), ...patch });
function reason(fn: () => unknown): string {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as ValidationAppException).prefix).toBe('fleet.flowInput');
    return (error as ValidationAppException & { args: { reason: string } }).args.reason;
  }
  throw new Error('Expected validation failure');
}

describe('parseFlowHandoffInput', () => {
  it('AC-1 parses a valid handoff and preserves record order', () => {
    const second = entry({ file: 'ledger.md', content: 'ledger' });
    const input = body({ handoff: handoff({ record: [entry(), second] }) });
    expect(parseFlowHandoffInput(input)).toEqual(input);
  });
  it('AC-2 is idempotent', () => { const parsed = parseFlowHandoffInput(body()); expect(parseFlowHandoffInput(parsed)).toEqual(parsed); });
  it('AC-3 rejects spec and handoff forms together', () => expect(reason(() => parseFlowHandoffInput(body({ features: [] })))).toBe('handoff'));
  it('AC-4 rejects a non-object handoff', () => expect(reason(() => parseFlowHandoffInput(body({ handoff: 'bad' })))).toBe('handoff'));
  it('AC-5 rejects invalid feature names', () => expect(reason(() => parseFlowHandoffInput(body({ handoff: handoff({ feature: '-bad' }) })))).toBe('handoff.feature'));
  it('AC-6 rejects uppercase head SHA', () => expect(reason(() => parseFlowHandoffInput(body({ handoff: handoff({ headSha: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' }) })))).toBe('handoff.headSha'));
  it('AC-7 rejects an empty record', () => expect(reason(() => parseFlowHandoffInput(body({ handoff: handoff({ record: [] }) })))).toBe('handoff.record'));
  it('AC-8 rejects unapproved file names', () => expect(reason(() => parseFlowHandoffInput(body({ handoff: handoff({ record: [entry({ file: 'branch-review.json' })] }) })))).toBe('handoff.record.0.file'));
  it('AC-9 rejects unsafe run ids', () => expect(reason(() => parseFlowHandoffInput(body({ handoff: handoff({ record: [entry({ runId: '../x' })] }) })))).toBe('handoff.record.0.runId'));
  it('AC-10 rejects fractional mtimes', () => expect(reason(() => parseFlowHandoffInput(body({ handoff: handoff({ record: [entry({ mtimeMs: 1.5 })] }) })))).toBe('handoff.record.0.mtimeMs'));
  it('AC-11 rejects non-text content', () => expect(reason(() => parseFlowHandoffInput(body({ handoff: handoff({ record: [entry({ content: 5 })] }) })))).toBe('handoff.record.0.content'));
  it('AC-12 rejects run ids that differ only by case', () => expect(reason(() => parseFlowHandoffInput(body({ handoff: handoff({ record: [entry({ runId: 'Run-A' }), entry({ runId: 'run-a', file: 'ledger.md' })] }) })))).toBe('handoff.record'));
  it('AC-13 rejects more than 20 distinct runs', () => {
    const record = Array.from({ length: 21 }, (_, index) => entry({ runId: `run-${index}` }));
    expect(reason(() => parseFlowHandoffInput(body({ handoff: handoff({ record }) })))).toBe('handoff.record');
  });
  it('AC-14 caps aggregate UTF-8 content bytes', () => {
    const content = 'x'.repeat(HANDOFF_RECORD_MAX_BYTES + 1);
    expect(reason(() => parseFlowHandoffInput(body({ handoff: handoff({ record: [entry({ content })] }) })))).toBe('handoff.record');
  });
  it('AC-15 shares cost cap validation with spec inputs', () => expect(reason(() => parseFlowHandoffInput(body({ costCapUsd: 0 })))).toBe('costCapUsd'));
});
