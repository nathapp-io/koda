import { ValidationAppException } from '@nathapp/nestjs-common';
import { describe, expect, it } from 'vitest';
import { HANDOFF_RECORD_MAX_BYTES, parseFlowHandoffInput, readHandoffPrd } from './flow-handoff-input';

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
const resultWith = (featureWorkflow: Record<string, unknown>, schemaVersion: number = 1) => JSON.stringify({ schemaVersion, featureWorkflow });
const rejectRecord = (record: unknown[]) => reason(() => parseFlowHandoffInput(body({ handoff: handoff({ record }) })));

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
  it('AC-12 rejects run ids that differ only by case', () => expect(rejectRecord([entry({ runId: 'Run-A' }), entry({ runId: 'run-a', file: 'ledger.md' })])).toBe('handoff.record'));
  it('AC-13 rejects more than 20 distinct runs', () => {
    const record = Array.from({ length: 21 }, (_, index) => entry({ runId: `run-${index}` }));
    expect(rejectRecord(record)).toBe('handoff.record');
  });
  it('AC-14 caps aggregate UTF-8 content bytes', () => {
    const content = 'x'.repeat(HANDOFF_RECORD_MAX_BYTES + 1);
    expect(rejectRecord([entry({ content })])).toBe('handoff.record');
  });
  it('AC-15 shares cost cap validation with spec inputs', () => expect(reason(() => parseFlowHandoffInput(body({ costCapUsd: 0 })))).toBe('costCapUsd'));
  it('AC-1 refuses runs with a ledger but no result', () => expect(rejectRecord([entry({ file: 'ledger.md' })])).toBe('handoff.record'));
  it('AC-2 refuses tied newest result mtimes', () => expect(rejectRecord([entry(), entry({ runId: 'run-two' })])).toBe('handoff.record'));
  it('AC-3 refuses invalid newest result JSON', () => expect(rejectRecord([entry({ content: '{' })])).toBe('handoff.record'));
  it('AC-4 refuses schema versions other than one', () => expect(rejectRecord([entry({ content: resultWith({ step: 'done', outcome: 'pushed', head: headSha }, 2) })])).toBe('handoff.record'));
  it('AC-5 refuses a newest run that is not done', () => expect(rejectRecord([entry({ content: resultWith({ step: 'publish', outcome: 'pushed', head: headSha }) })])).toBe('handoff.record'));
  it('AC-6 refuses draft outcomes', () => expect(rejectRecord([entry({ content: resultWith({ step: 'done', outcome: 'draft', head: headSha }) })])).toBe('handoff.record'));
  it('AC-7 refuses a newest run with a different head', () => expect(rejectRecord([entry({ content: resultWith({ step: 'done', outcome: 'pushed', head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) })])).toBe('handoff.record'));
  it('AC-8 checks publishability only on newest run', () => {
    const old = entry({ content: resultWith({ step: 'done', outcome: 'draft', head: headSha }), mtimeMs: 100 });
    const newest = entry({ runId: 'newer', content: resultWith({ step: 'done', outcome: 'local-only', head: headSha }), mtimeMs: 200 });
    const record = [old, newest];
    expect(parseFlowHandoffInput(body({ handoff: handoff({ record }) })).handoff.record).toEqual(record);
  });
  it('AC-9 reads branch and pending stories using nax status rules', () => {
    const prd = { branchName: 'feat/x', userStories: [{ status: 'passed' }, { status: 'failed' }, { id: 'US-003', status: 'pending', passes: false }] };
    expect(readHandoffPrd(JSON.stringify(prd))).toEqual({ branchName: 'feat/x', pendingStoryIds: ['US-003'] });
  });
  it('AC-10 returns null branchName when absent', () => expect(readHandoffPrd(JSON.stringify({ userStories: [] }))).toEqual({ branchName: null, pendingStoryIds: [] }));
  it('AC-11 returns null for non-JSON PRD content', () => expect(readHandoffPrd('not json')).toBeNull());
  it('AC-12 refuses malformed or incomplete result objects', () => {
    const malformed = [JSON.stringify([]), JSON.stringify({ featureWorkflow: {} }), JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 1, featureWorkflow: [] })];
    for (const content of malformed) expect(rejectRecord([entry({ content })])).toBe('handoff.record');
  });
  it('AC-13 refuses ready outcomes', () => expect(rejectRecord([entry({ content: resultWith({ step: 'done', outcome: 'ready', head: headSha }) })])).toBe('handoff.record'));
  it('AC-14 remains idempotent after newest-run validation', () => { const parsed = parseFlowHandoffInput(body()); expect(parseFlowHandoffInput(parsed)).toEqual(parsed); });
});
