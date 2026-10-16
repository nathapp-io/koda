import { describe, expect, test } from 'bun:test';
import type { FleetCommandOut, KodaToolDescriptor, ThreadAssign } from '@nathapp/fleet-protocol';
import { assignFor } from '../../test/helpers/assign';
import { parseAssign } from './assign-parser';

const cmd = (payload: unknown, over: Partial<FleetCommandOut> = {}): FleetCommandOut => ({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: payload as never, ...over });

function validThread(): ThreadAssign {
  return {
    threadId: 't1',
    action: 'SESSION',
    feature: 'brainstorm-x',
    resume: false,
    instructions: 'be helpful',
    backend: { kind: 'native', model: 'minimax/MiniMax-M3' },
    skills: [
      {
        sourceId: 's1',
        owner: 'acme',
        repo: 'skills',
        sha: 'a'.repeat(40),
        skills: [{ name: 'spec-writing', dir: 'spec-writing', description: 'writes specs' }],
      },
    ],
    initialMessage: { messageId: 'm1', text: 'hi' },
  };
}

function threadFixture(overThread: Partial<ThreadAssign> & Record<string, unknown> = {}, overAssign: Record<string, unknown> = {}) {
  const thread = { ...validThread(), ...overThread } as ThreadAssign;
  return { assign: assignFor('THREAD', { feature: 'thread-t1', thread, ...overAssign } as never), thread };
}

describe('parseAssign THREAD (US-001)', () => {
  test('US-001 AC-1: valid THREAD fixture returns assign.thread deep-equal to the thread block', () => {
    const { assign, thread } = threadFixture();
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread).toEqual(thread);
  });

  test('US-001 AC-2: fixture without thread returns invalid thread', () => {
    const { thread: _omit, ...withoutThread } = assignFor('THREAD', { feature: 'thread-t1' }) as unknown as Record<string, unknown>;
    void _omit;
    expect(parseAssign(cmd(withoutThread))).toEqual({ ok: false, detail: 'invalid thread' });
  });

  test('US-001 AC-3: RUN carrying the thread block returns invalid thread', () => {
    const run = assignFor('RUN', { thread: validThread() } as never);
    expect(parseAssign(cmd(run))).toEqual({ ok: false, detail: 'invalid thread' });
  });

  test('US-001 AC-4: fixture with profiles [fast] returns invalid profiles', () => {
    const { assign } = threadFixture({}, { profiles: ['fast'] });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid profiles' });
  });

  test('US-001 AC-5: fixture with bashMode gated returns invalid bashMode', () => {
    const { assign } = threadFixture({}, { bashMode: 'gated' });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid bashMode' });
  });

  test('US-001 AC-6: fixture with threadId ../t1 returns invalid threadId', () => {
    const { assign } = threadFixture({ threadId: '../t1' });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid threadId' });
  });

  test('US-001 AC-7: fixture with an unknown action REVIEW returns invalid thread action', () => {
    const { assign } = threadFixture({ action: 'REVIEW' as never });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread action' });
  });

  test('US-001 AC-10: fixture with action PUBLISH and initialMessage null returns assign.thread with action PUBLISH', () => {
    const { assign } = threadFixture({ action: 'PUBLISH', initialMessage: null as never });
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.action).toBe('PUBLISH');
  });

  test('US-001 AC-11: fixture with action DISCARD and initialMessage null returns assign.thread with action DISCARD', () => {
    const { assign } = threadFixture({ action: 'DISCARD', initialMessage: null as never });
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.action).toBe('DISCARD');
  });

  test('US-001 AC-12: fixture with action PUBLISH and a non-null initialMessage returns invalid initialMessage', () => {
    const { assign } = threadFixture({ action: 'PUBLISH' });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid initialMessage' });
  });

  test('US-001 AC-12b: fixture with action DISCARD and a non-null initialMessage returns invalid initialMessage', () => {
    const { assign } = threadFixture({ action: 'DISCARD' });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid initialMessage' });
  });

  test('US-001 AC-14: fixture with thread title "Divide brainstorm" returns assign.thread with that title', () => {
    const { assign } = threadFixture({ title: 'Divide brainstorm' } as never);
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.title).toBe('Divide brainstorm');
  });

  test('US-001 AC-14b: fixture without thread title returns assign.thread with no title key', () => {
    const { assign } = threadFixture();
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread).not.toHaveProperty('title');
  });

  test('US-001 AC-15: fixture with a 201-character thread title returns invalid thread title', () => {
    const { assign } = threadFixture({ title: 'a'.repeat(201) } as never);
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread title' });
  });

  test('US-001 AC-15b: fixture with an empty thread title returns invalid thread title', () => {
    const { assign } = threadFixture({ title: '' } as never);
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread title' });
  });

  test('US-001 AC-15c: fixture with a 200-character thread title is accepted', () => {
    const { assign } = threadFixture({ title: 'a'.repeat(200) } as never);
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
  });

  test('US-001 AC-15d: fixture with a non-string thread title returns invalid thread title', () => {
    const { assign } = threadFixture({ title: 42 } as never);
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread title' });
  });

  test('US-001 AC-8: fixture with thread feature ../x returns invalid thread feature', () => {
    const { assign } = threadFixture({ feature: '../x' });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread feature' });
  });

  test('US-001 AC-9: fixture with native model m/x[high] returns invalid backend', () => {
    const { assign } = threadFixture({ backend: { kind: 'native', model: 'm/x[high]' } as never });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid backend' });
  });

  test('US-001 AC-10: fixture with acp claude backend returns ok true', () => {
    const { assign } = threadFixture({ backend: { kind: 'acp', agent: 'claude' } as never });
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
  });

  test('US-001 AC-11: fixture with skills none returns invalid skills', () => {
    const { assign } = threadFixture({ skills: 'none' as never });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid skills' });
  });

  test('US-001 AC-12: fixture with 32769 ascii initialMessage text returns invalid initialMessage', () => {
    const { assign } = threadFixture({ initialMessage: { messageId: 'm1', text: 'a'.repeat(32769) } });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid initialMessage' });
  });

  test('US-001 AC-13: fixture with initialMessage null returns assign.thread with null initialMessage', () => {
    const { assign } = threadFixture({ initialMessage: null as never });
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.initialMessage).toBeNull();
  });

  test('US-001 AC-14: fixture with extra thread key returns assign.thread without extra', () => {
    const base = threadFixture();
    const withExtra = { ...base.thread, extra: 1 } as unknown as ThreadAssign;
    const assign = assignFor('THREAD', { feature: 'thread-t1', thread: withExtra } as never);
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread).not.toHaveProperty('extra');
  });

  test('US-001 AC-15: fixture with 11000 zhong text returns invalid initialMessage', () => {
    const { assign } = threadFixture({ initialMessage: { messageId: 'm1', text: '中'.repeat(11000) } });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid initialMessage' });
  });
  test('US-006 AC-1: PROJECT SESSION thread parses with kind PROJECT', () => {
    const { assign } = threadFixture({ kind: 'PROJECT' });
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.kind).toBe('PROJECT');
  });

  test('US-006 AC-2: PROJECT PUBLISH thread returns invalid thread action', () => {
    const { assign } = threadFixture({ kind: 'PROJECT', action: 'PUBLISH', initialMessage: null as never });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread action' });
  });

  test('US-006 AC-3: unknown kind returns invalid thread kind', () => {
    const { assign } = threadFixture({ kind: 'OTHER' as never });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread kind' });
  });

  test('US-006 AC-4: absent kind stays absent on assign.thread', () => {
    const { assign } = threadFixture();
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread).not.toHaveProperty('kind');
  });

  test('US-007 AC-1: WORKSPACE SESSION thread parses with kind WORKSPACE', () => {
    const { assign } = threadFixture({ kind: 'WORKSPACE' });
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.kind).toBe('WORKSPACE');
  });

  test('US-007 AC-2: WORKSPACE PUBLISH thread returns invalid thread action', () => {
    const { assign } = threadFixture({ kind: 'WORKSPACE', action: 'PUBLISH', initialMessage: null as never });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread action' });
  });

  test('US-007 AC-2b: WORKSPACE DISCARD thread returns invalid thread action', () => {
    const { assign } = threadFixture({ kind: 'WORKSPACE', action: 'DISCARD', initialMessage: null as never });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread action' });
  });

  test('US-007 AC-3: WORKSPACE carrying projectRepos returns invalid project repos', () => {
    const { assign } = threadFixture({ kind: 'WORKSPACE', projectRepos: [PROJECT_REPO] } as never);
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid project repos' });
  });

  test('US-007 AC-3b: WORKSPACE carrying projectReposUnavailable returns invalid project repos', () => {
    const { assign } = threadFixture({ kind: 'WORKSPACE', projectReposUnavailable: [UNAVAILABLE] } as never);
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid project repos' });
  });
});

/**
 * Fleet S5b US-006: the ASSIGN's koda tool descriptors are re-validated here with the same limits the API's
 * catalog enforces — the server is trusted to deliver, not to be well formed.
 */
const KODA_DESCRIPTOR: KodaToolDescriptor = {
  name: 'koda_get_ticket',
  description: 'reads one ticket of this project',
  inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
};

/** Distinct names that match KODA_TOOL_LIMITS.nameRe (`koda_` + a letter + up to 58 of `[a-z_]`). */
const validNames = (count: number): string[] => Array.from({ length: count }, (_, i) => `koda_${'x'.repeat(i + 1)}`);

describe('parseAssign koda tools (US-006 AC-1..AC-4)', () => {
  test('US-006 kodaTools AC-1: a THREAD ASSIGN with one valid descriptor keeps it on assign.thread', () => {
    const { assign } = threadFixture({ kodaTools: [KODA_DESCRIPTOR] } as never);
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.kodaTools).toEqual([KODA_DESCRIPTOR]);
  });

  test('US-006 kodaTools AC-2: a THREAD ASSIGN without kodaTools has no kodaTools key', () => {
    const { assign } = threadFixture();
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread).not.toHaveProperty('kodaTools');
  });

  test('US-006 kodaTools AC-3: a descriptor named get_ticket refuses the ASSIGN', () => {
    const { assign } = threadFixture({ kodaTools: [{ ...KODA_DESCRIPTOR, name: 'get_ticket' }] } as never);
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid koda tools' });
  });

  test('US-006 kodaTools AC-4: 33 valid descriptors refuse the ASSIGN (limit is 32)', () => {
    const descriptors = validNames(33).map((name) => ({ ...KODA_DESCRIPTOR, name }));
    const { assign } = threadFixture({ kodaTools: descriptors } as never);
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid koda tools' });
  });

  test('US-006 kodaTools: 32 valid descriptors are accepted (the limit itself passes)', () => {
    const descriptors = validNames(32).map((name) => ({ ...KODA_DESCRIPTOR, name }));
    const { assign } = threadFixture({ kodaTools: descriptors } as never);
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.kodaTools).toEqual(descriptors);
  });

  test('US-006 kodaTools: a malformed list is refused one row at a time', () => {
    const rows: Array<[string, unknown]> = [
      ['not an array', { name: 'koda_get_ticket' }],
      ['an empty name', [{ ...KODA_DESCRIPTOR, name: '' }]],
      ['a name over 64 characters', [{ ...KODA_DESCRIPTOR, name: `koda_${'x'.repeat(60)}` }]],
      ['a 2001-character description', [{ ...KODA_DESCRIPTOR, description: 'd'.repeat(2001) }]],
      ['a non-string description', [{ ...KODA_DESCRIPTOR, description: 42 }]],
      ['a missing description', [{ name: 'koda_get_ticket', inputSchema: { type: 'object' } }]],
      ['a null inputSchema', [{ ...KODA_DESCRIPTOR, inputSchema: null }]],
      ['an array inputSchema', [{ ...KODA_DESCRIPTOR, inputSchema: [] }]],
      ['a null entry', [null]],
      ['a missing name', [{ description: 'x', inputSchema: {} }]],
    ];
    for (const [label, kodaTools] of rows) {
      const { assign } = threadFixture({ kodaTools } as never);
      expect({ label, parsed: parseAssign(cmd(assign)) }).toEqual({ label, parsed: { ok: false, detail: 'invalid koda tools' } });
    }
  });

  test('US-006 kodaTools: a 2000-character description is accepted (the limit itself passes)', () => {
    const descriptor = { ...KODA_DESCRIPTOR, description: 'd'.repeat(2000) };
    const { assign } = threadFixture({ kodaTools: [descriptor] } as never);
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.kodaTools).toEqual([descriptor]);
  });
});

const PROJECT_REPO = { repoId: 'r1', owner: 'o', name: 'n', defaultBranch: 'main', cloneUrl: 'https://github.com/o/n.git' };
const UNAVAILABLE = { owner: 'o', name: 'g', reason: 'no installation' as const };
describe('project code ASSIGN', () => {
  test('project code AC-1: copies both repository arrays', () => {
    const { assign } = threadFixture({ kind: 'PROJECT', projectRepos: [PROJECT_REPO], projectReposUnavailable: [UNAVAILABLE] } as never);
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(parsed.assign.thread?.projectRepos).toEqual([PROJECT_REPO]);
    expect(parsed.assign.thread?.projectReposUnavailable).toEqual([UNAVAILABLE]);
    expect(parsed.assign.thread?.projectRepos).not.toBe(assign.thread?.projectRepos);
    expect(parsed.assign.thread?.projectRepos?.[0]).not.toBe(PROJECT_REPO);
  });
  test.each([
    'bad', Array(11).fill(PROJECT_REPO), null, [null],
    ...[{ repoId: '../x' }, { repoId: 'x'.repeat(65) }, { owner: 'a//b' }, { name: 'a/b' },
      { defaultBranch: '' }, { defaultBranch: 'x'.repeat(256) }, { defaultBranch: 'a\nb' },
      { cloneUrl: 'file:///tmp/x' }, { cloneUrl: 'http://github.com/o/n.git' }, { cloneUrl: 'not a url' }]
      .map((over) => [{ ...PROJECT_REPO, ...over }]),
  ].map((projectRepos) => ({ projectRepos })))('project code AC-2: rejects malformed projectRepos %j', ({ projectRepos }) => {
    expect(parseAssign(cmd(threadFixture({ kind: 'PROJECT', projectRepos } as never).assign))).toEqual({ ok: false, detail: 'invalid project repos' });
  });
  test.each([
    { projectReposUnavailable: Array(51).fill(UNAVAILABLE) },
    { projectReposUnavailable: [{ ...UNAVAILABLE, reason: 'other' }] },
    { projectReposUnavailable: 'bad' }, { projectReposUnavailable: [null] },
    { projectReposUnavailable: [{ ...UNAVAILABLE, owner: 'a//b' }] },
    { projectReposUnavailable: [{ ...UNAVAILABLE, name: 'a/b' }] },
    { kind: 'REPO', projectRepos: [PROJECT_REPO] },
    { kind: undefined, projectRepos: [] },
  ])('project code AC-3: rejects unavailable or REPO lists %j', (over) => {
    expect(parseAssign(cmd(threadFixture({ kind: 'PROJECT', ...over } as never).assign))).toEqual({ ok: false, detail: 'invalid project repos' });
  });
  test('project code boundaries: maximum lists and all unavailable reasons are accepted and sanitized', () => {
    const projectRepos = Array.from({ length: 10 }, (_, i) => ({ ...PROJECT_REPO, repoId: `r${i}`, extra: true }));
    const projectReposUnavailable = Array.from({ length: 50 }, (_, i) => ({ ...UNAVAILABLE, reason: ['no installation', 'limit', 'not a GitHub repository'][i % 3], extra: true }));
    const parsed = parseAssign(cmd(threadFixture({ kind: 'PROJECT', projectRepos, projectReposUnavailable } as never).assign));
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(parsed.assign.thread?.projectRepos).toHaveLength(10);
    expect(parsed.assign.thread?.projectReposUnavailable).toHaveLength(50);
    expect(parsed.assign.thread?.projectRepos?.[0]).not.toHaveProperty('extra');
    expect(parsed.assign.thread?.projectReposUnavailable?.[0]).not.toHaveProperty('extra');
    expect(parsed.assign.thread?.projectReposUnavailable?.[0]).not.toBe(projectReposUnavailable[0]);
  });
  test('project code AC-4: absent arrays stay absent', () => {
    const parsed = parseAssign(cmd(threadFixture({ kind: 'PROJECT' }).assign));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(parsed.assign.thread).not.toHaveProperty('projectRepos');
    expect(parsed.assign.thread).not.toHaveProperty('projectReposUnavailable');
  });
});
