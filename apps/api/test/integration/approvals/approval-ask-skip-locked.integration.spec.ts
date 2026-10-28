/**
 * Permissions P3d-2 (US-001) — closing an ask must never wait on a request another transaction holds.
 *
 * The engine's decide and execute lock the `ApprovalRequest` row first and then run the command, which
 * locks the job (bash) or the budget policy (budget). Every fleet close path holds that job or policy
 * lock first and closes the request second, so a blocking close would put the two orders in a cycle.
 * `ApprovalAskService.close` therefore takes the row with `FOR UPDATE SKIP LOCKED` and answers null
 * when another transaction holds it: a held request is being decided or executed, and skipping the
 * close is the right outcome.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/approvals/approval-ask-skip-locked.integration.spec.ts
 */
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalAskService, type OpenAsk } from '../../../src/approvals/approval-ask.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import type { ApprovalRequestRecord } from '../../../src/approvals/domain/approval.domain';
import { PrismaApprovalRequestRepository } from '../../../src/approvals/prisma-approval-request.repository';
import { configurableTestCommand, installOverRegisteredCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const now = new Date('2026-11-06T09:00:00Z');
const askedInput = { jobId: 'j1' };
const ASK_KEY = 'fleet.job.shell.escalate';
/** AC-1's bound: a close that waits on the held row must fail the case instead of hanging the file. */
const CLOSE_DEADLINE_MS = 2000;

/** The bash ask the runner raises for a job, on behalf of the job's requester. */
const bashAsk = (): OpenAsk => ({
  key: ASK_KEY,
  projectId: 'p1',
  component: 'runner',
  onBehalfOf: { type: 'USER', id: 'u1' },
  origin: 'runner',
  input: askedInput,
  deadline: null,
});

/** Ends the holding transaction without changing anything, so its row lock is released uncommitted. */
class RollbackSignal extends Error {}

interface RowLock {
  /** Rolls the holding transaction back and waits for the database to release the row. */
  release(): Promise<void>;
}

/**
 * Holds `SELECT ... FOR UPDATE` on one `ApprovalRequest` row from a second connection until released.
 *
 * The holding transaction only reads, then rolls back on release: it stands in for a decide or an
 * execute that has taken the request and is about to run its command.
 */
async function holdRow(id: string): Promise<RowLock> {
  const holder = createTestPrismaClient();
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let acquired!: () => void;
  const holding = new Promise<void>((resolve) => { acquired = resolve; });

  const finished = holder.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${id} FOR UPDATE`;
    acquired();
    await released;
    throw new RollbackSignal();
  })
    .catch((error: unknown) => { if (!(error instanceof RollbackSignal)) throw error; })
    .finally(() => holder.$disconnect());

  await holding;

  return {
    async release(): Promise<void> {
      release();
      await finished;
    },
  };
}

(canRunDbTests() ? describe : describe.skip)('ApprovalAskService.close against a held request', () => {
  let app: NathApplication;
  let asks: ApprovalAskService;
  let requests: PrismaApprovalRequestRepository;
  let txManager: ITransactionManager;
  let db: ReturnType<typeof fixtureDb>;
  const shell = configurableTestCommand(ASK_KEY);

  const open = () =>
    withTestActor({ type: 'RUNNER', id: 'r1' }, () => txManager.run(() => asks.open(bashAsk(), now)));
  /** The ask joins the caller's transaction, as the fleet's job or policy lock holder opens it. */
  const opened = async (): Promise<ApprovalRequestRecord> => {
    const outcome = await open();
    if (outcome.status !== 'pending') throw new Error(`expected a pending outcome, got ${outcome.status}`);
    return outcome.request;
  };
  const close = (id: string) =>
    withTestActor({ type: 'RUNNER', id: 'r1' }, () => txManager.run(() => asks.close(id, { status: 'cancelled', reason: 'job_ended' }, now)));
  const storedStatus = async (id: string): Promise<string> =>
    (await db.approvalRequest.findUniqueOrThrow({ where: { id } })).status;

  /** AC-1's bound: rejects when `close` does not answer within the deadline. */
  const withDeadline = <T>(work: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`close did not answer within ${CLOSE_DEADLINE_MS} ms: it waited on the held request`)),
        CLOSE_DEADLINE_MS,
      );
    });
    return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    txManager = app.get(TRANSACTION_MANAGER, { strict: false });
    asks = app.get(ApprovalAskService, { strict: false });
    requests = app.get(PrismaApprovalRequestRepository, { strict: false });
    await db.project.create({ data: { id: 'p1', slug: 'skip-locked', key: 'SKL', name: 'Skip locked' } });
    // `ApprovalsModule` already registers the production bash command; a second registration for the
    // key is refused, so the spec's double is installed over it.
    installOverRegisteredCommand(app.get(ApprovalCommandRegistry, { strict: false }), shell.command);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    shell.reset();
    await db.outboxEvent.deleteMany({ where: { type: 'approval_request_changed' } });
    await db.approvalRequest.deleteMany();
  });

  it('AC-1: answers null at once while another transaction holds the request row', async () => {
    const request = await opened();
    const lock = await holdRow(request.id);
    const pending = close(request.id);
    let result: ApprovalRequestRecord | null;
    try {
      result = await withDeadline(pending);
    } finally {
      await lock.release();
    }

    expect(result).toBeNull();
    // The skipped close wrote nothing: the row keeps the status the holder rolled back from.
    expect(await storedStatus(request.id)).toBe('pending');
  });

  it('AC-2: the request is still pending once the holding transaction rolls back', async () => {
    const request = await opened();
    const lock = await holdRow(request.id);
    // The close is skipped while the row is held, exactly as a job-end close runs in production.
    expect(await withDeadline(close(request.id))).toBeNull();
    await lock.release();

    expect(await storedStatus(request.id)).toBe('pending');
  });

  it('AC-3: lockByIdSkipLocked answers an unlocked pending request inside a transaction', async () => {
    const request = await opened();

    const locked = await withTestActor({ type: 'SYSTEM', id: 'seed' }, () => txManager.run(() => requests.lockByIdSkipLocked(request.id)));

    expect(locked).toMatchObject({
      id: request.id,
      status: 'pending',
      permissionKey: ASK_KEY,
      projectId: 'p1',
      actor: { type: 'SYSTEM', id: 'runner' },
      onBehalfOf: { type: 'USER', id: 'u1' },
      input: askedInput,
    });
  });

  it('AC-4: lockByIdSkipLocked of a missing id answers null', async () => {
    expect(await withTestActor({ type: 'SYSTEM', id: 'seed' }, () => txManager.run(() => requests.lockByIdSkipLocked('missing'))))
      .toBeNull();
  });

  it('answers null for a row another transaction holds, and leaves it locked for that holder', async () => {
    const request = await opened();
    const lock = await holdRow(request.id);
    try {
      // The repository, not just the service: SKIP LOCKED is what makes the close answer at once.
      expect(await withTestActor({ type: 'SYSTEM', id: 'seed' }, () => txManager.run(() => requests.lockByIdSkipLocked(request.id))))
        .toBeNull();
    } finally {
      await lock.release();
    }
  });

  it('US-001 AC-9: a close skipped because the request is held records no status-change event', async () => {
    const request = await opened();
    const before = await db.outboxEvent.count({ where: { type: 'approval_request_changed' } });
    const lock = await holdRow(request.id);
    let result: ApprovalRequestRecord | null;
    try {
      result = await withDeadline(close(request.id));
    } finally {
      await lock.release();
    }

    expect(result).toBeNull();
    expect(await db.outboxEvent.count({ where: { type: 'approval_request_changed' } })).toBe(before);
    expect(await db.outboxEvent.count({
      where: { type: 'approval_request_changed', eventId: `${request.id}:cancelled` },
    })).toBe(0);
  });
});
