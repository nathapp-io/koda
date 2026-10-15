import { afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession } from '@nathapp/nax-agent';
import type { ProjectRepoAssign, ThreadAssign } from '@nathapp/fleet-protocol';
import type { RepoCredentialProvider } from '../../src/credentials/broker';
import { createGit } from '../../src/executor/git';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { RepoMutex } from '../../src/supervisor/repo-mutex';
import { ThreadJobRun, type ThreadHostDeps, type ThreadOpenInput } from '../../src/thread/thread-job-run';
import { refreshMirror } from '../../src/thread/project-code/mirror-store';
import { threadScratchDir } from '../../src/thread/thread-paths';
import { assignFor } from '../helpers/assign';
import { git, isolateGit, makeOrigin } from '../helpers/git-fixture';
import { waitFor } from '../helpers/wait';

beforeAll(isolateGit);
const contexts: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of contexts.splice(0)) await cleanup(); });
const repos: ProjectRepoAssign[] = [1, 2].map((n) => ({ repoId: `r${n}`, owner: 'acme', name: `app${n}`, defaultBranch: 'main', cloneUrl: `https://github.com/acme/app${n}.git` }));
const firstRepo: ProjectRepoAssign = { repoId: 'r1', owner: 'acme', name: 'app1', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/app1.git' };
const sha = 'a'.repeat(40);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

async function setup(options: { repos?: ProjectRepoAssign[]; absent?: boolean; noCredentials?: boolean; unavailable?: ThreadAssign['projectReposUnavailable']; timeout?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'project-run-'));
  const journal = Journal.open(':memory:');
  const thread: ThreadAssign = { threadId: 't1', kind: 'PROJECT', action: 'SESSION', feature: 'thread-t1', resume: false, instructions: 'help', initialMessage: null, backend: { kind: 'native', model: 'test' }, skills: [], ...(!options.absent ? { projectRepos: options.repos ?? repos } : {}), projectReposUnavailable: options.unavailable };
  const jobDir = join(root, 'jobs', 'j1');
  await mkdir(jobDir, { recursive: true });
  journal.insertJob({ assign: assignFor('THREAD', { jobId: 'j1', thread }), leaseEpoch: 1, repoKey: 'acme/app', jobDir });
  const acquired: Array<Parameters<RepoCredentialProvider['acquireRepo']>> = [];
  const released: string[] = [];
  const refreshed: Array<Parameters<typeof refreshMirror>[0]> = [];
  const opens: ThreadOpenInput[] = [];
  let releasesAtOpen: string[] = [];
  const provider: RepoCredentialProvider = {
    async acquireRepo(...args) { acquired.push(args); return { ok: true, credentials: { helper: `helper-${args[1].repoId}`, binDir: null } }; },
    async releaseRepo(_row, id) { released.push(id); },
  };
  const host: ThreadHostDeps & { repoCredentials?: RepoCredentialProvider; refreshMirror?: typeof refreshMirror } = {
    homeDir: root, workspaceRoot: root, git: createGit(),
    credentials: { async acquire() { throw new Error('unexpected job credentials'); }, async release() {} },
    repoCredentials: options.noCredentials ? undefined : provider,
    async refreshMirror(input) { refreshed.push(input); return { ok: true, sha }; },
    async ensureSkills() { return { ok: true }; },
    sessions: { async open(input) { opens.push(input); releasesAtOpen = [...released]; return { ok: true, resumed: false, session: { id: 's1', backend: { kind: 'native', capabilities: {} }, lastTurn: undefined, async *send() {}, answer: () => 'accepted', cancel() {}, async close() {} } as AgentSession }; } },
  };
  const mutex = new RepoMutex();
  const run = new ThreadJobRun({ journal, host, mutex, log: createMemoryLogger(), now: () => new Date(), sleep: Bun.sleep,
    logs: { register() {}, wake() {}, async drain() { return 'drained'; }, stopJob() {} },
    tuning: { threadIdleMs: 60000, threadHeartbeatMs: 60000, threadWakeGapMs: 0, threadSearchTimeoutMs: 1000, threadSkillFetchTimeoutMs: 1000, logDrainTimeoutMs: 1000, threadCloseTimeoutMs: 1000, threadRunningAckPollMs: 1, threadRunningAckWaitMs: 0, ...(options.timeout === undefined ? {} : { projectCodeFetchTimeoutMs: options.timeout }) },
  }, 'j1', 1);
  let starting: Promise<void> | undefined;
  contexts.push(async () => { run.halt(); await starting; journal.close(); await rm(root, { recursive: true, force: true }); });
  return { root, journal, host, provider, acquired, released, refreshed, opens, mutex, run, releasesAtOpen: () => releasesAtOpen,
    start() { starting = run.start('prepare'); return starting; },
    async opened() { await waitFor(() => opens.length === 1); },
    cancel() { journal.updateJob('j1', 1, { cancelRequestedAt: new Date().toISOString() }); },
    async tool(name: string, input: unknown = {}) { const tool = opens[0]?.tools?.find((t) => t.name === name); expect(tool).toBeDefined(); if (tool === undefined) throw new Error(`missing tool ${name}`); return tool.run(input, { sessionId: 's1', toolCallId: 'call1', signal: new AbortController().signal }); },
  };
}

test('AC-1: all repository acquisitions start before either resolves', async () => {
  const c = await setup(); const gate = deferred<Awaited<ReturnType<RepoCredentialProvider['acquireRepo']>>>();
  c.provider.acquireRepo = async (...args) => { c.acquired.push(args); return gate.promise; };
  c.start(); await Bun.sleep(30);
  const observed = c.acquired.map((a) => a[1]);
  gate.resolve({ ok: true, credentials: { helper: null, binDir: null } });
  expect(observed).toEqual(repos.map(({ repoId, cloneUrl }) => ({ repoId, cloneUrl })));
  expect(c.acquired.every((a) => a[0].jobId === 'j1' && a[2].wait && a[2].isCancelled?.() === false)).toBe(true);
});

test('AC-2, AC-3, AC-4: releases precede open; ordered tools, scratch and refresh arguments', async () => {
  const c = await setup(); c.start(); await c.opened();
  expect(c.releasesAtOpen()).toEqual(['r1', 'r2']);
  expect(c.opens[0]?.tools?.map((t) => t.name)).toEqual(['load_skill', 'read_skill_file', 'list_repos', 'list_files', 'search_repo', 'read_file']);
  expect(c.opens[0]?.worktree).toBe(threadScratchDir(c.root, 't1'));
  expect(c.refreshed).toHaveLength(2);
  for (const input of c.refreshed) { expect(input.mutex).toBe(c.mutex); expect(input.pinId).toBe('j1'); expect(input.credentialHelper).toBe(`helper-${input.repo.repoId}`); expect(input.timeoutMs).toBe(120000); }
});

for (const reason of ['git token: repo_not_assigned', 'git token: timeout']) test(`AC-5, AC-6: token refusal ${reason} degrades only that repository`, async () => {
  const c = await setup(); const acquire = c.provider.acquireRepo;
  c.provider.acquireRepo = async (...args) => args[1].repoId === 'r1' ? { ok: false, reason } : acquire(...args);
  c.start(); await c.opened();
  expect(c.refreshed.map((r) => r.repo.repoId)).toEqual(['r2']);
  expect((await c.tool('list_repos')).content).toBe(`acme/app2 @ aaaaaaa\nacme/app1 unavailable (token: ${reason})`);
});

test('AC-7, AC-8: all fetch failures still start; assignment failures follow local failures', async () => {
  const c = await setup({ unavailable: [{ owner: 'acme', name: 'other', reason: 'no installation' }] });
  c.host.refreshMirror = async () => ({ ok: false, reason: 'fetch failed' }); c.start(); await c.opened();
  await waitFor(() => c.journal.getJob('j1', 1)?.state === 'RUNNING');
  expect((await c.tool('list_repos')).content).toBe('acme/app1 unavailable (fetch failed)\nacme/app2 unavailable (fetch failed)\nacme/other unavailable (no installation)');
});

for (const phase of ['acquire', 'fetch'] as const) for (const halt of [false, true]) test(`AC-9, AC-10, AC-11: ${halt ? 'halt' : 'cancel'} during ${phase} releases before ending`, async () => {
  const c = await setup(); const gate = deferred<void>(); let entered = 0; const cancelled: boolean[] = [];
  if (phase === 'acquire') c.provider.acquireRepo = async (_row, _repo, options) => { entered++; await gate.promise; cancelled.push(options.isCancelled?.() === true); return { ok: false, reason: 'cancelled', cancelled: true }; };
  else c.host.refreshMirror = async () => { entered++; await gate.promise; return { ok: true, sha }; };
  const start = c.start(); await Bun.sleep(30); const observed = entered;
  if (halt) c.run.halt(); else c.cancel();
  expect(c.released).toEqual([]); gate.resolve(); await start;
  expect(observed).toBe(2); if (phase === 'acquire') expect(cancelled).toEqual([true, true]); expect(c.released.sort()).toEqual(['r1', 'r2']); expect(c.opens).toEqual([]);
  const row = c.journal.getJob('j1', 1);
  expect(row?.state).toBe(halt ? 'ASSIGNED' : 'CANCELLED');
  if (!halt) expect(c.journal.pendingEvents('j1', 1, 100).at(-1)?.payload).toMatchObject({ reason: 'cancelled before start' });
  else expect(c.journal.pendingEvents('j1', 1, 100)).toEqual([]);
});

for (const mode of ['absent', 'noCredentials'] as const) test(`AC-12: ${mode} preserves skill-only session`, async () => {
  const c = await setup({ [mode]: true }); c.start(); await c.opened();
  expect(c.opens[0]?.tools?.map((t) => t.name)).toEqual(['load_skill', 'read_skill_file']); expect(c.acquired).toEqual([]);
});

test('AC-13: five repositories refresh at most three at a time', async () => {
  const c = await setup({ repos: Array.from({ length: 5 }, (_, n) => ({ ...firstRepo, repoId: `r${n}`, name: `app${n}` })) });
  const gate = deferred<void>(); let active = 0; let peak = 0; let total = 0;
  c.host.refreshMirror = async () => { total++; active++; peak = Math.max(peak, active); await gate.promise; active--; return { ok: true, sha }; };
  c.start(); await Bun.sleep(30); const firstWave = total; gate.resolve(); await c.opened();
  expect(firstWave).toBe(3); expect(peak).toBe(3); expect(total).toBe(5);
});

test('fetch timeout and configured timeout reach tools and mirror respectively', async () => {
  const c = await setup({ timeout: 42 }); c.host.refreshMirror = async (input) => { c.refreshed.push(input); return { ok: false, reason: 'fetch timeout' }; };
  c.start(); await c.opened(); expect(c.refreshed.every((r) => r.timeoutMs === 42)).toBe(true);
  expect((await c.tool('list_repos')).content).toContain('unavailable (fetch timeout)');
});

test('AC-15: real mirror pins origin tip and reads its file through session tools', async () => {
  const c = await setup({ repos: [firstRepo] }); const origin = await makeOrigin(c.root, 'origin', { files: { 'README.md': 'origin content\n' } });
  // Build a second context with the origin URL in its assignment.
  const real = await setup({ repos: [{ ...firstRepo, cloneUrl: origin.url }] });
  real.host.refreshMirror = (input) => refreshMirror({ ...input, allowFileProtocol: true });
  real.start(); await real.opened(); const tip = await git(origin.dir, 'rev-parse', 'main');
  expect((await real.tool('list_repos')).content).toBe(`acme/app1 @ ${tip.slice(0, 7)}`);
  expect((await real.tool('read_file', { repo: 'acme/app1', path: 'README.md' })).content).toContain('origin content');
});
