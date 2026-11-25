// Run from the repository root: bun docs/review-evidence/20261125/runner-lifecycle.ts
// Uses disposable runner state and controlled collaborators. No remote calls or job execution.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession, createFileTranscriptStore, NO_OP_INTERACTION_HANDLER, resumeAgentSession, type SessionBackend,
} from '../../../apps/runner/node_modules/@nathapp/nax-agent/dist/index.js';
import type { ThreadAssign } from '../../../packages/fleet-protocol/src';
import { Journal } from '../../../apps/runner/src/journal/journal';
import { createMemoryLogger } from '../../../apps/runner/src/logger';
import { CommandHandler } from '../../../apps/runner/src/supervisor/command-handler';
import { RepoMutex } from '../../../apps/runner/src/supervisor/repo-mutex';
import { Supervisor } from '../../../apps/runner/src/supervisor/supervisor';
import { ThreadJobRun } from '../../../apps/runner/src/thread/thread-job-run';
import { ThreadSessionFactory } from '../../../apps/runner/src/thread/session-factory';
import { assignFor } from '../../../apps/runner/test/helpers/assign';
import { FakeExecutor } from '../../../apps/runner/test/helpers/fake-executor';
import { FakeLogShipping, NO_LOG_SHIPPING } from '../../../apps/runner/test/helpers/fake-log-shipping';
import { manualClock } from '../../../apps/runner/test/helpers/manual-clock';

const log = createMemoryLogger();
const epoch = 1;
const workspaceRoot = '/unused-runner-fixture';
const source = () => new Date();
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const terminal = (journal: Journal, jobId: string) =>
  journal.pendingEvents(jobId, epoch, 100).filter((event) => event.type === 'state').map((event) => event.payload);

async function awaitGate<T>(event: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error('timed out waiting for fixture gate')), 3_000);
  try {
    return await Promise.race([event, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancelDuringDrain(): Promise<void> {
  const journal = Journal.open(':memory:');
  const executor = new FakeExecutor();
  executor.aliveAfterSpawn = false;
  const judged = Promise.withResolvers<void>();
  const readLedger = executor.readFinishLedger.bind(executor);
  executor.readFinishLedger = async (job) => {
    // A successful RUN has already been judged before it reads the finish ledger.
    const result = await readLedger(job);
    judged.resolve();
    return result;
  };
  const logs = new FakeLogShipping();
  logs.holdDrain();
  const supervisor = new Supervisor({
    journal, executor, mutex: new RepoMutex(), log, now: source, sleep: nextTick, logs,
    tuning: { statusPollMs: 1, killGraceMs: 10, ackPollMs: 1, uploadAckWaitMs: 0, logDrainTimeoutMs: 100 },
    readoptHeartbeatMs: 100, configEdits: { fetch: async () => { throw new Error('unused'); } },
    uploader: { upload: async () => ({ kind: 'ok' }) },
  });
  const handler = new CommandHandler({
    journal, supervisor, workspaceRoot, log, now: source,
    approvals: { answer: async () => { throw new Error('unused'); } },
  });
  const jobId = 'cancel-during-drain';
  try {
    await handler.handle([{ commandId: 'assign', type: 'ASSIGN', jobId, leaseEpoch: epoch, payload: assignFor('RUN', { jobId }) }]);
    await awaitGate(judged.promise);
    assert.ok(logs.calls.includes(`logs.drain:${jobId}`));
    assert.equal(journal.getJob(jobId, epoch)?.state, 'RUNNING');
    const cancel = { commandId: 'cancel', type: 'CANCEL', jobId, leaseEpoch: epoch, payload: {} } as const;
    const [ack] = await handler.handle([cancel]);
    assert.equal(ack?.result, 'ok');
    const accepted = journal.getJob(jobId, epoch);
    assert.ok(accepted?.cancelRequestedAt);
    assert.equal(accepted.state, 'RUNNING');
    logs.releaseDrain();
    await awaitGate(supervisor.idle());
    const final = journal.getJob(jobId, epoch);
    assert.equal(final?.state, 'COMPLETED');
    assert.equal((await handler.handle([cancel]))[0]?.result, 'ok');
    console.log(JSON.stringify({
      finding: 8, ack: ack.result, stateWhenAccepted: accepted.state, cancellationRecorded: true,
      finalState: final.state, events: terminal(journal, jobId),
    }));
  } finally {
    supervisor.shutdown();
    await supervisor.idle();
    journal.close();
  }
}

async function closeDuringTranscriptWrite(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'koda-thread-review-'));
  const journal = Journal.open(':memory:');
  const endedWrite = Promise.withResolvers<void>();
  const releaseEndWrite = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let closeCalls = 0;
  let backendReturned = false;
  let configuredTurnTimeout: unknown;
  const sessionBackend: SessionBackend = {
    kind: 'native',
    async open() {
      return {
        handle: { id: 'mock-backend-session', agentName: 'review' },
        info: { kind: 'native', capabilities: {} },
        adapter: {
          async openSession() { throw new Error('unused'); },
          async sendTurn(_handle, _prompt, options) {
            options.signal?.addEventListener('abort', () => cancelled.resolve(), { once: true });
            backendReturned = true;
            return { output: 'ok', estimatedCostUsd: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 1 };
          },
          async closeSession() {},
        },
        turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
        async close() {},
      };
    },
  };
  const sessions = new ThreadSessionFactory({
    homeDir: root, naxHome: root,
    nativeModels: async () => ({ defaultModel: 'review/test-model', models: ['review/test-model'] }),
    agent: {
      async createAgentSession(options) {
        configuredTurnTimeout = options.turnTimeoutSeconds;
        const session = await createAgentSession(options);
        const close = session.close.bind(session);
        session.close = () => { closeCalls += 1; return close(); };
        return session;
      },
      resumeAgentSession,
      nativeBackend: () => sessionBackend,
      createFileTranscriptStore(directory) {
        const store = createFileTranscriptStore(directory);
        const markTurn = store.markTurn.bind(store);
        return {
          ...store,
          async markTurn(sessionId, marker) {
            if (marker.state === 'ended') {
              endedWrite.resolve();
              await releaseEndWrite.promise;
            }
            await markTurn(sessionId, marker);
          },
        };
      },
    },
  });
  const clock = manualClock(Date.parse('2026-11-25T00:00:00.000Z'));
  const jobId = 'close-during-transcript-write';
  const thread: ThreadAssign = {
    threadId: 'review-thread', kind: 'WORKSPACE', action: 'SESSION', feature: 'review', resume: false,
    instructions: 'Review fixture', backend: { kind: 'native', model: 'review/test-model' },
    skills: [], initialMessage: { messageId: 'review-message', text: 'Review fixture' },
  };
  const jobDir = join(root, 'job');
  journal.insertJob({ assign: assignFor('THREAD', { jobId, thread }), leaseEpoch: epoch, repoKey: 'unused/review', jobDir });
  const closeBudget = 50;
  const run = new ThreadJobRun({
    journal, log, now: () => new Date(clock.nowMs()), sleep: clock.sleep,
    mutex: new RepoMutex(), logs: NO_LOG_SHIPPING,
    tuning: {
      threadIdleMs: 1_000, threadHeartbeatMs: 10, threadWakeGapMs: 0, threadSearchTimeoutMs: 10,
      threadSkillFetchTimeoutMs: 10, logDrainTimeoutMs: 10, threadCloseTimeoutMs: closeBudget,
      threadRunningAckPollMs: 1, threadRunningAckWaitMs: 0,
    },
    host: {
      sessions, homeDir: root, workspaceRoot: root,
      credentials: { acquire: async () => { throw new Error('unused'); }, async release() {} },
      git: { run: async () => { throw new Error('unused'); }, ok: async () => { throw new Error('unused'); } },
    },
  }, jobId, epoch);
  const started = run.start('prepare');
  try {
    await awaitGate(endedWrite.promise);
    assert.equal(backendReturned, true);
    assert.equal(configuredTurnTimeout, 900);
    assert.equal(run.command('THREAD_CLOSE', {}).result, 'ok');
    await awaitGate(cancelled.promise);
    clock.advance(closeBudget * 4);
    await nextTick();
    const blocked = journal.getJob(jobId, epoch);
    assert.ok(blocked);
    assert.equal(blocked.state, 'RUNNING');
    assert.equal(blocked.doneAt, null);
    assert.equal(closeCalls, 0);
    assert.ok(journal.pendingEvents(jobId, epoch, 100).some((event) => event.type === 'snapshot'));
    releaseEndWrite.resolve();
    await awaitGate(started);
    const final = journal.getJob(jobId, epoch);
    assert.equal(final?.state, 'COMPLETED');
    assert.equal(closeCalls, 1);
    console.log(JSON.stringify({
      finding: 9, realNaxAgentFacade: true, adapterReturned: backendReturned, cancelSignalAborted: true,
      productionTurnTimeoutSeconds: configuredTurnTimeout, elapsedCloseBudgets: 4, stateWhileWriteHeld: blocked.state,
      sessionCloseInvokedWhileWriteHeld: false, heartbeatPersisted: true, finalStateAfterRelease: final.state,
    }));
  } finally {
    releaseEndWrite.resolve();
    run.halt();
    await started;
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

await cancelDuringDrain();
await closeDuringTranscriptWrite();
