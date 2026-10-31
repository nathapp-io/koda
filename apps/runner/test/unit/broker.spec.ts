import { isNaxSandboxed } from '../helpers/test-environment';
// apps/runner/test/unit/broker.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CredentialBroker, type BrokerTiming } from '../../src/credentials/broker';
import { requestCredential } from '../../src/credentials/git-credential';
import { helperValue } from '../../src/credentials/job-files';
import { socketPathFor } from '../../src/credentials/socket-dir';
import { TokenCache } from '../../src/credentials/token-cache';
import { Journal } from '../../src/journal/journal';
import type { JobRow } from '../../src/journal/types';
import { assignFor } from '../helpers/assign';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const SELF = ['/k/koda-runner'];
const FAST: BrokerTiming = { waitMs: 2_000, serveWaitMs: 2_000, pollMs: 5 };

async function world(timing: BrokerTiming = FAST) {
  const base = await tmp.make('br');
  const socketDir = join(base, 's');
  await mkdir(socketDir, { mode: 0o700 });
  const tokens = new TokenCache({ refreshMarginMs: 240_000, cooldownMs: 30_000 });
  const broker = new CredentialBroker({ tokens, socketDir, runnerId: 'r1', selfCommand: SELF, nowMs: () => Date.now(), sleep: (ms) => Bun.sleep(ms), timing });
  const journal = Journal.open(':memory:');
  const job = (cloneUrl = 'https://github.com/acme/app.git', leaseEpoch = 1, jobId = 'j1'): JobRow => {
    const repo = { provider: 'github' as const, owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl };
    return journal.insertJob({ assign: assignFor('RUN', { jobId, repo }), leaseEpoch, repoKey: 'acme/app', jobDir: join(base, '.jobs', jobId) }).row;
  };
  const grant = (row: JobRow, token = 'ghs_b') => tokens.apply(
    [{ jobId: row.jobId, leaseEpoch: row.leaseEpoch }],
    [{ jobId: row.jobId, token, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), username: 'x-access-token' }], [], Date.now(),
  );
  return { base, socketDir, tokens, broker, job, grant, sock: (row: JobRow) => socketPathFor(socketDir, 'r1', row.jobId, row.leaseEpoch) };
}

describe('CredentialBroker (design §3.1, D78-D83, D90)', () => {
  test('D83: a file: clone URL needs no token, socket, shims or helper', async () => {
    const w = await world();
    const row = w.job('file:///srv/acme/app.git');
    expect(await w.broker.acquire(row, { wait: true })).toEqual({ ok: true, credentials: { helper: null, binDir: null } });
    expect(w.tokens.requests(Date.now())).toEqual([]);
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('prepare waits for the first token, then gets the helper value and the shims; the socket answers for the clone host', async () => {
    const w = await world();
    const row = w.job();
    setTimeout(() => w.grant(row), 30);
    const result = await w.broker.acquire(row, { wait: true });
    expect(result).toEqual({ ok: true, credentials: { helper: helperValue(SELF, w.sock(row)), binDir: join(row.jobDir, 'bin') } });
    expect((await stat(join(row.jobDir, 'bin', 'gh'))).mode & 0o777).toBe(0o700);
    expect(await requestCredential(w.sock(row))).toMatchObject({ ok: true, token: 'ghs_b', username: 'x-access-token', protocol: 'https', host: 'github.com' });
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('D82: a token error while waiting fails with `git token: <reason>`', async () => {
    const w = await world();
    const row = w.job();
    setTimeout(() => w.tokens.apply([{ jobId: 'j1', leaseEpoch: 1 }], [], [{ jobId: 'j1', reason: 'app_not_installed' }], Date.now()), 30);
    expect(await w.broker.acquire(row, { wait: true })).toEqual({ ok: false, reason: 'git token: app_not_installed' });
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('D82: no token within the wait is `git token: timeout`', async () => {
    const w = await world({ ...FAST, waitMs: 50 });
    expect(await w.broker.acquire(w.job(), { wait: true })).toEqual({ ok: false, reason: 'git token: timeout' });
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('a cancel while waiting ends the wait as cancelled', async () => {
    const w = await world();
    expect(await w.broker.acquire(w.job(), { wait: true, isCancelled: () => true })).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('closeAll ends a prepare that is still waiting for its first token (daemon stop)', async () => {
    const w = await world({ ...FAST, waitMs: 60_000 });
    const waiting = w.broker.acquire(w.job(), { wait: true });
    setTimeout(() => { void w.broker.closeAll(); }, 30);
    expect(await waiting).toEqual({ ok: false, reason: 'cancelled', cancelled: true });
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('D79: without waiting, a socket request made before the token exists is answered once it arrives', async () => {
    const w = await world();
    const row = w.job('http://127.0.0.1:8080/acme/app.git');
    expect((await w.broker.acquire(row, { wait: false })).ok).toBe(true);
    const pending = requestCredential(w.sock(row));
    setTimeout(() => w.grant(row, 'ghs_late'), 30);
    expect(await pending).toMatchObject({ ok: true, token: 'ghs_late', protocol: 'http', host: '127.0.0.1:8080' });
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('D79: a request that waits past serveWaitMs is `no token`', async () => {
    const w = await world({ ...FAST, serveWaitMs: 40 });
    const row = w.job();
    await w.broker.acquire(row, { wait: false });
    expect(await requestCredential(w.sock(row))).toEqual({ ok: false, reason: 'no token' });
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('release closes the socket, forgets the token and removes the shims', async () => {
    const w = await world();
    const row = w.job();
    w.tokens.want('j1', 1);
    w.grant(row);
    await w.broker.acquire(row, { wait: true });
    await w.broker.release(row);
    expect(await requestCredential(w.sock(row))).toEqual({ ok: false, reason: 'unavailable' });
    expect(w.tokens.wanted('j1', 1)).toBe(false);
    await expect(stat(join(row.jobDir, 'bin'))).rejects.toThrow();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('D79: a job that no longer wants a token is answered `job ended` while its socket still lives', async () => {
    const w = await world();
    const row = w.job();
    w.tokens.want('j1', 1);
    w.grant(row);
    await w.broker.acquire(row, { wait: true });
    w.tokens.drop('j1', 1);   // what release() does before it closes the socket; an in-flight reply sees this
    expect(await requestCredential(w.sock(row))).toEqual({ ok: false, reason: 'job ended' });
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('Review focus 3: a stale socket file left by a dead daemon is replaced', async () => {
    const w = await world();
    const row = w.job();
    await writeFile(w.sock(row), 'stale');
    w.tokens.want('j1', 1);
    w.grant(row);
    expect((await w.broker.acquire(row, { wait: true })).ok).toBe(true);
    expect(await requestCredential(w.sock(row))).toMatchObject({ ok: true });
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('acquire twice is the same socket and does not fail', async () => {
    const w = await world();
    const row = w.job();
    w.tokens.want('j1', 1);
    w.grant(row);
    const [a, b] = await Promise.all([w.broker.acquire(row, { wait: true }), w.broker.acquire(row, { wait: true })]);
    expect(a).toEqual(b);
    expect(await requestCredential(w.sock(row))).toMatchObject({ ok: true });
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('D90: two epochs have two sockets; releasing the older leaves the newer serving, shims included', async () => {
    const w = await world();
    const one = w.job(undefined, 1);
    const two = w.job(undefined, 2);
    for (const row of [one, two]) {
      w.tokens.want(row.jobId, row.leaseEpoch);
      w.grant(row);
      await w.broker.acquire(row, { wait: true });
    }
    expect(w.sock(one)).not.toBe(w.sock(two));
    await w.broker.release(one);
    expect(await requestCredential(w.sock(one))).toEqual({ ok: false, reason: 'unavailable' });
    expect(await requestCredential(w.sock(two))).toMatchObject({ ok: true });
    await expect(stat(join(two.jobDir, 'bin', 'gh'))).resolves.toBeDefined();   // the shared shims stay for epoch 2
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('D109: the socket directory is checked again before every listen; opened up after start, it fails the job', async () => {
    const w = await world();
    await chmod(w.socketDir, 0o755);
    const row = w.job();
    expect(await w.broker.acquire(row, { wait: false })).toEqual({ ok: false, reason: 'git credentials: socket dir unsafe' });
    await chmod(w.socketDir, 0o700);
    expect((await w.broker.acquire(row, { wait: false })).ok).toBe(true);
    await w.broker.closeAll();
  });
  // The nax sandbox withholds real Unix socket binding.
  test.skipIf(isNaxSandboxed())('D90: closeAll closes every socket but keeps the tokens wanted (a restarted daemon readopts)', async () => {
    const w = await world();
    const row = w.job();
    w.tokens.want('j1', 1);
    w.grant(row);
    await w.broker.acquire(row, { wait: true });
    await w.broker.closeAll();
    expect(await requestCredential(w.sock(row))).toEqual({ ok: false, reason: 'unavailable' });
    expect(w.tokens.wanted('j1', 1)).toBe(true);
  });
});

test('project code AC-10: socket hashes preserve legacy names and separate repositories', () => {
  for (const repoId of [undefined, 'r1']) {
    const hash = createHash('sha256').update(`run:j1:1${repoId === undefined ? '' : `:${repoId}`}`).digest('hex').slice(0, 16);
    expect(socketPathFor('/tmp', 'run', 'j1', 1, repoId)).toBe(join('/tmp', `${hash}.sock`));
  }
});

function requiredHelper(helper: string | null | undefined): string {
  if (!helper) throw new Error('missing helper');
  return helper;
}

async function helperGet(helper: string, host = 'github.com', protocol = 'https'): Promise<string> {
  const proc = Bun.spawn(['sh', '-c', `${helper.slice(1)} get`], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  proc.stdin.write(`protocol=${protocol}\nhost=${host}\n\n`);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out;
}

async function repoWorld() {
  const w = await world();
  const broker = new CredentialBroker({ tokens: w.tokens, socketDir: w.socketDir, runnerId: 'r1',
    selfCommand: [process.execPath, join(import.meta.dir, '../../src/main.ts')],
    nowMs: Date.now, sleep: Bun.sleep, timing: FAST });
  const row = w.job();
  const acquire = (repoId: string) => broker.acquireRepo(row, { repoId, cloneUrl: 'https://github.com/o/n.git' }, { wait: true });
  const grant = (repoId: string) => w.tokens.apply([{ jobId: 'j1', leaseEpoch: 1, repoId }],
    [{ jobId: 'j1', repoId, token: `repo-${repoId}`, username: 'x-access-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }], [], Date.now());
  return { ...w, broker, row, acquire, grant };
}

// The nax sandbox withholds real Unix socket binding.

test.skipIf(isNaxSandboxed())('project code AC-11: repository helper serves the repository token without shims', async () => {
  const w = await repoWorld();
  try {
    const pending = w.acquire('r1');
    setTimeout(() => w.grant('r1'), 20);
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.credentials.binDir).toBeNull();
    expect(result.credentials.helper).toBeTruthy();
    expect(await helperGet(requiredHelper(result.credentials.helper))).toBe('username=x-access-token\npassword=repo-r1\n');
    await expect(stat(join(w.row.jobDir, 'bin'))).rejects.toThrow();
  } finally { await w.broker.closeAll(); }
});

// The nax sandbox withholds real Unix socket binding.

test.skipIf(isNaxSandboxed())('project code AC-12: repository helper refuses other hosts and protocols', async () => {
  const w = await repoWorld();
  try {
    w.tokens.want('j1', 1, 'r1'); w.grant('r1');
    const result = await w.acquire('r1');
    if (!result.ok) throw new Error(result.reason);
    expect(await helperGet(requiredHelper(result.credentials.helper), 'gitlab.com')).toBe('');
    expect(await helperGet(requiredHelper(result.credentials.helper), 'github.com', 'http')).toBe('');
  } finally { await w.broker.closeAll(); }
});

// The nax sandbox withholds real Unix socket binding.

test.skipIf(isNaxSandboxed())('project code AC-13: releaseRepo closes only its socket; release drops all repositories', async () => {
  const w = await repoWorld();
  try {
    const helpers: string[] = [];
    for (const id of ['r1', 'r2']) {
      w.tokens.want('j1', 1, id); w.grant(id);
      const result = await w.acquire(id);
      if (!result.ok) throw new Error(result.reason);
      helpers.push(requiredHelper(result.credentials.helper));
    }
    await w.broker.releaseRepo(w.row, 'r1');
    expect(w.tokens.wanted('j1', 1, 'r1')).toBe(false);
    expect(await helperGet(requiredHelper(helpers[0]))).toBe('');
    expect(await helperGet(requiredHelper(helpers[1]))).toContain('password=repo-r2');
    w.tokens.want('j1', 1, 'r1'); w.grant('r1'); await w.acquire('r1');
    await w.broker.release(w.row);
    for (const id of ['r1', 'r2']) expect(w.tokens.wanted('j1', 1, id)).toBe(false);
    for (const helper of helpers) expect(await helperGet(helper)).toBe('');
  } finally { await w.broker.closeAll(); }
});

describe('CredentialBroker.currentToken (US-006: the REVIEW token file)', () => {
  test('AC-4: returns the token the cache holds for the job id and lease epoch', async () => {
    const w = await world();
    const row = w.job();
    w.tokens.want(row.jobId, row.leaseEpoch);
    w.grant(row, 'tok-review-9');
    expect(w.broker.currentToken(row)).toBe('tok-review-9');
  });

  test('AC-5: returns null when the cache holds no token for the job', async () => {
    const w = await world();
    expect(w.broker.currentToken(w.job())).toBeNull();
  });

  test('returns null for a token cached under another lease epoch', async () => {
    const w = await world();
    const first = w.job(undefined, 1);
    w.tokens.want(first.jobId, 1);
    w.grant(first, 'tok-review-9');
    expect(w.broker.currentToken({ ...first, leaseEpoch: 2 })).toBeNull();
    expect(w.broker.currentToken(first)).toBe('tok-review-9');
  });

  test('returns null for an expired token and for a token error', async () => {
    const w = await world();
    const row = w.job();
    w.tokens.want(row.jobId, row.leaseEpoch);
    w.tokens.apply([{ jobId: row.jobId, leaseEpoch: 1 }],
      [{ jobId: row.jobId, token: 'tok-old', username: 'x-access-token', expiresAt: new Date(Date.now() - 60_000).toISOString() }], [], Date.now());
    expect(w.broker.currentToken(row)).toBeNull();
    w.tokens.apply([{ jobId: row.jobId, leaseEpoch: 1 }], [], [{ jobId: row.jobId, reason: 'app_not_installed' }], Date.now());
    expect(w.broker.currentToken(row)).toBeNull();
  });
});
