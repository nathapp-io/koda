import { ValidationAppException } from '@nathapp/nestjs-common';
import { describe, expect, it } from 'vitest';
import { parseFlowInput } from './flow-input';

const threadBody = (patch: Record<string, unknown> = {}) => ({ features: [{ feature: 'flow-a', specPath: '.nax/features/flow-a/spec.md' }], roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: 25, ...patch });
const naxBody = (patch: Record<string, unknown> = {}) => ({ ...threadBody(), remoteUrl: 'https://github.com/org/repo.git', branch: 'feat/flow-a', specSha: 'a'.repeat(40), ...patch });
function reason(fn: () => unknown): string {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(ValidationAppException); return (error as { args: { reason: string } }).args.reason; }
  throw new Error('Expected validation failure');
}
describe('parseFlowInput', () => {
  it('AC-1 normalizes defaults and cap data', () => { const parsed = parseFlowInput(threadBody(), 'THREAD'); expect(parsed.features).toEqual([{ feature: 'flow-a', specPath: '.nax/features/flow-a/spec.md', dependsOn: [] }]); expect(parsed.costCapUsd).toBe('25'); expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed); });
  it('AC-2 rejects zero features', () => expect(reason(() => parseFlowInput(threadBody({ features: [] }), 'THREAD'))).toBe('features'));
  it('AC-3 rejects over 20 features', () => expect(reason(() => parseFlowInput(threadBody({ features: Array.from({ length: 21 }, (_, i) => ({ feature: `f${i}`, specPath: `f${i}.md` })) }), 'THREAD'))).toBe('features'));
  it('AC-4 rejects invalid feature grammar', () => expect(reason(() => parseFlowInput(threadBody({ features: [{ feature: '-flow', specPath: 'x.md' }] }), 'THREAD'))).toBe('features.0.feature'));
  it('AC-5 rejects duplicate features', () => expect(reason(() => parseFlowInput(threadBody({ features: [{ feature: 'flow-a', specPath: 'a.md' }, { feature: 'flow-a', specPath: 'b.md' }] }), 'THREAD'))).toBe('features.1.feature'));
  it('AC-6 rejects unsafe or non-markdown paths', () => { for (const specPath of ['../x.md', '/abs/spec.md', 'spec.txt']) expect(reason(() => parseFlowInput(threadBody({ features: [{ feature: 'flow-a', specPath }] }), 'THREAD'))).toBe('features.0.specPath'); });
  it('AC-7 rejects dependency on a later feature', () => expect(reason(() => parseFlowInput(threadBody({ features: [{ feature: 'a', specPath: 'a.md' }, { feature: 'b', specPath: 'b.md', dependsOn: ['c'] }, { feature: 'c', specPath: 'c.md' }] }), 'THREAD'))).toBe('features.1.dependsOn'));
  it('AC-8 rejects self dependency', () => expect(reason(() => parseFlowInput(threadBody({ features: [{ feature: 'a', specPath: 'a.md' }, { feature: 'b', specPath: 'b.md', dependsOn: ['b'] }] }), 'THREAD'))).toBe('features.1.dependsOn'));
  it('AC-9 requires reviewer role', () => expect(reason(() => parseFlowInput(threadBody({ roles: { supervisor: 'native:fast' } }), 'THREAD'))).toBe('roles.reviewer'));
  it('AC-10 rejects spaces in roles', () => expect(reason(() => parseFlowInput(threadBody({ roles: { reviewer: 'acp:claude', supervisor: 'bad role' } }), 'THREAD'))).toBe('roles.supervisor'));
  it('AC-11 rejects invalid caps', () => { for (const costCapUsd of [0, -1, 1000.01, 1.00001]) expect(reason(() => parseFlowInput(threadBody({ costCapUsd }), 'THREAD'))).toBe('costCapUsd'); });
  it('AC-12 accepts boundary caps', () => { expect(parseFlowInput(threadBody({ costCapUsd: 1000 }), 'THREAD').costCapUsd).toBe('1000'); expect(parseFlowInput(threadBody({ costCapUsd: 0.0001 }), 'THREAD').costCapUsd).toBe('0.0001'); });
  it('AC-13 rejects malformed spec sha', () => expect(reason(() => parseFlowInput(naxBody({ specSha: 'a'.repeat(39) }), 'NAX'))).toBe('specSha'));
  it('AC-14 rejects malformed branch', () => expect(reason(() => parseFlowInput(naxBody({ branch: 'feat/..x' }), 'NAX'))).toBe('branch'));
  it('AC-15 maps unsupported remote URL to its property', () => expect(reason(() => parseFlowInput(naxBody({ remoteUrl: 'git@github.com:org/repo.git' }), 'NAX'))).toBe('remoteUrl'));
});
