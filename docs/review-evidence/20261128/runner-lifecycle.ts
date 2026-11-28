// From the repo root: bun docs/review-evidence/20261128/runner-lifecycle.ts
// All rows and process operations are simulated in memory.
import assert from 'node:assert/strict';
import { Journal } from '../../../apps/runner/src/journal/journal';
import { reapPreviousBootProcesses } from '../../../apps/runner/src/daemon/owned-processes';
import { createMemoryLogger } from '../../../apps/runner/src/logger';
import { ThreadJobRun } from '../../../apps/runner/src/thread/thread-job-run';
import { assignFor } from '../../../apps/runner/test/helpers/assign';

const log = createMemoryLogger();
const day = 86_400_000;
for (const age of [6, 8]) {
  let now = 0;
  const journal = Journal.open(':memory:', () => new Date(now));
  journal.insertJob({ assign: assignFor('RUN', { jobId: 'run' }), leaseEpoch: 1, repoKey: 'demo/repo', jobDir: '/unused' });
  for (const to of ['RUNNING', 'UPLOADING', 'COMPLETED'] as const) {
    journal.appendEvent('run', 1, 'state', { to }, { state: to });
  }
  journal.ackThrough('run', 1, 2);
  journal.markDone('run', 1);
  now = age * day;
  const before = journal.pendingEvents('run', 1, 10).length;
  const pruned = journal.prune(7).length;
  const after = journal.pendingEvents('run', 1, 10).length;
  assert.deepEqual([before, pruned, after], age === 6 ? [1, 0, 1] : [1, 1, 0]);
  console.log('prune', { age, before, pruned, after });
  journal.close();
}

for (const scenario of ['matching', 'later-process', 'lookup-error', 'signal-error']) {
  const journal = Journal.open(':memory:');
  journal.recordOwnedProcess({ pid: 12345, group: true, bootId: 'old', hostBoot: 'same', spawnedAtMs: 10_000, source: 'native' });
  const calls: number[] = [];
  const deps = {
    journal, log, bootId: 'new', hostBoot: 'same', selfPid: 999,
    startedAt: async () => {
      if (scenario === 'lookup-error') throw Error('temporary lookup error');
      return new Date(scenario === 'later-process' ? 70_000 : 10_000);
    },
    kill: (target: number) => {
      calls.push(target);
      if (scenario === 'signal-error') throw Object.assign(Error('permission denied'), { code: 'EPERM' });
    },
  };
  const killed = await reapPreviousBootProcesses(deps);
  const remaining = journal.ownedProcessesOutside('new').length;
  const retry = await reapPreviousBootProcesses({ ...deps, startedAt: async () => new Date(10_000), kill: target => calls.push(target) });
  assert.equal(killed.length, scenario === 'matching' ? 1 : 0);
  assert.equal(remaining, 0);
  assert.equal(retry.length, 0);
  console.log('reaper', { scenario, attempts: calls.length, signalled: killed.length, remaining, retry: retry.length });
  journal.close();
}

// Construct exactly the state between the RUNNING transition and openStream's writer assignment.
const journal = Journal.open(':memory:');
journal.insertJob({ assign: assignFor('THREAD', { jobId: 'session' }), leaseEpoch: 1, repoKey: 'demo/repo', jobDir: '/unused' });
journal.updateJob('session', 1, { state: 'RUNNING' });
const run = new ThreadJobRun({ journal, log } as ConstructorParameters<typeof ThreadJobRun>[0], 'session', 1);
const close = run.command('THREAD_CLOSE', {});
assert.deepEqual(close, { result: 'rejected', detail: 'session_not_ready' });
assert.equal(journal.getJob('session', 1)?.state, 'RUNNING');
console.log('close during startup', close);
journal.close();
