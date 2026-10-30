import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P3 US-004 — the assistant's `koda_list_approvals` reads the approval engine (AC-1, AC-2, over real HTTP
 * and real Postgres).
 *
 * The tool is entered the way a runner enters it: `POST /api/fleet/runner/jobs/:jobId/tools/koda_list_approvals` with
 * the real key of the runner that holds the job, so authentication, the lease fence, the thread gates, the key
 * `project.read` and the tool itself all run. The job is a PROJECT thread of `web` whose creator is `dev`, so the
 * actor the engine reads for is `dev`.
 *
 * `dev` holds `approval.decide` globally, so the pending request of `ops` is one this actor may decide — it is only the
 * thread project filter that keeps it out of `web`'s answer (AC-2). Both requests are opened by an agent (a USER
 * subject is executed at once instead of opening a request), and `dev`'s own approval read needs no role there.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/fleet/assistant-approvals-tool.integration.spec.ts
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalRequestQueries } from '../../../src/approvals/approval-request.queries';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const ENV = ['FLEET_THREADS_ENABLED'] as const;
const BOOT_TIMEOUT = 120_000;

/** The tool route's answer: `{ content, isError }` data, whatever the status. */
interface ToolAnswer { content: string; isError: boolean }

describeIntegration('assistant koda_list_approvals reads the engine (US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let thread: ThreadJobSeed;
  const saved: Record<string, string | undefined> = {};

  /** The command `label.delete` is registered under, so the gate can open a request for it. */
  const labels = configurableTestCommand('label.delete');
  /** The requests this file opened, so each test starts from an empty inbox (no test reads another's rows). */
  let openedIds: string[] = [];

  /** Opens a pending request of `projectId` as `actor`, the way a fleet ask does: an AGENT subject waits. */
  const openRequest = async (actorId: string, projectId: string): Promise<{ id: string; permissionKey: string }> => {
    const gate = app.get(ApprovalGate, { strict: false });
    const outcome = await withTestActor({ type: 'AGENT', id: actorId }, () =>
      gate.gate('label.delete', { labelId: randomUUID() }, { projectId }, new Date()));
    if (outcome.status !== 'pending') throw new Error('expected a pending approval request');
    openedIds.push(outcome.request.id);
    return outcome.request;
  };

  const call = (toolCallId: string, input: unknown) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${thread.jobId}/tools/koda_list_approvals?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runner.apiKey}` })
      .send({ toolCallId, input });

  beforeAll(async () => {
    for (const key of ENV) saved[key] = process.env[key];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    app.get(ApprovalCommandRegistry, { strict: false }).register(labels.command);

    // AC-2: `dev` may decide in `ops` too, so the ops request is visible to the actor and only the thread project
    // filter keeps it out of the answer.
    await grantKeys(prisma, { type: 'USER', id: world.ids.dev }, ['approval.decide'], null);

    runner = await enrollRunner(server, world.tokens.root, 'approvals-tool-runner');
    thread = await seedThreadJobFor(prisma, world, runner, { kind: 'PROJECT', feature: 'us004-approvals' });
    await app.get(PermissionCache, { strict: false }).invalidate();
  }, BOOT_TIMEOUT);

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

  beforeEach(async () => {
    labels.reset();
    // Each test opens the requests it reads: a row written by an earlier `it` is removed first, so a shuffled run
    // and the file's own order answer the same.
    if (openedIds.length > 0) {
      await prisma.approvalRequest.deleteMany({ where: { id: { in: openedIds } } });
      openedIds = [];
    }
  });

  it('AC-1: the PROJECT thread of web answers one line per pending web request, id then permissionKey', async () => {
    const agent = await seedFleetHttpAgent(server, world.tokens.root);
    const web = await openRequest(agent.id, world.projectId);

    const answer = data<ToolAnswer>(await call('ac1', {}).expect(200));

    expect(answer.isError).toBe(false);
    const lines = answer.content.split('\n').filter((line) => !line.startsWith('more: call'));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(`${web.id} ${web.permissionKey} `)).toBe(true);
    expect(lines[0]).toBe(`${web.id} label.delete pending ${web.createdAt.toISOString()}`);
    // The audit row the route stores names the tool and the project the call acted in.
    expect(await prisma.assistantToolCall.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: thread.jobId, toolCallId: 'ac1' } } }))
      .toMatchObject({ tool: 'koda_list_approvals', projectId: world.projectId, outcome: 'ok', isError: false });
  }, BOOT_TIMEOUT);

  it('AC-2: a pending ops request the actor may decide stays out of the web answer', async () => {
    const agent = await seedFleetHttpAgent(server, world.tokens.root);
    const web = await openRequest(agent.id, world.projectId);
    const ops = await openRequest(agent.id, world.opsProjectId);

    // The premise: the ops request is one `dev` may decide, so it is visible to the engine for this actor.
    const decidable = await app.get(ApprovalRequestQueries, { strict: false })
      .list({ type: 'USER', id: world.ids.dev }, { status: 'pending' }, { current: 1, size: 20 });
    expect(decidable.records.map((record) => record.id)).toEqual(expect.arrayContaining([web.id, ops.id]));

    const answer = data<ToolAnswer>(await call('ac2', {}).expect(200));

    expect(answer.isError).toBe(false);
    expect(answer.content).toContain(web.id);
    expect(answer.content).not.toContain(ops.id);
  }, BOOT_TIMEOUT);
});
