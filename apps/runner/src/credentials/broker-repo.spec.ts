import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assignFor } from '../../test/helpers/assign';
import { makeTempDirs } from '../../test/helpers/tmp';
import { Journal } from '../journal/journal';
import { CredentialBroker } from './broker';
import { CredentialServer, type CredentialReply } from './cred-server';
import { runGitCred } from './git-credential';
import { helperValue } from './job-files';
import { socketPathFor } from './socket-dir';
import { TokenCache } from './token-cache';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

// Transport-only substitute: exercises the broker's real reply and the git helper's
// real host/protocol filtering when this sandbox forbids Unix-domain socket binds.
test('project code broker transport seam: AC-11, AC-12, AC-13 and epoch isolation', async () => {
  const base = await tmp.make('br');
  const socketDir = join(base, 's');
  await mkdir(socketDir, { mode: 0o700 });
  const replies = new Map<string, () => Promise<CredentialReply>>();
  const closed = new Set<string>();
  const listen = spyOn(CredentialServer, 'listen').mockImplementation(async (path, reply) => {
    replies.set(path, reply);
    closed.delete(path);
    return { path, close: async () => { closed.add(path); } } as CredentialServer;
  });
  const journal = Journal.open(':memory:');
  const tokens = new TokenCache({ refreshMarginMs: 100, cooldownMs: 10 });
  const broker = new CredentialBroker({ tokens, socketDir, runnerId: 'run', selfCommand: ['runner'],
    nowMs: Date.now, sleep: Bun.sleep, timing: { waitMs: 100, serveWaitMs: 100, pollMs: 1 } });
  const job = (leaseEpoch: number) => journal.insertJob({ assign: assignFor('THREAD'), leaseEpoch,
    repoKey: 'o/n', jobDir: join(base, 'job') }).row;
  const one = job(1);
  const two = job(2);
  const repo = (repoId: string) => ({ repoId, cloneUrl: 'https://github.com/o/n.git' });
  const grant = (repoId: string, leaseEpoch = 1) => tokens.apply([{ jobId: one.jobId, leaseEpoch, repoId }],
    [{ jobId: one.jobId, repoId, username: 'x-access-token', token: `${repoId}-${leaseEpoch}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }], [], Date.now());
  const sock = (repoId: string, epoch = 1) => socketPathFor(socketDir, 'run', one.jobId, epoch, repoId);
  const request = async (path: string): Promise<CredentialReply> => {
    const reply = replies.get(path);
    return !reply || closed.has(path) ? { ok: false, reason: 'unavailable' } : reply();
  };
  const get = async (path: string, host = 'github.com', protocol = 'https') => {
    let out = '';
    await runGitCred([path, 'get'], { readStdin: async () => `protocol=${protocol}\nhost=${host}\n\n`,
      request, write: (text) => { out += text; } });
    return out;
  };
  try {
    const waiting = broker.acquireRepo(one, repo('r1'), { wait: true });
    setTimeout(() => grant('r1'), 5);
    expect(await waiting).toEqual({ ok: true, credentials: { helper: helperValue(['runner'], sock('r1')), binDir: null } });
    expect(await get(sock('r1'))).toContain('password=r1-1');
    expect(await get(sock('r1'), 'gitlab.com')).toBe('');
    expect(await get(sock('r1'), 'github.com', 'http')).toBe('');
    await expect(stat(join(one.jobDir, 'bin'))).rejects.toThrow();
    for (const [row, id] of [[one, 'r2'], [two, 'r1']] as const) {
      const pending = broker.acquireRepo(row, repo(id), { wait: true });
      grant(id, row.leaseEpoch);
      expect((await pending).ok).toBe(true);
    }
    await broker.releaseRepo(one, 'r1');
    expect(tokens.wanted(one.jobId, 1, 'r1')).toBe(false);
    expect(await get(sock('r1'))).toBe('');
    expect(await get(sock('r2'))).toContain('password=r2-1');
    expect(await get(sock('r1', 2))).toContain('password=r1-2');
    // Reacquire r1 so release(job) must release two repository records.
    const pending = broker.acquireRepo(one, repo('r1'), { wait: true });
    grant('r1');
    await pending;
    await broker.release(one);
    for (const id of ['r1', 'r2']) {
      expect(tokens.wanted(one.jobId, 1, id)).toBe(false);
      expect(await get(sock(id))).toBe('');
    }
    expect(await get(sock('r1', 2))).toContain('password=r1-2');
  } finally {
    await broker.closeAll();
    listen.mockRestore();
    journal.close();
  }
});

test('project code broker transport seam: token errors, timeout, cancellation and shutdown', async () => {
  const base = await tmp.make('br');
  const socketDir = join(base, 's');
  await mkdir(socketDir, { mode: 0o700 });
  const listen = spyOn(CredentialServer, 'listen').mockImplementation(async (path) =>
    ({ path, close: async () => undefined }) as CredentialServer);
  const journal = Journal.open(':memory:');
  const row = journal.insertJob({ assign: assignFor('THREAD'), leaseEpoch: 1, repoKey: 'o/n', jobDir: join(base, 'job') }).row;
  let now = Date.now();
  const tokens = new TokenCache({ refreshMarginMs: 100, cooldownMs: 10 });
  const broker = new CredentialBroker({ tokens, socketDir, runnerId: 'run', selfCommand: ['runner'],
    nowMs: () => now, sleep: async (ms) => { now += ms; }, timing: { waitMs: 10, serveWaitMs: 10, pollMs: 1 } });
  const repo = (repoId: string) => ({ repoId, cloneUrl: 'https://github.com/o/n.git' });
  try {
    tokens.want(row.jobId, 1, 'refused');
    tokens.apply([{ jobId: row.jobId, leaseEpoch: 1, repoId: 'refused' }], [],
      [{ jobId: row.jobId, repoId: 'refused', reason: 'repo_not_assigned' }], now);
    expect(await broker.acquireRepo(row, repo('refused'), { wait: true })).toEqual({ ok: false, reason: 'git token: repo_not_assigned' });
    expect(await broker.acquireRepo(row, repo('timeout'), { wait: true })).toEqual({ ok: false, reason: 'git token: timeout' });
    expect(await broker.acquireRepo(row, repo('cancelled'), { wait: true, isCancelled: () => true })).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
    expect((await broker.acquireRepo(row, repo('no-wait'), { wait: false })).ok).toBe(true);
    await broker.closeAll();
    expect(await broker.acquireRepo(row, repo('shutdown'), { wait: true })).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
    await broker.release(row);
    expect(tokens.requests(now)).toEqual([]);
  } finally {
    await broker.closeAll();
    listen.mockRestore();
    journal.close();
  }
});
