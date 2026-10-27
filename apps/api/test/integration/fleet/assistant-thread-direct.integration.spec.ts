import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { TicketLinksService } from '../../../src/ticket-links/ticket-links.service';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { enrollRunner, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, type ThreadJobSeed } from '../../helpers/thread-fixtures';

const integration = canRunDbTests() ? describe : describe.skip;
integration('direct none-mode assistant thread writes through ApprovalGate (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let seed: ThreadJobSeed;
  let saved: string | undefined;
  let seq = 0;
  const policy = async (key: string) => db.approvalPolicy.create({ data: {
    selector: `*|${key}|type:ASSISTANT`, projectId: null, permissionPattern: key,
    principalType: 'ASSISTANT', roleId: null, principalId: null, mode: 'none', timeoutSec: null,
    onTimeout: 'reject', requiredApprovals: 1, approverMustHoldAction: true,
    requireDistinctApprover: false, updatedByType: 'SYSTEM', updatedById: 'test',
  } });
  const call = async (id: string, input: unknown, tool = 'koda_add_comment') => data<{ content: string; isError: boolean }>(await request(app.getHttpServer())
    .post(`/api/fleet/runner/jobs/${seed.jobId}/tools/${tool}?leaseEpoch=1`).set('Authorization', `Bearer ${runner.apiKey}`).send({ toolCallId: id, input }).expect(200));
  beforeAll(async () => {
    saved = process.env.FLEET_THREADS_ENABLED; process.env.FLEET_THREADS_ENABLED = 'true';
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    runner = await enrollRunner(app.getHttpServer(), world.tokens.root, 'thread-direct-runner');
    await db.runner.update({ where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() } });
    await db.ticket.createMany({ data: [1, 2].map((number) => ({ projectId: world.projectId, number, title: `Direct ticket ${number}`, type: 'BUG', status: 'CREATED', priority: 'HIGH' })) });
  }, 120_000);
  beforeEach(async () => { seed = await seedThreadJobFor(db, world, runner, { feature: `direct-${++seq}` }); });
  afterAll(async () => { try { await app?.close(); } finally { if (saved === undefined) delete process.env.FLEET_THREADS_ENABLED; else process.env.FLEET_THREADS_ENABLED = saved; } });
  afterEach(() => vi.restoreAllMocks());

  it('AC-1,2: none policy writes the comment and creates neither approval request nor link', async () => {
    await policy('comment.create');
    const answer = await call('direct-comment', { ref: 'WEB-1', body: 'direct hello' });
    expect(answer.content).toMatch(/^comment [^\s]+ added to WEB-1/);
    expect(answer.content).not.toContain('\naction ');
    expect(await db.comment.count({ where: { ticket: { projectId: world.projectId }, body: 'direct hello' } })).toBe(1);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.assistantActionRequest.count()).toBe(0);
  });

  it('AC-8: preserves a batch link committed before a later link failure', async () => {
    await policy('ticket.link.add');
    const links = app.get(TicketLinksService, { strict: false });
    const originalCreate = links.create.bind(links);
    const create = vi.spyOn(links, 'create').mockImplementation(async (...args) => {
      if (args[1] === 'WEB-2') throw new Error('injected later-item failure');
      return originalCreate(...args);
    });
    const answer = await call('direct-batch', { links: [
      { ref: 'WEB-1', url: 'https://example.test/first' },
      { ref: 'WEB-2', url: 'https://example.test/second' },
    ] }, 'koda_link_tickets');
    expect(answer).toEqual({ content: 'linked WEB-1 https://example.test/first\nfailed at link 2: error', isError: true });
    expect(await db.ticketLink.count({ where: { ticket: { projectId: world.projectId }, url: 'https://example.test/first' } })).toBe(1);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.assistantActionRequest.count()).toBe(0);
    create.mockRestore();
  });
});
