// Run from the repository root: bun docs/review-evidence/20261125/runner-duplicate-daemon.ts
// Uses a disposable journal, two real daemons, injected HTTP, and an executor that launches inert children.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FleetCommandOut, SyncRequest, SyncResponse } from '../../../packages/fleet-protocol/src';
import { resolveHome, type RunnerConfig } from '../../../apps/runner/src/config/runner-config';
import { startDaemon } from '../../../apps/runner/src/daemon/daemon';
import { Journal } from '../../../apps/runner/src/journal/journal';
import { createMemoryLogger } from '../../../apps/runner/src/logger';
import { assignFor } from '../../../apps/runner/test/helpers/assign';
import { FakeExecutor } from '../../../apps/runner/test/helpers/fake-executor';

const jobId = 'runner-review-job';
const runnerId = 'runner-review-host';
const leaseEpoch = 1;
const assign: FleetCommandOut = {
  commandId: 'runner-review-assign', type: 'ASSIGN', jobId, leaseEpoch,
  payload: assignFor('RUN', { jobId }),
};

async function waitForFile(path: string, signal?: AbortSignal): Promise<void> {
  const end = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (signal?.aborted) throw signal.reason;
    assert.ok(Date.now() < end, `timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

async function worker(root: string, name: string): Promise<void> {
  const home = resolveHome({}, join(root, 'home'));
  const config: RunnerConfig = {
    serverUrl: 'https://runner-review.invalid', allowInsecureHttp: false, labels: [],
    naxCommand: ['unused-nax'], naxHome: join(root, 'nax'),
    workspaceRoot: join(root, 'work'), jobRetentionDays: 1, socketDir: join(root, 's'),
    capabilities: {
      nax: { version: '0.92.15', protocols: ['native'] },
      sandbox: { available: true }, profiles: {}, credentials: [],
      tools: { git: true, gh: false, glab: false }, executors: ['host'],
    },
  };
  const reply = (data: unknown) => Response.json({ ret: 0, data });
  let delivered = false;
  const daemon = await startDaemon({
    config, home, bootId: `boot-${name}`,
    identity: { runnerId, apiKey: 'synthetic', serverUrl: config.serverUrl, name: 'review', enrolledAt: new Date(0).toISOString() },
    log: createMemoryLogger(),
    selfCommand: [process.execPath, '--help'],
    configureCredentials() {},
    tuning: { syncMinGapMs: 15, statusPollMs: 20 },
    async fetchFn(url, init) {
      if (url.endsWith('/me')) return reply({ id: runnerId, capacity: 2 });
      assert.ok(url.endsWith('/sync'), `unexpected fixture request ${url}`);
      const body: SyncRequest = JSON.parse(String(init?.body));
      const response: SyncResponse = { jobAcks: [], commands: [], gitTokens: [], gitTokenErrors: [], unknownJobIds: [] };
      if (!delivered) {
        delivered = true;
        assert.equal(body.bootId, `boot-${name}`);
        response.commands.push(assign);
        if (name === 'B') await Bun.write(join(root, 'redelivered'), String(process.pid));
      }
      const acknowledgesAssign = body.commandAcks.some((ack) => ack.commandId === assign.commandId && ack.result === 'ok');
      if (name === 'A' && acknowledgesAssign) {
        await Bun.write(join(root, 'A-ack-in-flight'), String(process.pid));
        // Keep the first ack unprocessed until B receives the still-pending command.
        await waitForFile(join(root, 'redelivered'), init?.signal ?? undefined);
      }
      response.jobAcks = body.jobs.map((job) => ({ jobId: job.jobId, ackedSeq: job.events.at(-1)!.seq }));
      return reply(response);
    },
    executorFactory() {
      const executor = new FakeExecutor();
      executor.prepare = async (row) => {
        assert.equal(row.jobId, jobId);
        await Bun.write(join(root, `prepared-${name}`), '');
        await waitForFile(join(root, 'spawn'));
        return { ok: true, branch: 'feat/review' };
      };
      executor.spawn = async (row) => {
        assert.equal(row.leaseEpoch, leaseEpoch);
        const child = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'inherit' });
        assert.equal(await child.exited, 0);
        await Bun.write(join(root, `spawned-${name}`), JSON.stringify({ daemonPid: process.pid, childPid: child.pid }));
        await waitForFile(join(root, `finish-${name}`));
        return { pid: child.pid, pgid: child.pid };
      };
      executor.isAlive = () => true;
      return executor;
    },
  });
  try {
    await waitForFile(join(root, `stop-${name}`));
  } finally {
    const stopping = daemon.stop();
    await Bun.write(join(root, `finish-${name}`), '');
    await stopping;
  }
}

async function runProof(): Promise<void> {
  const root = await mkdtemp('/tmp/koda-runner-review-');
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const start = (name: string) => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--worker', root, name], { stdout: 'inherit', stderr: 'inherit' });
    children.push(child);
    return child;
  };
  try {
    await mkdir(join(root, 'nax'));
    const first = start('A');
    await Promise.all(['A-ack-in-flight', 'prepared-A'].map((file) => waitForFile(join(root, file))));
    const home = resolveHome({}, join(root, 'home'));
    const journal = Journal.openReadOnly(home.journalPath);
    const readRow = () => journal.getJob(jobId, leaseEpoch);
    try {
      assert.equal(readRow()?.pid, null);
      const second = start('B');
      await Promise.all(['A', 'B'].map((name) => waitForFile(join(root, `prepared-${name}`))));
      assert.equal(readRow()?.state, 'ASSIGNED');
      assert.equal(readRow()?.pid, null);
      await Bun.write(join(root, 'spawn'), '');
      await Promise.all(['A', 'B'].map((name) => waitForFile(join(root, `spawned-${name}`))));
      const a = await Bun.file(join(root, 'spawned-A')).json();
      const b = await Bun.file(join(root, 'spawned-B')).json();
      assert.equal(a.daemonPid, first.pid);
      assert.equal(b.daemonPid, second.pid);
      assert.notEqual(a.daemonPid, b.daemonPid);
      assert.notEqual(a.childPid, b.childPid);
      assert.equal(readRow()?.pid, null);
      console.log(JSON.stringify({
        finding: 1, sharedJournal: true, sameJobId: jobId, sameEpoch: leaseEpoch,
        executor: 'inert fixture', launches: [a, b],
      }));
    } finally {
      journal.close();
    }
  } finally {
    for (const name of ['A', 'B']) await Bun.write(join(root, `stop-${name}`), '');
    await Promise.all(children.map(async (child) => {
      const exit = await Promise.race([child.exited, Bun.sleep(1_000).then(() => null)]);
      if (exit === null) {
        child.kill();
        await child.exited;
      }
    }));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') await worker(process.argv[3]!, process.argv[4]!);
else await runProof();
