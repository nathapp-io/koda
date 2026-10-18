/**
 * Fleet S5b 2a US-006 — approving an `assistant_action` over HTTP against PG: the approval-time re-check, the
 * APPROVED commit, the tool an approve really runs (the actual `CommentsService.create`), the capped terminal result
 * with its note, and the two answers one action gets under concurrent approves.
 *
 * Every action is seeded through a real `AssistantActionService.propose` (spec §Stories) and every decide enters the
 * real project route, so the guard, the DTO pipe, the late-bound `AssistantActionPort` (2a-D1), the executor and the
 * tool registry `ActionTools` fill at boot are all exercised. Each proposal gets its own thread and its own ticket,
 * so a comment count is never another test's.
 *
 * Acceptance setup: project `web` with its key changed to `KODA` (so `KODA-<n>` resolves), `dev` as its DEVELOPER
 * and the thread creator, and `FLEET_THREADS_ENABLED=true` before boot, or the route answers 409.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-actions-approve.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import request from 'supertest';
import { CommentsService } from '../../../src/comments/comments.service';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantActionService } from '../../../src/fleet/assistant/actions/assistant-action.service';
import type { ProposeInput } from '../../../src/fleet/assistant/actions/pending-action.domain';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const TOOL = 'koda_add_comment';
const PROJECT = '/api/projects/web/fleet/approvals';
const WEB_KEY = 'KODA';
const TITLE = 'Fix login page';
const BODY = 'hello';
const NOT_PENDING = 'This approval is no longer pending';

interface Proposal {
  actionId: string;
  approvalId: string;
  threadId: string;
  ticketId: string;
}

describeIntegration('approving an assistant_action (PG, US-006)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let actions: AssistantActionService;
  let comments: CommentsService;
  let seq = 0;
  let ticketSeq = 0;
  const saved: Record<string, string | undefined> = {};

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  const decide = (approvalId: string, token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`${PROJECT}/${approvalId}/decide`).set(as(token)).send(body);

  const actionRow = (id: string) => prisma.pendingAction.findUniqueOrThrow({ where: { id } });
  const approvalRow = (id: string) => prisma.fleetApproval.findUniqueOrThrow({ where: { id } });
  const commentsOf = (ticketId: string) => prisma.comment.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
  const systemNotes = (threadId: string) => prisma.chatMessage.findMany({ where: { threadId, role: 'system' }, orderBy: { seq: 'asc' } });

  /** One new ticket on the web project (key `KODA`), so each approval's comment count is its own. */
  async function newTicket(): Promise<{ id: string; ref: string }> {
    const number = ++ticketSeq;
    const ticket = await prisma.ticket.create({
      data: { projectId: world.projectId, number, type: 'BUG', status: 'IN_PROGRESS', priority: 'HIGH', title: TITLE },
    });
    return { id: ticket.id, ref: `${WEB_KEY}-${number}` };
  }

  /** A REPO thread of the web project owned by dev, with the RUNNING THREAD job whose creator the re-check reads. */
  async function seedThread(archived = false): Promise<{ threadId: string; jobId: string }> {
    const n = ++seq;
    const thread = await prisma.chatThread.create({
      data: {
        projectId: world.projectId, kind: 'REPO', repoId: world.repoId, baseRef: 'trunk', feature: `approve-${n}`,
        title: `approve ${n}`, createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' } as Prisma.InputJsonValue,
        skills: [], ...(archived ? { status: 'ARCHIVED', archivedAt: new Date() } : {}),
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
        state: 'RUNNING', threadId: thread.id,
      },
    });
    return { threadId: thread.id, jobId: job.id };
  }

  /** A real propose for a fresh thread and ticket; the default is the pending `koda_add_comment` of the ACs. */
  async function propose(over: Partial<ProposeInput> = {}, archived = false): Promise<Proposal> {
    const { threadId, jobId } = await seedThread(archived);
    const ticket = await newTicket();
    const result = await actions.propose({
      projectId: world.projectId, threadId, threadKind: 'REPO', threadProjectSlug: 'web', jobId,
      toolCallId: `tc-${++seq}`, tool: TOOL, input: { ref: ticket.ref, body: BODY },
      preview: `Add a comment to ${ticket.ref} "${TITLE}":\n\n${BODY}`, actorId: world.ids.dev, now: new Date(), ...over,
    });
    if ('refused' in result) throw new Error('propose refused');
    const row = await prisma.pendingAction.findUniqueOrThrow({ where: { id: result.actionId } });
    return { actionId: result.actionId, approvalId: row.approvalId as string, threadId, ticketId: ticket.id };
  }

  beforeAll(async () => {
    saved['FLEET_THREADS_ENABLED'] = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    // The ACs name `KODA-<n>`, so the web project answers the `KODA` key.
    await prisma.project.update({ where: { id: world.projectId }, data: { key: WEB_KEY } });
    actions = app.get(AssistantActionService, { strict: false });
    comments = app.get(CommentsService, { strict: false });
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (saved['FLEET_THREADS_ENABLED'] === undefined) delete process.env['FLEET_THREADS_ENABLED'];
      else process.env['FLEET_THREADS_ENABLED'] = saved['FLEET_THREADS_ENABLED'];
    }
  });

  it('AC-1: the requester approving a pending action answers 200', async () => {
    const { approvalId } = await propose();

    const res = await decide(approvalId, world.tokens.dev, { decision: 'approve' }).expect(200);

    expect(data<Record<string, unknown>>(res)).toMatchObject({ id: approvalId, type: 'assistant_action', status: 'approved' });
  });

  it('AC-4, AC-5 and AC-6: after that approve the action is EXECUTED with its result and the approval is approved', async () => {
    const { actionId, approvalId } = await propose();

    await decide(approvalId, world.tokens.dev, { decision: 'approve' }).expect(200);

    const action = await actionRow(actionId);
    expect(action.status).toBe('EXECUTED');
    expect(action.result).not.toBeNull();
    expect(action.result?.startsWith('comment ')).toBe(true);
    expect(action.approverId).toBe(world.ids.dev);
    expect(action.decidedAt).not.toBeNull();
    expect(await approvalRow(approvalId)).toMatchObject({
      status: 'approved', decision: 'approve', resolvedBy: 'user', decidedById: world.ids.dev,
    });
  });

  it('AC-2 and AC-3: after that approve the ticket carries one comment with the body, authored by the requester', async () => {
    const { approvalId, ticketId } = await propose();

    await decide(approvalId, world.tokens.dev, { decision: 'approve' }).expect(200);

    const created = await commentsOf(ticketId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ body: BODY, authorUserId: world.ids.dev, authorAgentId: null });
  });

  it('AC-7: after that approve the thread has the done note naming the action, the tool and the comment', async () => {
    const { actionId, approvalId, threadId } = await propose();

    await decide(approvalId, world.tokens.dev, { decision: 'approve' }).expect(200);

    const notes = await systemNotes(threadId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ role: 'system', status: 'complete', authorUserId: null });
    expect(notes[0].content.startsWith(`Action ${actionId} (${TOOL}) was approved and done: comment `)).toBe(true);
    expect(notes[0].seq).toBeGreaterThan(0);
  });

  it('AC-8 and AC-9: two concurrent approves answer one 200 and one 409, and the ticket carries one comment', async () => {
    const { actionId, approvalId, ticketId, threadId } = await propose();

    const [first, second] = await Promise.all([
      decide(approvalId, world.tokens.dev, { decision: 'approve' }),
      decide(approvalId, world.tokens.dev, { decision: 'approve' }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.message).toBe(NOT_PENDING);
    expect(await commentsOf(ticketId)).toHaveLength(1);
    expect(await actionRow(actionId)).toMatchObject({ status: 'EXECUTED' });
    expect(await systemNotes(threadId)).toHaveLength(1);
  });

  it('AC-10 and AC-11: a requester removed from the action\'s project is refused and the action stays PENDING', async () => {
    const { actionId, approvalId, ticketId, threadId } = await propose();
    await prisma.projectMember.deleteMany({ where: { projectId: world.projectId, userId: world.ids.dev } });

    try {
      const res = await decide(approvalId, world.tokens.dev, { decision: 'approve' }).expect(403);

      expect(res.status).toBe(403);
      expect(await actionRow(actionId)).toMatchObject({ status: 'PENDING', result: null, approverId: null });
      expect(await approvalRow(approvalId)).toMatchObject({ status: 'pending', decision: null });
      expect(await commentsOf(ticketId)).toHaveLength(0);
      expect(await systemNotes(threadId)).toHaveLength(0);
    } finally {
      await prisma.projectMember.create({ data: { projectId: world.projectId, userId: world.ids.dev, role: 'DEVELOPER' } });
    }
  });

  it('AC-15 and AC-16: a ticket soft-deleted after the proposal still approves, and the action is FAILED with not_found', async () => {
    const { actionId, approvalId, ticketId } = await propose();
    await prisma.ticket.update({ where: { id: ticketId }, data: { deletedAt: new Date() } });

    const res = await decide(approvalId, world.tokens.dev, { decision: 'approve' }).expect(200);

    // The approval was decided, so it stays approved whatever the tool answered.
    expect(data<{ status: string }>(res).status).toBe('approved');
    expect(await actionRow(actionId)).toMatchObject({ status: 'FAILED', result: 'not_found' });
    expect(await commentsOf(ticketId)).toHaveLength(0);
  });

  it('AC-23: a tool that raises NotFoundAppException leaves the failed note naming `not_found`', async () => {
    const { actionId, approvalId, threadId, ticketId } = await propose();
    await prisma.ticket.update({ where: { id: ticketId }, data: { deletedAt: new Date() } });

    await decide(approvalId, world.tokens.dev, { decision: 'approve' }).expect(200);

    const notes = await systemNotes(threadId);
    expect(notes.map((note) => note.content)).toEqual([`Action ${actionId} (${TOOL}) was approved but failed: not_found`]);
  });

  it('AC-24, AC-25 and AC-27: an ordinary tool error leaves FAILED with error: <tool> failed and its note', async () => {
    const { actionId, approvalId, threadId } = await propose();
    // The tool's own `CommentsService.create` raises something that is neither a NotFound nor a domain refusal.
    const failed = vi.spyOn(comments, 'create').mockRejectedValueOnce(new Error('ticket store is down'));
    try {
      await decide(approvalId, world.tokens.dev, { decision: 'approve' }).expect(200);
    } finally {
      failed.mockRestore();
    }

    expect(await actionRow(actionId)).toMatchObject({ status: 'FAILED', result: `error: ${TOOL} failed` });
    expect((await systemNotes(threadId)).map((note) => note.content))
      .toEqual([`Action ${actionId} (${TOOL}) was approved but failed: error: ${TOOL} failed`]);
  });

  it('AC-19 and AC-20: an approve on an archived thread answers 200 and executes', async () => {
    const { actionId, approvalId, threadId } = await propose({}, true);
    expect(await prisma.chatThread.findUniqueOrThrow({ where: { id: threadId } })).toMatchObject({ status: 'ARCHIVED' });

    const res = await decide(approvalId, world.tokens.dev, { decision: 'approve' }).expect(200);

    expect(data<{ status: string }>(res).status).toBe('approved');
    expect(await actionRow(actionId)).toMatchObject({ status: 'EXECUTED' });
    expect(await systemNotes(threadId)).toHaveLength(1);
  });

  it('a reject still closes the action without running the tool', async () => {
    const { actionId, approvalId, ticketId } = await propose();

    const res = await decide(approvalId, world.tokens.dev, { decision: 'reject', comment: 'not now' }).expect(200);

    expect(data<Record<string, unknown>>(res)).toMatchObject({ status: 'rejected', decision: 'reject', comment: 'not now' });
    expect(await actionRow(actionId)).toMatchObject({ status: 'REJECTED', result: null });
    expect(await commentsOf(ticketId)).toHaveLength(0);
  });

  it('the approval summary carries no preview or input, and the approve posts the body as written', async () => {
    const { actionId, approvalId, ticketId } = await propose();

    const approval = await approvalRow(approvalId);
    // The summary carries the action id, never the preview or the input (2a-D5).
    expect(approval.payload).toMatchObject({ actionId, tool: TOOL, requestedById: world.ids.dev });
    expect(JSON.stringify(approval.payload)).not.toContain(BODY);

    await decide(approvalId, world.tokens.dev, { decision: 'approve' }).expect(200);

    expect((await commentsOf(ticketId))[0]?.body).toBe(BODY);
  });
});
