// From the repo root: node docs/review-evidence/20261128/runner-api.cjs
// Use current API TypeScript with legacy Nest decorators. No database or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, path) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true,
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, path);
};
const api = path => require('../../../apps/api/src/fleet/' + path);
const { FleetSweeper } = api('sync/fleet-sweeper');
const { JobTransitionsService } = api('jobs/job-transitions.service');
const { FenceService } = api('sync/fence.service');
const { CommandAckProcessor } = api('sync/command-ack.processor');
const { JobReportProcessor } = api('sync/job-report.processor');
const { PrismaChatThreadRepository } = api('threads/prisma-chat-thread.repository');
const { PrismaFleetJobRepository } = api('jobs/prisma-fleet-job.repository');
const tx = { run: fn => fn() };
const records = { record: async () => {} };
const now = new Date('2026-11-09T00:00:00Z');

async function journalOutage(sweep, retainReport) {
  let job = { id: 'job', projectId: 'project', state: 'UPLOADING', command: 'RUN', leaseEpoch: 1,
    runnerId: 'runner', costSpentUsd: '0', ackedRunnerSeq: 2 };
  const events = [];
  const commands = [];
  const repo = {
    lockById: async () => job,
    update: async (_, { bumpEpoch, ...patch }) => (job = { ...job, ...patch, leaseEpoch: job.leaseEpoch + Number(!!bumpEpoch) }),
    appendEvent: async (_, event) => events.push(event),
    withdrawPendingCommands: async () => 0,
    findRunnerEvents: async () => [],
    findRunnerEventsAfter: async (_, epoch, seq) => events.filter(e => e.leaseEpoch === epoch && e.runnerSeq > seq),
    findSilentHeldIds: async () => ['job'],
    findPlacementRunners: async () => [{ lastSeenAt: new Date('2026-11-01T00:00:00Z') }],
    findPendingCommand: async () => null,
    createCommand: async c => commands.push(c),
    findCommand: async () => ({ id: 'readopt', jobId: 'job', runnerId: 'runner', type: 'READOPT', leaseEpoch: 1, ackedAt: null }),
    ackCommand: async () => true,
  };
  const live = { event: job => ({ jobId: job.id }), publish: () => {} };
  const transitions = new JobTransitionsService(repo, records, live, {}, {}, { onTerminal: async () => {} });
  const fence = new FenceService(repo, records);
  if (sweep) {
    const sweeper = new FleetSweeper(repo, transitions, live, tx, { jobCrashSec: 300 }, { attribute: async () => {} }, { onTerminal: async () => {} }, records);
    assert.equal(await sweeper.sweep(now), 1);
  }
  if (retainReport) {
    const reports = new JobReportProcessor(repo, transitions, live, fence, records, {}, {}, tx, records);
    await reports.process('runner', { jobId: 'job', leaseEpoch: 1, events: [{ seq: 3, type: 'state', payload: { to: 'COMPLETED' } }] }, now);
  } else if (!sweep) {
    const processor = new CommandAckProcessor(repo, transitions, fence, records, {}, tx, records);
    await processor.process('runner', 'new-boot', [{ commandId: 'readopt', result: 'rejected', detail: 'unknown job', leaseEpoch: 1 }], now);
  }
  assert.equal(job.state, !sweep && retainReport ? 'COMPLETED' : 'CRASHED');
  assert.equal(commands.length, sweep && retainReport ? 1 : 0);
  console.log('outage', { sweep, retainReport, state: job.state, epoch: job.leaseEpoch, reason: job.stateReason, fenced: commands.length });
}

async function closeAndRetry() {
  let command;
  const job = { id: 'job', projectId: 'project', state: 'RUNNING', runnerId: 'runner', leaseEpoch: 1 };
  const thread = { id: 'thread', createdById: 'user', projectId: 'project', kind: 'REPO', costUsd: '0', maxCostUsd: '1', status: 'ACTIVE' };
  const matches = (row, where) => row && Object.entries(where).every(([key, value]) => row[key] === value);
  const client = {
    chatThread: { findFirst: async () => thread }, fleetJob: { findFirst: async () => job },
    fleetThreadTurn: { findUnique: async () => ({ action: 'SESSION' }) },
    chatMessage: { findFirst: async () => null }, $queryRaw: async () => [],
    fleetCommand: {
      findFirst: async ({ where }) => matches(command, where) ? command : null,
      updateMany: async ({ where, data }) => {
        if (!matches(command, where)) return { count: 0 };
        Object.assign(command, data);
        return { count: 1 };
      },
    },
  };
  const jobs = {
    lockById: async () => job, findCommand: async () => command,
    createCommand: async input => { command = { ...input, id: 'close', ackedAt: null, ackResult: null }; },
    ackCommand: (...args) => PrismaFleetJobRepository.prototype.ackCommand.call({ db: client }, ...args),
  };
  const threads = new PrismaChatThreadRepository({ client }, jobs, tx, records, {}, { notify: () => {} },
    { snapshot: async () => ({ match: () => null }) }, { threadsEnabled: true }, records, {});
  const send = () => threads.sendRefusalFor(thread, job).then(r => r.refusal);
  assert.equal(await send(), null);
  const close = () => threads.command({ kind: 'project', projectId: 'project' }, 'thread', 'user', 'THREAD_CLOSE', {});
  await close();
  const ack = new CommandAckProcessor(jobs, {}, new FenceService(jobs, records), records, {}, tx, records);
  await ack.process('runner', 'boot', [{ commandId: 'close', result: 'rejected', detail: 'session_not_ready', leaseEpoch: 1 }], now);
  assert.equal(command.ackResult, 'rejected');
  assert.equal(command.ackedAt, now);
  assert.equal(await send(), 'closing');
  await assert.rejects(close(), e => e.getStatus() === 409);
  console.log('thread', { ackResult: command.ackResult, job: job.state, send: await send(), retryStatus: 409 });
  job.leaseEpoch++;
  assert.equal(await send(), null);
  console.log('fresh thread lease', { epoch: job.leaseEpoch, send: await send() });
}

(async () => {
  for (const sweep of [true, false]) for (const retain of [true, false]) await journalOutage(sweep, retain);
  await closeAndRetry();
})().catch(error => { console.error(error); process.exitCode = 1; });
