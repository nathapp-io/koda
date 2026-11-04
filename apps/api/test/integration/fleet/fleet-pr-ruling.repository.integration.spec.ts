import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { FleetPrRulingsService } from '../../../src/fleet/rulings/fleet-pr-rulings.service';
import type { AgentPrincipal } from '../../../src/auth/principal/koda-principal.types';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { createTestPrismaClient, testDatabaseUrl } from '../../helpers/test-prisma';
import { PrismaFleetPrRulingRepository } from '../../../src/fleet/rulings/prisma-fleet-pr-ruling.repository';

(canRunDbTests() ? describe : describe.skip)('fleet PR rulings (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let principal: AgentPrincipal;
  let projectId: string;
  let repoId: string;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    const agent = await db.agent.create({ data: { name: 'Ruler', slug: 'ruler', apiKeyHash: 'ruler-hash' } });
    await grantBaseline(db, { type: 'AGENT', id: agent.id });
    principal = { actorType: 'agent', id: agent.id, slug: agent.slug, status: 'ACTIVE', capabilities: [] };
    const project = await db.project.create({ data: { name: 'Rulings', slug: 'rulings', key: 'RULE' } });
    projectId = project.id;
    const repo = await db.fleetRepo.create({ data: { projectId, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: agent.id } });
    repoId = repo.id;
  });
  afterAll(async () => { await app?.close(); });
  const newJob = (feature: string) => db.fleetJob.create({ data: {
    projectId, repoId, command: 'RUN', feature, ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: principal.id,
    resultPrUrl: 'https://github.com/acme/app/pull/42', workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'review' }] },
  } });
  const create = (jobId: string, text = 'confirm: test green') => withTestActor({ type: 'AGENT', id: principal.id }, () =>
    app.get(FleetPrRulingsService).create(principal, 'rulings', jobId, { itemId: 'D-1', text }));
  it('AC-10: normalizes stored multiline text', async () => {
    const job = await newJob('normalize');
    const ruling = await create(job.id, '\n\nconfirm: ok\nmore evidence');
    expect((await db.fleetPrRuling.findUniqueOrThrow({ where: { id: ruling.id } })).text).toBe('confirm: ok\nmore evidence');
  });
  it('AC-11: stores the agent and RUN target', async () => {
    const job = await newJob('target');
    await create(job.id);
    expect(await db.fleetPrRuling.findMany({ where: { jobId: job.id } })).toEqual([expect.objectContaining({
      state: 'pending', disposition: 'confirmed', actorType: 'AGENT', actorId: principal.id, repoId, prNumber: 42, projectId, itemKind: 'review',
    })]);
  });
  it('AC-12: replaces pending rulings, including concurrent creates', async () => {
    const job = await newJob('replace');
    const first = await create(job.id);
    await Promise.all([create(job.id, 'waive: not needed'), create(job.id, 'override: keep')]);
    expect((await db.fleetPrRuling.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('replaced');
    expect(await db.fleetPrRuling.count({ where: { jobId: job.id, state: 'pending' } })).toBe(1);
    expect(await db.fleetPrRuling.count({ where: { jobId: job.id, state: 'replaced' } })).toBe(2);
  });
  it('AC-13: writes one audit entry with job and actor', async () => {
    const job = await newJob('audit');
    await create(job.id);
    expect(await db.auditEntry.findMany({ where: { resourceId: job.id, key: 'fleet.job.rule' } })).toEqual([expect.objectContaining({
      actorType: 'AGENT', actorId: principal.id, summary: 'ruled D-1: confirmed', projectId,
    })]);
  });
  it('does not replace an already applied ruling', async () => {
    const job = await newJob('applied');
    const first = await create(job.id);
    await db.fleetPrRuling.update({ where: { id: first.id }, data: { state: 'applied' } });
    await expect(create(job.id)).rejects.toMatchObject({ prefix: 'fleet.rulings.settled' });
    expect(await db.fleetPrRuling.count({ where: { jobId: job.id } })).toBe(1);
    expect((await db.fleetPrRuling.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('applied');
  });
  it('rejects a cross-project or unknown target without inserting', async () => {
    const job = await newJob('scope');
    await expect(app.get(FleetPrRulingsService).create(principal, 'other-project', job.id, { itemId: 'D-1', text: 'verified' })).rejects.toThrow();
    await expect(create('missing')).rejects.toThrow();
    expect(await db.fleetPrRuling.count({ where: { jobId: job.id } })).toBe(0);
  });
  it.each(['ready', 'newer', 'applied'])('F1: refuses %s committed after the preflight check', async (change) => {
    const job = await newJob(`stale-${change}`);
    const first = await create(job.id);
    await app.get(FleetPrRulingsService).ruleTarget(projectId, job.id, { itemId: 'D-1', text: 'verified' });
    if (change === 'ready') await db.fleetJob.update({ where: { id: job.id }, data: { workflow: { outcome: 'ready', openItems: [{ id: 'D-1', kind: 'review' }] } } });
    if (change === 'newer') await newJob('superseding-run');
    if (change === 'applied') await db.fleetPrRuling.update({ where: { id: first.id }, data: { state: 'applied' } });
    const prefix = { ready: 'notDraft', newer: 'notLatest', applied: 'settled' }[change];
    await expect(create(job.id)).rejects.toMatchObject({ prefix: `fleet.rulings.${prefix}` });
    expect(await db.fleetPrRuling.findMany({ where: { jobId: job.id } })).toEqual([expect.objectContaining({ id: first.id, state: change === 'applied' ? 'applied' : 'pending' })]);
    expect(await db.auditEntry.count({ where: { resourceId: job.id, key: 'fleet.job.rule' } })).toBe(1);
  });
  it.each(['insert', 'sibling', 'applied'])('F1: locks eligibility against concurrent %s writes until commit', async (change) => {
    const sibling = await newJob(`lock-sibling-${change}`);
    const job = await newJob(`lock-target-${change}`);
    const first = await create(job.id);
    const url = new URL(testDatabaseUrl());
    url.searchParams.set('options', '-c lock_timeout=150ms');
    const connection = createTestPrismaClient(url.toString());
    const repo = app.get(PrismaFleetPrRulingRepository);
    const lock = repo.lockTarget.bind(repo);
    const write = () => change === 'applied'
      ? connection.$executeRawUnsafe('UPDATE "FleetPrRuling" SET state = $1 WHERE id = $2', 'applied', first.id)
      : change === 'sibling'
        ? connection.$executeRawUnsafe('UPDATE "FleetJob" SET "resultPrUrl" = NULL WHERE id = $1', sibling.id)
        : connection.$executeRawUnsafe(`INSERT INTO "FleetJob" (id, "projectId", "repoId", ref, command, feature, profiles, "maxCostUsd", "selectorLabels", "requestedById", "updatedAt")
            SELECT id || '-new', "projectId", "repoId", ref, command, feature || '-new', profiles, "maxCostUsd", "selectorLabels", "requestedById", NOW() FROM "FleetJob" WHERE id = $1`, job.id);
    const spy = vi.spyOn(repo, 'lockTarget').mockImplementationOnce(async (slug, jobId) => {
      const target = await lock(slug, jobId);
      await expect(write()).rejects.toMatchObject({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '55P03' } } } });
      return target;
    });
    try {
      await create(job.id);
      // The identical statement on the independent connection succeeds once the ruling commits.
      await expect(write()).resolves.toBe(1);
    } finally { spy.mockRestore(); await connection.$disconnect(); }
    expect(await db.fleetPrRuling.count({ where: { jobId: job.id } })).toBe(2);
  });
  it('rolls back replacement and insertion when audit fails', async () => {
    const job = await newJob('rollback');
    const first = await create(job.id);
    const spy = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    try { await expect(create(job.id)).rejects.toThrow('audit unavailable'); } finally { spy.mockRestore(); }
    expect(await db.fleetPrRuling.findMany({ where: { jobId: job.id } })).toEqual([expect.objectContaining({ id: first.id, state: 'pending' })]);
  });
});
