import { findThreadAction } from '../../helpers/assistant-request';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b US-003 (3-D12 / 3-R3) — the whole thread path over HTTP: `dev`'s REPO THREAD job proposes
 * `koda_add_comment` through the runner tool route, `dev` approves it through the project decide route, and the
 * comment exists on the ticket with the action `EXECUTED`.
 *
 * Nothing is stubbed: the proposal enters the real route (runner authentication, the lease fence, the executor, the
 * tool registry the module fills at boot and `AssistantActionService.propose`) and the decision enters the real
 * project route (the guard, the DTO pipe, the late-bound `AssistantActionPort` and `AssistantActionDecisions`), so
 * the approve re-check and the approved run are the ones the executor ships.
 *
 * The second test asks the two candidate reads apart: the proposal records `dev` as the action's actor, and the
 * thread is moved to the `viewer` — a member who may also comment — before the approve. A run that still read the
 * job's thread creator would author the comment as the viewer; `findUserActor(action.actorId)` authors it as `dev`.
 *
 * Acceptance setup: `FLEET_THREADS_ENABLED=true` and `FLEET_SWEEP_ENABLED=false` before boot, project `web` with
 * `dev` as its DEVELOPER and the thread creator.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-actor-approve.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaAssistantToolCallRepository } from '../../../src/fleet/assistant/prisma-assistant-tool-call.repository';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor } from '../../helpers/thread-fixtures';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const integration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const TOOL = 'koda_add_comment';
const BODY = 'from the runner thread';
const ENV = ['FLEET_THREADS_ENABLED', 'FLEET_SWEEP_ENABLED'] as const;

integration('an approved thread action runs as its actor (PG, US-003)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  /** The exact repository instance the executor holds (`useExisting` in `AssistantModule`). */
  let calls: PrismaAssistantToolCallRepository;
  let seq = 0;
  let ticketSeq = 0;
  const saved: Record<string, string | undefined> = {};

  const commentsOf = (ticketId: string) => db.comment.findMany({ where: { ticketId } });
  const actionRow = (id: string) => findThreadAction(db, { requestId: id });

  beforeAll(async () => {
    for (const key of ENV) saved[key] = process.env[key];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    process.env['FLEET_SWEEP_ENABLED'] = 'false';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server, db);
    await grantKeys(db, { type: 'USER', id: world.ids.dev }, ['approval.decide'], world.projectId);
    runner = await enrollRunner(server, world.tokens.root, 'actor-approve-runner', {
      capabilities: { ...FLEET_CAPS, kodaTools: true, threadBackends: { native: ['m1'], acp: [] }, threadWrite: true },
    });
    calls = app.get(PrismaAssistantToolCallRepository, { strict: false });
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  afterEach(() => vi.restoreAllMocks());

  /** One new ticket of `web` (key `WEB`), so every test's comment count is its own. */
  async function newTicket(): Promise<{ id: string; ref: string }> {
    const number = ++ticketSeq;
    const ticket = await db.ticket.create({
      data: { projectId: world.projectId, number, type: 'BUG', status: 'IN_PROGRESS', priority: 'HIGH', title: 'Actor ticket' },
    });
    return { id: ticket.id, ref: `WEB-${number}` };
  }

  /** One proposal on a fresh RUNNING REPO THREAD job of `dev`'s: the route call, then the row it stored. */
  async function propose() {
    const thread = await seedThreadJobFor(db, world, runner, { feature: `actor-approve-${++seq}` });
    const ticket = await newTicket();
    await request(server)
      .post(`/api/fleet/runner/jobs/${thread.jobId}/tools/${TOOL}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runner.apiKey}` })
      .send({ toolCallId: `tc-${seq}`, input: { ref: ticket.ref, body: BODY } })
      .expect(200);
    const action = await findThreadAction(db, { jobId: thread.jobId });
    return { action, ticket };
  }

  /** `dev` decides the proposal's approval; 200 is the only accepted answer. */
  const approve = (approvalId: string) =>
    request(server)
      .post(`/api/approvals/${approvalId}/decisions`)
      .set({ Authorization: `Bearer ${world.tokens.dev}` })
      .send({ decision: 'approve' })
      .expect(200);

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-5: after dev approves the proposed action the comment exists on the ticket and the action is EXECUTED', async () => {
    const { action, ticket } = await propose();
    expect(action).toMatchObject({ status: 'pending', actorType: 'SYSTEM', actorId: 'assistant', onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev });
    // 3-D12: the approve resolves the requester from the action's actor and never reads the job's call context. The
    // proposal above is what read that context, so both spies start clean here.
    const readActor = vi.spyOn(calls, 'findUserActor');
    const readContext = vi.spyOn(calls, 'findCallContext');
    readActor.mockClear();
    readContext.mockClear();

    await approve(action.id as string);

    expect(readActor).toHaveBeenCalledWith(world.ids.dev);
    expect(readContext).not.toHaveBeenCalled();
    expect(await actionRow(action.id)).toMatchObject({ status: 'executed', approverType: 'USER', approverId: world.ids.dev });
    const created = await commentsOf(ticket.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ body: BODY, authorUserId: world.ids.dev, authorAgentId: null });
  });

  it('3-R3: the approved write runs as the action\'s actor, not as the creator the thread names at approve time', async () => {
    const { action, ticket } = await propose();
    // The proposal recorded dev as the actor. Moving the thread to another member who may also comment is what
    // tells a `findUserActor(action.actorId)` run apart from one that re-reads the job's thread creator.
    await db.chatThread.update({ where: { id: action.threadId as string }, data: { createdById: world.ids.viewer } });

    await approve(action.id as string);

    expect(await actionRow(action.id)).toMatchObject({ status: 'executed' });
    const created = await commentsOf(ticket.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ body: BODY, authorUserId: world.ids.dev, authorAgentId: null });
  });
});
