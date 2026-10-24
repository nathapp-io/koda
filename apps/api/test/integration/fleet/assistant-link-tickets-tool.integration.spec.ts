import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b 2b1 US-005 — `koda_link_tickets` through the real runner tool route against PG.
 *
 * Every call enters at `POST /fleet/runner/jobs/:jobId/tools/koda_link_tickets?leaseEpoch=<n>` with the real runner
 * key of the runner that holds a RUNNING THREAD job, and every decide enters the real project route
 * `POST /projects/web/fleet/approvals/:approvalId/decide`, so the ACs drive the whole path: runner authentication,
 * the lease fence, the tool registry `TicketWriteTools` filled at boot, the executor's write-tool branch, the propose
 * service and — on approve — `TicketLinksService.create` for real. Each test proposes its own links with its own
 * `toolCallId` and its own URLs, and reads back only the URLs it proposed, so no test depends on the order of the
 * ones around it.
 *
 * Acceptance setup: project `web` (its key changed to `KODA`, so the acceptance ref `KODA-1` resolves), `dev` as
 * its DEVELOPER and the thread creator, ticket `KODA-1`, ticket `KODA-2` for the partial-failure case, one ticket
 * `OPS-1` in the sibling project `ops` for the foreign-ref case, and one RUNNING REPO THREAD job held by an enrolled
 * runner — plus a second RUNNING REPO THREAD job whose thread `viewer` created, for AC-15.
 * FLEET_THREADS_ENABLED=true before boot, or the route answers 409.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-link-tickets-tool.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, enrollRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';
import { deliveryText } from '../../../src/fleet/assistant/actions/outcome-delivery';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });
const ENV = ['FLEET_THREADS_ENABLED'] as const;

/** The web project's key, so the acceptance ref is `KODA-1`. */
const WEB_KEY = 'KODA';
const TOOL = 'koda_link_tickets';
const APPROVALS = '/api/projects/web/fleet/approvals';
const PR_URL = 'https://github.com/o/r/pull/7';
/** `THREAD_LIMITS.messageMaxBytes` (32,768): the budget one hand-off gives the notes and the user's text. */
const DELIVERY_MAX_BYTES = 32_768;
/** The route's answer: `{ content, isError }` data, whatever the status. */
interface ToolResultBody { content: string; isError: boolean }

describeIntegration('fleet assistant link tickets tool (PG, US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let repo: ThreadJobSeed;
  let viewerRepo: ThreadJobSeed;
  let ticketId: string;
  let secondTicketId: string;
  const saved: Record<string, string | undefined> = {};

  /** POSTs one `koda_link_tickets` call on the held job as its runner, at the job's lease epoch 1. */
  const callTool = (toolCallId: string, input: unknown, job: ThreadJobSeed = repo) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${job.jobId}/tools/${TOOL}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${job.runnerKey}` })
      .send({ toolCallId, input });

  const resultOf = (res: request.Response): ToolResultBody => data<ToolResultBody>(res);

  /** The stored action of one tool call, on the job the call entered through. */
  const actionOf = (toolCallId: string, job: ThreadJobSeed = repo) =>
    prisma.pendingAction.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: job.jobId, toolCallId } } });

  /** The links the ticket really carries, oldest first. */
  const linksOf = (id: string) => prisma.ticketLink.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } });

  /** One accepted proposal: answers the stored action, asserting the call itself was answered `pending`. */
  const propose = async (toolCallId: string, links: unknown[], job: ThreadJobSeed = repo) => {
    const { content, isError } = resultOf(await callTool(toolCallId, { links }, job).expect(200));
    expect(isError).toBe(false);
    expect(content.startsWith('pending ')).toBe(true);
    return actionOf(toolCallId, job);
  };

  /** `dev` decides one approval; answers the decide response. */
  const decide = (approvalId: string, decision: string) =>
    request(server).post(`${APPROVALS}/${approvalId}/decide`).set({ Authorization: `Bearer ${world.tokens.dev}` }).send({ decision });

  beforeAll(async () => {
    saved['FLEET_THREADS_ENABLED'] = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    // The acceptance ref is `KODA-1`, so the web project answers the `KODA` key.
    await prisma.project.update({ where: { id: world.projectId }, data: { key: WEB_KEY } });
    ticketId = (await prisma.ticket.create({
      data: {
        projectId: world.projectId, number: 1, type: 'BUG', title: 'Fix login', description: 'the old text',
        status: 'CREATED', priority: 'MEDIUM',
      },
    })).id;
    secondTicketId = (await prisma.ticket.create({
      data: { projectId: world.projectId, number: 2, type: 'TASK', title: 'Fix logout', status: 'CREATED', priority: 'MEDIUM' },
    })).id;
    // A ref of the sibling project `ops`: it exists, but it is no ticket of `web` (2b1-D6).
    await prisma.ticket.create({
      data: { projectId: world.opsProjectId, number: 1, type: 'TASK', title: 'Ops ticket', status: 'CREATED', priority: 'MEDIUM' },
    });
    const runner = await enrollRunner(server, world.tokens.root, 'link-tickets-runner');
    await prisma.runner.update({
      where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() },
    });
    const held = { runnerId: runner.runnerId, apiKey: runner.apiKey };
    repo = await seedThreadJobFor(prisma, world, held, { feature: 'link-tickets' });
    viewerRepo = await seedThreadJobFor(prisma, world, held, { feature: 'link-tickets-viewer', createdById: world.ids.viewer });
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

  it('AC-12: a runner holding a RUNNING REPO THREAD job proposes one pull request URL and is answered pending', async () => {
    const { content, isError } = resultOf(await callTool('ac12', { links: [{ ref: 'KODA-1', url: PR_URL }] }).expect(200));

    expect(isError).toBe(false);
    expect(content.startsWith('pending ')).toBe(true);
    const action = await actionOf('ac12');
    expect(content).toBe(`pending ${action.id}: awaiting user approval; do not retry`);
    expect(action).toMatchObject({ tool: TOOL, status: 'PENDING' });
    // The stored preview is the text the user approves, with the kind this URL will be stored as.
    expect(action.preview.split('\n')).toEqual(['Link 1 URL(s) in web:', `- KODA-1 "Fix login" <- pr ${PR_URL}`]);
    // The audit row proves the call reached the registered tool rather than being refused by name.
    expect(await prisma.assistantToolCall.findUniqueOrThrow({
      where: { jobId_toolCallId: { jobId: repo.jobId, toolCallId: 'ac12' } },
    })).toMatchObject({ tool: TOOL, outcome: 'pending', isError: false });
  });

  it('AC-13: the proposal stores no TicketLink, so KODA-1 carries none of that URL while the user decides', async () => {
    // Its own URL, so this test reads what it proposed and nothing an earlier test linked (branch review M1).
    const url = 'https://github.com/o/r/pull/13';
    const action = await propose('ac13', [{ ref: 'KODA-1', url }]);

    expect(await prisma.ticketLink.count({ where: { ticketId, url } })).toBe(0);
    expect(action).toMatchObject({ status: 'PENDING' });
  });

  it('AC-14: after dev approves, KODA-1 carries that one link, with the kind the URL infers', async () => {
    const action = await propose('ac14', [{ ref: 'KODA-1', url: PR_URL }]);

    await decide(action.approvalId, 'approve').expect(200);

    // The rows of the URL this test proposed: another test's links to KODA-1 are not this AC's subject.
    const links = (await linksOf(ticketId)).filter((link) => link.url === PR_URL);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ url: PR_URL, linkType: 'pr' });
    expect(await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } }))
      .toMatchObject({ status: 'EXECUTED', result: `linked KODA-1 ${PR_URL}` });
  });

  it('AC-15 (US-004): a thread the VIEWER created is refused ticket.link.add and stores no action', async () => {
    // Permissions P1 US-004: membership is no longer enough — the tool checks its catalog key, and the viewer role
    // holds only the read keys and comment.create in web.
    const { content, isError } = resultOf(
      await callTool('ac15', { links: [{ ref: 'KODA-1', url: 'https://x.dev/viewer-doc' }] }, viewerRepo).expect(200),
    );

    expect({ content, isError }).toEqual({ content: 'forbidden: koda_link_tickets needs ticket.link.add on web', isError: true });
    expect(await prisma.pendingAction.count({ where: { jobId: viewerRepo.jobId, toolCallId: 'ac15' } })).toBe(0);
    // Nothing is written: the refusal happens before the preview, let alone the propose.
    expect(await prisma.ticketLink.count({ where: { url: 'https://x.dev/viewer-doc' } })).toBe(0);
    expect(await prisma.assistantToolCall.findUniqueOrThrow({
      where: { jobId_toolCallId: { jobId: viewerRepo.jobId, toolCallId: 'ac15' } },
    })).toMatchObject({ tool: TOOL, outcome: 'forbidden', isError: true });
  });

  it('AC-16: a missing and a foreign-project ref both answer not_found and store no action', async () => {
    for (const [toolCallId, ref] of [['ac16-missing', 'KODA-99'], ['ac16-foreign', 'OPS-1']] as const) {
      const { content, isError } = resultOf(await callTool(toolCallId, { links: [{ ref, url: 'https://x.dev/x' }] }).expect(200));

      expect({ content, isError }).toEqual({ content: 'not_found', isError: true });
      expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId } })).toBe(0);
    }
  });

  it('an input the parser refuses answers invalid_input with the field\'s own reason and stores no action', async () => {
    const { content, isError } = resultOf(await callTool('ac-invalid', {
      links: [{ ref: 'KODA-1', url: PR_URL }, { ref: 'KODA-1', url: 'ftp://host/x' }],
    }).expect(200));

    expect({ content, isError }).toEqual({ content: 'invalid_input: links[1].url', isError: true });
    expect(await prisma.pendingAction.count({ where: { jobId: repo.jobId, toolCallId: 'ac-invalid' } })).toBe(0);
  });

  it('approving a URL the ticket already carries reads as already linked and adds no second row', async () => {
    const url = 'https://x.dev/design-doc';
    const first = await propose('ac-already-1', [{ ref: 'KODA-1', url }]);
    await decide(first.approvalId, 'approve').expect(200);

    const second = await propose('ac-already-2', [{ ref: 'KODA-1', url }]);
    await decide(second.approvalId, 'approve').expect(200);

    expect(await prisma.pendingAction.findUniqueOrThrow({ where: { id: second.id } }))
      .toMatchObject({ status: 'EXECUTED', result: `linked KODA-1 ${url} (already linked)` });
    expect(await prisma.ticketLink.count({ where: { ticketId, url } })).toBe(1);
  });

  it('B2: a credential a link URL carries reaches neither the stored result, nor the outcome note, nor the next delivery', async () => {
    // Branch review B2: the preview masked this token, but the tool's own answer echoed the raw URL into the action's
    // `result`, the note `finalize` writes and — through that note — the text the agent reads on its next turn.
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const url = `https://x.dev/secret?token=${token}`;
    const action = await propose('b2-secret', [{ ref: 'KODA-1', url }]);
    expect(action.preview).not.toContain(token);

    await decide(action.approvalId, 'approve').expect(200);

    const settled = await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(settled).toMatchObject({ status: 'EXECUTED', result: 'linked KODA-1 https://x.dev/secret?token=[masked]' });

    // The note the approve left in the thread, found by the action it names.
    const note = await prisma.chatMessage.findFirstOrThrow({
      where: { threadId: repo.threadId, role: 'system', content: { startsWith: `Action ${action.id} ` } },
    });
    expect(note.content).toContain('https://x.dev/secret?token=[masked]');
    expect(note.content).not.toContain(token);
    // What `sendMessage` hands the runner on the next turn is this note, composed by `deliveryText`.
    expect(deliveryText([note.content], 'what next?', DELIVERY_MAX_BYTES).text).not.toContain(token);
  });

  it('a link whose ticket disappears before the approval fails the batch and quotes the line it wrote', async () => {
    const url = 'https://x.dev/runbook';
    const action = await propose('ac-partial', [
      { ref: 'KODA-1', url },
      { ref: 'KODA-2', url: 'https://x.dev/split' },
    ]);
    // The ticket the second link names is soft-deleted between propose and approve (2b1-D7 keeps the order).
    await prisma.ticket.update({ where: { id: secondTicketId }, data: { deletedAt: new Date() } });

    await decide(action.approvalId, 'approve').expect(200);

    expect(await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } }))
      .toMatchObject({ status: 'FAILED', result: `linked KODA-1 ${url}\nfailed at link 2: not_found` });
    // The first link stays written: the batch is not atomic.
    expect(await prisma.ticketLink.count({ where: { ticketId, url } })).toBe(1);
    expect(await prisma.ticketLink.count({ where: { url: 'https://x.dev/split' } })).toBe(0);
  });
});
