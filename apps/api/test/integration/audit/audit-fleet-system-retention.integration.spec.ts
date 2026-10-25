import { canRunDbTests } from '../../helpers/test-environment';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { FleetLogRetentionProcessor } from '../../../src/fleet/logs/fleet-log-retention.processor';
import { EnrollmentRetentionProcessor } from '../../../src/fleet/runners/enrollment-retention.processor';
import { FleetPrStateRefresher } from '../../../src/fleet/tickets/fleet-pr-state.refresher';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';

const describeDb = canRunDbTests() ? describe : describe.skip;
const DAY = 86_400_000;

describeDb('fleet system retention audit (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let config: IFleetConfig;
  let originalRetentionDays: number | null;
  let n = 0;
  const priorRetention = process.env.FLEET_ENROLLMENT_RETENTION_DAYS;
  const rows = (id: string, key: string) => prisma.auditEntry.findMany({ where: { resourceId: id, key } });

  beforeAll(async () => {
    process.env.FLEET_ENROLLMENT_RETENTION_DAYS = '7';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    config = app.get<IFleetConfig>(FLEET_CFG, { strict: false });
    originalRetentionDays = config.enrollmentRetentionDays;
  });
  beforeEach(async () => {
    await prisma.auditEntry.deleteMany();
    await prisma.runnerEnrollment.deleteMany();
    await prisma.ticketLink.updateMany({ where: { source: 'fleet' }, data: { prState: 'merged' } });
  });
  afterAll(async () => {
    config.enrollmentRetentionDays = originalRetentionDays;
    await app.close();
    if (priorRetention === undefined) delete process.env.FLEET_ENROLLMENT_RETENTION_DAYS;
    else process.env.FLEET_ENROLLMENT_RETENTION_DAYS = priorRetention;
  });

  const makeJob = async () => prisma.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `retention-${++n}`, profiles: [], selectorLabels: [],
    maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1, finishedAt: new Date(Date.now() - 40 * DAY),
  } });
  const makeSpentEnrollment = () => prisma.runnerEnrollment.create({ data: {
    tokenHash: `hash-${++n}`, labels: [], expiresAt: new Date(Date.now() - 40 * DAY), usedAt: new Date(Date.now() - 30 * DAY), createdById: world.ids.dev,
  } });

  it('AC-1/2/3: logs audit only locked jobs and roll back row expiry on audit rejection', async () => {
    const retention = app.get(FleetLogRetentionProcessor);
    const old = await makeJob();
    await prisma.fleetJobLog.create({ data: { jobId: old.id, leaseEpoch: 1, stream: 'run', sizeBytes: 1n, complete: true } });
    const now = new Date();
    const purge = () => withTestActor({ type: 'SYSTEM', id: 'log' }, () => retention.purge(new Date(now.getTime() - 20 * DAY), now));
    await purge();
    expect(await rows(old.id, 'system.log.retention')).toMatchObject([{
      key: 'system.log.retention', resourceType: 'fleet-job', projectId: world.projectId, actorType: 'SYSTEM', actorId: 'log', origin: 'system', summary: 'logs expired through epoch 1',
    }]);
    const before = await prisma.auditEntry.count({ where: { key: 'system.log.retention' } });
    await purge();
    expect(await prisma.auditEntry.count({ where: { key: 'system.log.retention' } })).toBe(before);

    const failing = await makeJob();
    await prisma.fleetJobLog.create({ data: { jobId: failing.id, leaseEpoch: 1, stream: 'run', sizeBytes: 1n, complete: true } });
    vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(withTestActor({ type: 'SYSTEM', id: 'log' }, () => retention.purge(new Date(now.getTime() - 20 * DAY), now)))
      .resolves.toEqual({ expired: 0, failed: 1 });
    expect(await prisma.fleetJobLog.findFirstOrThrow({ where: { jobId: failing.id } })).toMatchObject({ expiredAt: null });
    vi.restoreAllMocks();
  });

  it('AC-4/5/6/7: enrollment purges audit only nonempty deletion and rollback on rejection', async () => {
    const retention = app.get(EnrollmentRetentionProcessor);
    config.enrollmentRetentionDays = 7;
    await makeSpentEnrollment(); await makeSpentEnrollment();
    await retention.scheduledPurge();
    expect(await rows('all', 'system.enrollment.retention')).toMatchObject([{
      key: 'system.enrollment.retention', resourceType: 'fleet-enrollment', resourceId: 'all', projectId: null,
      actorType: 'SYSTEM', actorId: 'enrollment', origin: 'system', summary: 'purged 2 spent enrollments',
    }]);
    const count = await prisma.auditEntry.count({ where: { key: 'system.enrollment.retention' } });
    await retention.scheduledPurge();
    expect(await prisma.auditEntry.count({ where: { key: 'system.enrollment.retention' } })).toBe(count);

    const preserve = await makeSpentEnrollment();
    config.enrollmentRetentionDays = null;
    const auditCountBeforeDisabled = await prisma.auditEntry.count({ where: { key: 'system.enrollment.retention' } });
    await retention.scheduledPurge();
    expect(await prisma.runnerEnrollment.findUnique({ where: { id: preserve.id } })).not.toBeNull();
    expect(await prisma.auditEntry.count({ where: { key: 'system.enrollment.retention' } })).toBe(auditCountBeforeDisabled);
    config.enrollmentRetentionDays = 7;
    const rejected = await makeSpentEnrollment();
    const rejectedAlso = await makeSpentEnrollment();
    vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await retention.scheduledPurge();
    expect(await prisma.runnerEnrollment.findMany({ where: { id: { in: [rejected.id, rejectedAlso.id] } } })).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('AC-8/9/10/11/12: non-merge PR state changes audit atomically; unchanged and merged updates do not', async () => {
    const refresher = app.get(FleetPrStateRefresher);
    const github = app.get(GitHubAppClient);
    vi.spyOn(github, 'mintInstallationToken').mockResolvedValue({ token: 'test-token', expiresAt: new Date(Date.now() + DAY) });
    const getPr = vi.spyOn(github, 'getPullRequest');
    const makeLink = async (prNumber: number, prState: 'open' | 'merged' = 'open') => {
      const ticket = await prisma.ticket.create({ data: { projectId: world.projectId, number: ++n, type: 'TASK', title: 'retention link', status: 'IN_PROGRESS' } });
      const link = await prisma.ticketLink.create({ data: {
        ticketId: ticket.id, url: `https://github.com/acme/app/pull/${prNumber}`, provider: 'github', linkType: 'pr', source: 'fleet',
        jobId: (await makeJob()).id, prNumber, externalRef: `acme/app#${prNumber}`, prState, prUpdatedAt: new Date(0),
      } });
      return { ticket, link };
    };
    const { link } = await makeLink(701);
    getPr.mockResolvedValue({ number: 701, state: 'closed', draft: false, merged: false, mergedAt: null, mergedBy: null, mergeSha: null, url: link.url, title: 't' });
    await refresher.refresh();
    expect(await rows(link.id, 'system.ticket-link.pr-refresh')).toMatchObject([{
      key: 'system.ticket-link.pr-refresh', resourceType: 'ticket-link', projectId: world.projectId,
      actorType: 'SYSTEM', actorId: 'ticket-link', origin: 'system', summary: 'pr open -> closed',
    }]);

    await prisma.auditEntry.deleteMany();
    const { link: unchanged } = await makeLink(702);
    getPr.mockResolvedValue({ number: 702, state: 'open', draft: false, merged: false, mergedAt: null, mergedBy: null, mergeSha: null, url: unchanged.url, title: 't' });
    await refresher.refresh();
    expect(await rows(unchanged.id, 'system.ticket-link.pr-refresh')).toHaveLength(0);

    const { link: reportedMerged } = await makeLink(703);
    getPr.mockResolvedValue({ number: 703, state: 'closed', draft: false, merged: true, mergedAt: new Date(), mergedBy: 'dev', mergeSha: 'abc', url: reportedMerged.url, title: 't' });
    await refresher.refresh();
    expect(await rows(reportedMerged.id, 'system.ticket-link.pr-refresh')).toHaveLength(0);
    const { link: alreadyMerged } = await makeLink(705, 'merged');
    expect(await rows(alreadyMerged.id, 'system.ticket-link.pr-refresh')).toHaveLength(0);
    await prisma.ticketLink.updateMany({ where: { source: 'fleet' }, data: { prState: 'merged' } });
    const { link: rollback } = await makeLink(704);
    getPr.mockResolvedValue({ number: 704, state: 'closed', draft: false, merged: false, mergedAt: null, mergedBy: null, mergeSha: null, url: rollback.url, title: 't' });
    vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await refresher.refresh();
    expect(await prisma.ticketLink.findUniqueOrThrow({ where: { id: rollback.id } })).toMatchObject({ prState: 'open' });
    vi.restoreAllMocks();
  });
});
