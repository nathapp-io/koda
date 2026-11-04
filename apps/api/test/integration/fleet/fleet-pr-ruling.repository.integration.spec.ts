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
    await create(job.id);
    expect((await db.fleetPrRuling.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('applied');
  });
  it('rejects a cross-project or unknown target without inserting', async () => {
    const job = await newJob('scope');
    await expect(app.get(FleetPrRulingsService).create(principal, 'other-project', job.id, { itemId: 'D-1', text: 'verified' })).rejects.toThrow();
    await expect(create('missing')).rejects.toThrow();
    expect(await db.fleetPrRuling.count({ where: { jobId: job.id } })).toBe(0);
  });
  it('rolls back replacement and insertion when audit fails', async () => {
    const job = await newJob('rollback');
    const first = await create(job.id);
    const spy = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    try { await expect(create(job.id)).rejects.toThrow('audit unavailable'); } finally { spy.mockRestore(); }
    expect(await db.fleetPrRuling.findMany({ where: { jobId: job.id } })).toEqual([expect.objectContaining({ id: first.id, state: 'pending' })]);
  });
});
