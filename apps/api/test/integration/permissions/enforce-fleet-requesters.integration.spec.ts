/**
 * Permissions P1d US-002 — a fleet job and a schedule record an agent requester, and the readers that
 * assumed a user (the outcome notification, the cancel activity row, the ticket events of a job's
 * effects, the ticket event recorder) handle one; against real Postgres.
 *
 * The services are reached through the real container (AppModule + init), and every write is read back
 * from PG, so the row mapper, the schema default and the action context are all exercised. The action
 * context is the one US-001 added: `runWithActor` is what the request interceptor does for an agent.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/enforce-fleet-requesters.integration.spec.ts
 */
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { runWithActor } from '../../../src/action-context/action-context';
import { ContextlessWriteError } from '../../../src/action-context/contextless-write';
import { AppModule } from '../../../src/app.module';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { FleetJobTicketEffects } from '../../../src/fleet/tickets/fleet-job-ticket.effects';
import { FleetTicketEventRecorder } from '../../../src/fleet/tickets/fleet-ticket-event.recorder';
import { FleetJobOutcomeRecorder } from '../../../src/fleet/jobs/job-outcome.recorder';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { FLEET_JOB_REPOSITORY, type IFleetJobRepository } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import { ConfigJobsService } from '../../../src/fleet/repo-config/config-jobs.service';
import { SchedulesService } from '../../../src/fleet/schedules/schedules.service';
import type { DispatchFleetJobDto } from '../../../src/fleet/jobs/dto/dispatch-fleet-job.dto';
import type { CreateScheduleDto } from '../../../src/fleet/schedules/dto/create-schedule.dto';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

vi.setConfig({ testTimeout: 60_000 });

const ENV_KEYS = ['GITHUB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG'] as const;
const HEAD = 'c'.repeat(40);

describeIntegration('enforce-fleet requesters (PG)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaClient;
  let jobs: FleetJobsService;
  let jobRepo: IFleetJobRepository;
  let schedules: SchedulesService;
  let configJobs: ConfigJobsService;
  let outcomes: FleetJobOutcomeRecorder;
  let effects: FleetJobTicketEffects;
  let ticketEvents: FleetTicketEventRecorder;
  let forge: FakeForge;
  let keyDir: string;
  const saved: Record<string, string | undefined> = {};

  let projectId: string;
  let slug: string;
  let key: string;
  let repoId: string;
  let userId: string;
  let agentId: string;
  let counter = 0;

  const dispatchDto = (feature: string): DispatchFleetJobDto => ({
    repoId, command: 'RUN', feature, ref: 'trunk', profiles: [], maxCostUsd: 5, selectorLabels: [], bashMode: 'raw', approvalTimeoutSec: 600,
  });
  const scheduleDto = (feature: string): CreateScheduleDto => ({
    name: 'nightly', repoId, feature, cron: '0 9 * * 1-5', timezone: 'UTC', maxCostUsd: 5,
  });

  /** A job row as the dispatcher leaves it; `requestedByType` is what the AC under test reads. */
  const newJob = async (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => {
    counter += 1;
    return prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'trunk', command: 'RUN', feature: `job${counter}`, profiles: [], maxCostUsd: new Prisma.Decimal(5),
        selectorLabels: [], requestedById: userId, state: 'QUEUED', ...over,
      },
    });
  };
  const newTicket = async () => {
    counter += 1;
    return prisma.ticket.create({ data: { projectId, number: counter, type: 'TASK', title: `Ticket ${counter}` } });
  };

  beforeAll(async () => {
    forge = await startFakeForge();
    keyDir = mkdtempSync(join(tmpdir(), 'gh-app-us002-'));
    const keyFile = join(keyDir, 'app.pem');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, { GITHUB_API_URL: forge.url, GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet' });

    await resetDb();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = fixtureDb(moduleRef);
    jobs = moduleRef.get(FleetJobsService);
    jobRepo = moduleRef.get(FLEET_JOB_REPOSITORY);
    schedules = moduleRef.get(SchedulesService);
    configJobs = moduleRef.get(ConfigJobsService);
    outcomes = moduleRef.get(FleetJobOutcomeRecorder);
    effects = moduleRef.get(FleetJobTicketEffects);
    ticketEvents = moduleRef.get(FleetTicketEventRecorder);

    counter += 1;
    slug = `p${counter}`;
    key = `P${counter}`;
    const project = await prisma.project.create({ data: { name: slug, slug, key } });
    projectId = project.id;
    const user = await prisma.user.create({ data: { email: `u${counter}@koda.test`, name: 'U', passwordHash: 'x' } });
    userId = user.id;
    // The admin is an admin through bindings only: the baseline plus the global admin binding, whose
    // mirror keeps `User.role` at `ADMIN`.
    await grantBaseline(prisma, { type: 'USER', id: userId });
    await grantRole(prisma, { type: 'USER', id: userId }, 'admin', null);
    const agent = await prisma.agent.create({ data: { name: 'Builder', slug: `builder${counter}`, apiKeyHash: `hash-${counter}` } });
    agentId = agent.id;
    await grantBaseline(prisma, { type: 'AGENT', id: agentId });
    const repo = await prisma.fleetRepo.create({
      data: { projectId, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: BigInt(77), createdById: userId },
    });
    repoId = repo.id;
  });

  afterAll(async () => {
    await moduleRef.close();
    await forge.close();
    rmSync(keyDir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(() => {
    forge.routes.clear();
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_1', expires_at: '2099-01-01T00:00:00Z' } }));
    forge.routes.set('GET /repos/acme/app/git/ref/heads/trunk', () => ({ status: 200, body: { object: { sha: HEAD } } }));
    forge.routes.set(`GET /repos/acme/app/git/trees/${HEAD}`, () => ({ status: 200, body: { truncated: false, tree: [] } }));
  });

  // -------------------------------------------------------------------------
  // The sentinel: the booted application's client refuses a context-less write
  // -------------------------------------------------------------------------

  it('writes need an action context', async () => {
    await expect(expectGuardActive(moduleRef)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The sentinel: every fixture principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: userId },
      { type: 'AGENT', id: agentId },
    ]);
  });

  it('AC-1: an agent dispatch stores requestedById the agent and requestedByType AGENT', async () => {
    const result = await runWithActor({ type: 'AGENT', id: agentId }, () => jobs.dispatch(agentId, projectId, dispatchDto('agent-dispatch')));

    const row = await prisma.fleetJob.findUniqueOrThrow({ where: { id: result.job.id } });
    expect(row).toEqual(expect.objectContaining({ requestedById: agentId, requestedByType: 'AGENT' }));
  });

  it('AC-2: a user dispatch inside its actor context stores requestedByType USER', async () => {
    const result = await withTestActor({ type: 'USER', id: userId }, () =>
      jobs.dispatch(userId, projectId, dispatchDto('user-dispatch')));

    const row = await prisma.fleetJob.findUniqueOrThrow({ where: { id: result.job.id } });
    expect(row).toEqual(expect.objectContaining({ requestedById: userId, requestedByType: 'USER' }));
  });

  it('AC-3 (US-008): a user dispatch with no action context rejects with ContextlessWriteError and stores no job', async () => {
    const before = await prisma.fleetJob.count();

    await expect(jobs.dispatch(userId, projectId, dispatchDto('context-less-dispatch')))
      .rejects.toBeInstanceOf(ContextlessWriteError);

    // The guard refuses before `query` runs, so the transaction wrote nothing.
    await expect(prisma.fleetJob.count()).resolves.toBe(before);
    await expect(prisma.fleetJob.count({ where: { feature: 'context-less-dispatch' } })).resolves.toBe(0);
  });

  it('AC-3: an agent schedule create stores createdById the agent and createdByType AGENT', async () => {
    const dto = await runWithActor({ type: 'AGENT', id: agentId }, () => schedules.create(agentId, projectId, scheduleDto('agent-schedule')));

    const row = await prisma.jobSchedule.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row).toEqual(expect.objectContaining({ createdById: agentId, createdByType: 'AGENT' }));
  });

  it('AC-4: an agent drift check stores a job with requestedByType AGENT', async () => {
    const result = await runWithActor({ type: 'AGENT', id: agentId }, () => configJobs.submitDrift(agentId, projectId, repoId));

    const row = await prisma.fleetJob.findUniqueOrThrow({ where: { id: result.job.id } });
    expect(row).toEqual(expect.objectContaining({ requestedById: agentId, requestedByType: 'AGENT' }));
  });

  it('AC-5: onTerminal writes no FLEET_JOB_OUTCOME outbox row for a FAILED job an agent requested', async () => {
    const job = await newJob({ state: 'FAILED', requestedById: agentId, requestedByType: 'AGENT' });

    const record = await jobRepo.findById(job.id);
    // The recorder is the job transition's effect: here the server-side `job` component reports it.
    await withTestActor({ type: 'SYSTEM', id: 'job' }, () => outcomes.onTerminal(record as never));

    expect(await prisma.outboxEvent.count({ where: { type: 'fleet_job_outcome', eventId: `${job.id}:${job.leaseEpoch}` } })).toBe(0);
  });

  it('AC-6: onTerminal writes one FLEET_JOB_OUTCOME outbox row for the same FAILED job requested by a user', async () => {
    const job = await newJob({ state: 'FAILED', requestedByType: 'USER' });

    const record = await jobRepo.findById(job.id);
    await withTestActor({ type: 'SYSTEM', id: 'job' }, () => outcomes.onTerminal(record as never));

    expect(await prisma.outboxEvent.count({ where: { type: 'fleet_job_outcome', eventId: `${job.id}:${job.leaseEpoch}` } })).toBe(1);
  });

  it('AC-13: an agent cancelling its own QUEUED job writes an AGENT activity row with no responsible user', async () => {
    const job = await newJob({ requestedById: agentId, requestedByType: 'AGENT', feature: 'cancel-agent' });

    await runWithActor({ type: 'AGENT', id: agentId }, () => jobs.cancel(agentId, projectId, job.id, true));

    const rows = await prisma.fleetActivity.findMany({ where: { jobId: job.id } });
    expect(rows).toEqual([
      expect.objectContaining({ actorType: 'AGENT', actorId: agentId, responsibleUserId: null }),
    ]);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(expect.objectContaining({ state: 'CANCELLED' }));
  });

  it('AC-14: onTerminal records the failure comment of an AGENT-requested job as the agent', async () => {
    const job = await newJob({ state: 'FAILED', requestedById: agentId, requestedByType: 'AGENT', feature: 'effects-agent' });
    const ticket = await newTicket();
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: ticket.id } });

    // The ticket effects run inside that same server-side job transition.
    await withTestActor({ type: 'SYSTEM', id: 'job' }, () => effects.onTerminal([job.id]));

    const comment = await prisma.comment.findFirstOrThrow({ where: { ticketId: ticket.id } });
    expect(comment.body).toContain('FAILED');
    const event = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: ticket.id, action: 'COMMENT_ADDED' } });
    expect(event).toEqual(expect.objectContaining({ actorType: 'agent', actorId: agentId }));
  });

  it('AC-15: the ticket event recorder attributes a context-only write to the agent', async () => {
    const ticket = await newTicket();

    await runWithActor({ type: 'AGENT', id: agentId }, () => ticketEvents.record({
      projectId, ticketId: ticket.id, action: 'TICKET_UPDATED', actorId: agentId, data: { fleetJobUnlinked: 'job-x' },
    }));

    const event = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: ticket.id, action: 'TICKET_UPDATED' } });
    expect(event).toEqual(expect.objectContaining({ actorType: 'agent', actorId: agentId }));
    const outbox = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'ticket_event', eventId: event.id } });
    expect(JSON.parse(outbox.payload)).toEqual(expect.objectContaining({ actorType: 'agent', actorId: agentId }));
  });

  it('keeps the user paths: a schedule a user creates and a user-requested job record USER', async () => {
    const schedule = await withTestActor({ type: 'USER', id: userId }, () =>
      schedules.create(userId, projectId, scheduleDto('user-schedule')));
    expect(await prisma.jobSchedule.findUniqueOrThrow({ where: { id: schedule.id } }))
      .toEqual(expect.objectContaining({ createdById: userId, createdByType: 'USER' }));

    const job = await newJob({ state: 'FAILED', requestedByType: 'USER', feature: 'effects-user' });
    const ticket = await newTicket();
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: ticket.id } });
    await runWithActor({ type: 'USER', id: userId }, () => effects.onTerminal([job.id]));
    const event = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: ticket.id, action: 'COMMENT_ADDED' } });
    expect(event).toEqual(expect.objectContaining({ actorType: 'user', actorId: userId }));
  });
});
