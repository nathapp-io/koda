/**
 * Fleet S5b 2a US-003 — `koda_add_comment` and `koda_get_action` through the real runner tool route against PG.
 *
 * Every call enters at `POST /fleet/runner/jobs/:jobId/tools/:name?leaseEpoch=<n>` with the real runner key of the
 * runner that holds a RUNNING THREAD job, so the ACs drive the whole path: runner authentication, the lease fence,
 * the tool registry `ActionTools` filled at boot, the executor's write-tool branch and the propose service. The
 * action reads are seeded by a real propose call, never by an insert, and the cross-thread and cross-project ACs use
 * the same ids from a different reading context.
 *
 * Acceptance setup: project `web` (its key changed to `KODA`, so the acceptance ref `KODA-1` resolves), project
 * `ops` (key `OPS`, its `OPS-1`), `dev` as the DEVELOPER and thread creator of both, and one REPO thread, one
 * second REPO thread and one WORKSPACE thread, each with its own RUNNING THREAD job held by the same enrolled
 * runner. FLEET_THREADS_ENABLED=true before boot, or the route answers 409.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-action-tools.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { expectBindingOnlyFixtures, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, enrollRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });
const ENV = ['FLEET_THREADS_ENABLED'] as const;

/** The web project's key, so the acceptance ref is `KODA-1`. */
const WEB_KEY = 'KODA';
const TITLE = 'Fix login page';
const BODY = 'hello';

/** The route's answer: `{ content, isError }` data, whatever the status. */
interface ToolResultBody { content: string; isError: boolean }

describeIntegration('fleet assistant action tools (PG, US-003)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runnerKey: string;
  let repo: ThreadJobSeed;
  let other: ThreadJobSeed;
  let workspace: ThreadJobSeed;
  let ticketId: string;
  const saved: Record<string, string | undefined> = {};

  /** POSTs one tool call on `jobId` as the runner holding it, at the job's lease epoch 1. */
  const callTool = (jobId: string, name: string, toolCallId: string, input: unknown) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${jobId}/tools/${name}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runnerKey}` })
      .send({ toolCallId, input });

  const resultOf = (res: request.Response): ToolResultBody => data<ToolResultBody>(res);

  /** One accepted `koda_add_comment` call: answers the id of the action it stored. */
  const propose = async (jobId: string, toolCallId: string, input: unknown = { ref: 'KODA-1', body: BODY }): Promise<string> => {
    const { content, isError } = resultOf(await callTool(jobId, 'koda_add_comment', toolCallId, input).expect(200));
    expect(isError).toBe(false);
    expect(content.startsWith('pending ')).toBe(true);
    const action = await prisma.pendingAction.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId, toolCallId } } });
    expect(content).toBe(`pending ${action.id}: awaiting user approval; do not retry`);
    return action.id;
  };

  /** One `koda_get_action` read; `project` is the WORKSPACE argument, absent in a REPO thread. */
  const actionText = async (jobId: string, toolCallId: string, input: { id: string; project?: string }): Promise<ToolResultBody> =>
    resultOf(await callTool(jobId, 'koda_get_action', toolCallId, input).expect(200));

  const actionOf = (jobId: string, toolCallId: string) => prisma.pendingAction.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId, toolCallId } } });

  beforeAll(async () => {
    saved['FLEET_THREADS_ENABLED'] = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    // 2a-D13: the acceptance ref is `KODA-1`, so the web project answers the `KODA` key.
    await prisma.project.update({ where: { id: world.projectId }, data: { key: WEB_KEY } });
    ticketId = (await prisma.ticket.create({
      data: { projectId: world.projectId, number: 1, type: 'BUG', status: 'IN_PROGRESS', priority: 'HIGH', title: TITLE },
    })).id;
    await prisma.ticket.create({
      data: { projectId: world.opsProjectId, number: 1, type: 'BUG', status: 'CREATED', priority: 'MEDIUM', title: 'ops ticket' },
    });
    // The workspace AC proposes in `ops`, so the thread creator is a member there too.
    await grantRole(prisma, { type: 'USER', id: world.ids.dev }, 'developer', world.opsProjectId);
    const runner = await enrollRunner(server, world.tokens.root, 'action-tools-runner');
    await prisma.runner.update({
      where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() },
    });
    runnerKey = runner.apiKey;
    const held = { runnerId: runner.runnerId, apiKey: runner.apiKey };
    repo = await seedThreadJobFor(prisma, world, held, { feature: 'action-repo' });
    other = await seedThreadJobFor(prisma, world, held, { feature: 'action-other' });
    workspace = await seedThreadJobFor(prisma, world, held, { kind: 'WORKSPACE', feature: 'action-workspace' });
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

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
    ]);
  });

  it('AC-4: a runner holding a RUNNING REPO THREAD job proposes a comment and is answered pending', async () => {
    const res = await callTool(repo.jobId, 'koda_add_comment', 't1', { ref: 'KODA-1', body: BODY }).expect(200);

    const { content, isError } = resultOf(res);
    expect(isError).toBe(false);
    expect(content.startsWith('pending ')).toBe(true);
    expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId: 't1' } })).toBe(1);
  });

  it('AC-5: a proposed comment is not written to the ticket', async () => {
    await propose(repo.jobId, 'ac5');

    expect(await prisma.comment.count({ where: { ticketId } })).toBe(0);
  });

  it('AC-6: the stored preview names the ticket and the body the user is asked to approve', async () => {
    const id = await propose(repo.jobId, 'ac6');

    const { preview } = await prisma.pendingAction.findUniqueOrThrow({ where: { id } });
    expect(preview.startsWith(`Add a comment to KODA-1 "${TITLE}"`)).toBe(true);
    expect(preview).toBe(`Add a comment to KODA-1 "${TITLE}":\n\n${BODY}`);
  });

  it('AC-7: a ref that matches no ticket of the project answers not_found', async () => {
    const { content, isError } = resultOf(
      await callTool(repo.jobId, 'koda_add_comment', 'ac7', { ref: 'KODA-99', body: BODY }).expect(200),
    );

    expect(isError).toBe(true);
    expect(content).toBe('not_found');
  });

  it('AC-8: a ref that matches no ticket of the project stores no action', async () => {
    await callTool(repo.jobId, 'koda_add_comment', 'ac8', { ref: 'KODA-99', body: BODY }).expect(200);

    expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId: 'ac8' } })).toBe(0);
    expect(await prisma.assistantToolCall.count({ where: { jobId: repo.jobId, toolCallId: 'ac8' } })).toBe(1);
    expect(await prisma.assistantToolCall.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId: 'ac8' } } }))
      .toMatchObject({ outcome: 'not_found', isError: true, content: 'not_found', tool: 'koda_add_comment' });
  });

  it('AC-8: another project\'s ref is not_found too, and stores no action', async () => {
    const { content, isError } = resultOf(
      await callTool(repo.jobId, 'koda_add_comment', 'ac8-foreign', { ref: 'OPS-1', body: BODY }).expect(200),
    );

    expect({ content, isError }).toEqual({ content: 'not_found', isError: true });
    expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId: 'ac8-foreign' } })).toBe(0);
  });

  it('AC-11: koda_get_action answers the pending action of the thread that proposed it', async () => {
    const id = await propose(repo.jobId, 'ac11');
    const action = await actionOf(repo.jobId, 'ac11');

    const { content, isError } = await actionText(repo.jobId, 'ac11-read', { id });

    expect(isError).toBe(false);
    expect(content.split('\n')).toEqual([
      `action ${id} koda_add_comment PENDING`,
      `requested ${action.createdAt.toISOString()}`,
    ]);
  });

  it('AC-12: the id of an action of another thread in the same project answers not_found', async () => {
    const id = await propose(other.jobId, 'ac12');
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id } })).projectId).toBe(world.projectId);

    const { content, isError } = await actionText(repo.jobId, 'ac12-read', { id });

    expect(isError).toBe(true);
    expect(content).toBe('not_found');
  });

  it('AC-17: the id of an action of another project answers not_found, while its own project still reads it', async () => {
    const id = await propose(workspace.jobId, 'ac17', { project: 'ops', ref: 'OPS-1', body: BODY });
    const action = await actionOf(workspace.jobId, 'ac17');
    expect(action.projectId).toBe(world.opsProjectId);

    const own = await actionText(workspace.jobId, 'ac17-ops', { project: 'ops', id });
    expect(own).toEqual({
      content: `action ${id} koda_add_comment PENDING\nrequested ${action.createdAt.toISOString()}`,
      isError: false,
    });
    const foreign = await actionText(workspace.jobId, 'ac17-web', { project: 'web', id });
    expect(foreign).toEqual({ content: 'not_found', isError: true });
  });

  it('AC-18: an unknown action id answers not_found', async () => {
    const { content, isError } = await actionText(repo.jobId, 'ac18', { id: 'clx0a1b2c3d4e5f6g7h8i' });

    expect(isError).toBe(true);
    expect(content).toBe('not_found');
  });

  it('AC-19: an empty trimmed body answers invalid_input: body and stores nothing', async () => {
    const { content, isError } = resultOf(
      await callTool(repo.jobId, 'koda_add_comment', 'ac19', { ref: 'KODA-1', body: ' \n ' }).expect(200),
    );

    expect(isError).toBe(true);
    expect(content).toBe('invalid_input: body');
    expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId: 'ac19' } })).toBe(0);
  });

  it('AC-20: a trimmed body longer than 10000 characters answers invalid_input: body', async () => {
    const body = `  ${'x'.repeat(10_001)}  `;

    const { content, isError } = resultOf(
      await callTool(repo.jobId, 'koda_add_comment', 'ac20', { ref: 'KODA-1', body }).expect(200),
    );

    expect(isError).toBe(true);
    expect(content).toBe('invalid_input: body');
    expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId: 'ac20' } })).toBe(0);
  });

  it('AC-21: an action id longer than 64 characters answers content exactly invalid_input: id', async () => {
    const read = await actionText(repo.jobId, 'ac21', { id: 'x'.repeat(65) });

    expect(read.content).toBe('invalid_input: id');
  });
});
