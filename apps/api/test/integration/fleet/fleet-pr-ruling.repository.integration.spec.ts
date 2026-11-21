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
  /** US-005: the GitLab repo the MR-number tests read, on its own host. */
  let gitlabRepoId: string;
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
    const gitlabRepo = await db.fleetRepo.create({ data: { projectId, provider: 'gitlab', host: 'https://gitlab.com', owner: 'acme', name: 'gitlab-app', defaultBranch: 'main', createdById: agent.id } });
    gitlabRepoId = gitlabRepo.id;
  });
  afterAll(async () => { await app?.close(); });
  const newJob = (feature: string) => db.fleetJob.create({ data: {
    projectId, repoId, command: 'RUN', feature, ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: principal.id,
    resultPrUrl: 'https://github.com/acme/app/pull/42', workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'review' }] },
  } });
  const newUrlJob = (feature: string, resultPrUrl: string) => db.fleetJob.create({ data: {
    projectId, repoId, command: 'RUN', feature, ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: principal.id,
    resultPrUrl, workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'review' }] },
  } });
  const create = (jobId: string, text = 'confirm: test green') => withTestActor({ type: 'AGENT', id: principal.id }, () =>
    app.get(FleetPrRulingsService).create(principal, 'rulings', jobId, { itemId: 'D-1', text }));

  /** US-005: a RUN job of the GitLab repo whose result URL names the given merge request. */
  const gitlabJob = (feature: string, mr: number) => db.fleetJob.create({ data: {
    projectId, repoId: gitlabRepoId, command: 'RUN', feature, ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: principal.id,
    resultPrUrl: `https://gitlab.com/acme/gitlab-app/-/merge_requests/${mr}`, workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'review' }] },
  } });

  /** A RUN job of the GitLab repo whose stored result URL is exactly the given one. */
  const gitlabUrlJob = (feature: string, resultPrUrl: string) => db.fleetJob.create({ data: {
    projectId, repoId: gitlabRepoId, command: 'RUN', feature, ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: principal.id,
    resultPrUrl, workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'review' }] },
  } });

  it('AC-1: latestRunForPr finds a GitHub PR URL with a trailing slash', async () => {
    const job = await newUrlJob('variant-trailing-slash', 'https://github.com/acme/app/pull/51/');
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(repoId, 51)).resolves.toBe(job.id);
  });

  it('AC-2: latestRunForPr finds a GitHub PR URL with a query string', async () => {
    const job = await newUrlJob('variant-query', 'https://github.com/acme/app/pull/52?w=1');
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(repoId, 52)).resolves.toBe(job.id);
  });

  it('AC-3: latestRunForPr finds a GitHub PR URL with a fragment', async () => {
    const job = await newUrlJob('variant-fragment', 'https://github.com/acme/app/pull/53#discussion_r1');
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(repoId, 53)).resolves.toBe(job.id);
  });

  it('AC-4: latestRunForPr finds a GitLab MR URL with slash and query string', async () => {
    const job = await db.fleetJob.create({ data: {
      projectId, repoId: gitlabRepoId, command: 'RUN', feature: 'variant-gitlab', ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: principal.id,
      resultPrUrl: 'https://gitlab.com/acme/gitlab-app/-/merge_requests/54/?tab=notes', workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'review' }] },
    } });
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(gitlabRepoId, 54)).resolves.toBe(job.id);
  });

  it('AC-5: latestRunForPr chooses a newer trailing-slash URL over a canonical URL', async () => {
    const older = await newUrlJob('variant-newer-older', 'https://github.com/acme/app/pull/55');
    const newer = await newUrlJob('variant-newer-latest', 'https://github.com/acme/app/pull/55/');
    await db.fleetJob.update({ where: { id: newer.id }, data: { createdAt: new Date(older.createdAt.getTime() + 1000) } });
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(repoId, 55)).resolves.toBe(newer.id);
  });

  it('AC-6: latestRunForPr does not match a longer PR number with a query string', async () => {
    await newUrlJob('variant-longer-number', 'https://github.com/acme/app/pull/560?w=1');
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(repoId, 56)).resolves.toBeNull();
  });

  /**
   * Review B1: a stored PR URL is only a candidate when its origin is the repo's own forge host.
   * `prNumberFor` reads the path alone, so a same-path URL from another host would otherwise pass
   * the confirmation and a newer foreign-host RUN would displace the correct one.
   */
  it('B1: latestRunForPr keeps the correct-host RUN when a newer same-path URL names another host', async () => {
    const older = await newUrlJob('variant-foreign-host-older', 'https://github.com/acme/app/pull/58');
    const newer = await newUrlJob('variant-foreign-host-newer', 'https://gitlab.example.com/acme/app/pull/58/');
    await db.fleetJob.update({ where: { id: newer.id }, data: { createdAt: new Date(older.createdAt.getTime() + 1000) } });
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(repoId, 58)).resolves.toBe(older.id);
  });

  it('B1: latestRunForPr does not match a GitHub PR URL from another host', async () => {
    await newUrlJob('variant-foreign-host-only', 'https://gitlab.example.com/acme/app/pull/59/');
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(repoId, 59)).resolves.toBeNull();
  });

  it('B1: latestRunForPr does not match a merge-request URL from another GitLab host', async () => {
    await db.fleetJob.create({ data: {
      projectId, repoId: gitlabRepoId, command: 'RUN', feature: 'variant-foreign-gitlab', ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: principal.id,
      resultPrUrl: 'https://gitlab.example.com/acme/gitlab-app/-/merge_requests/60/', workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'review' }] },
    } });
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(gitlabRepoId, 60)).resolves.toBeNull();
  });

  /**
   * The ready selection (`runsForPr`) reads every RUN of the repo, so it applies the same
   * configured-forge identity as the latest lookup: a supported variant on the configured GitLab
   * host matches, and the same path on another host does not.
   */
  it('AC-4: runsForPr selects a GitLab MR URL variant on the configured host', async () => {
    const job = await gitlabUrlJob('gitlab-variant-ready', 'https://gitlab.com/acme/gitlab-app/-/merge_requests/15/?tab=notes');
    await expect(app.get(PrismaFleetPrRulingRepository).runsForPr(gitlabRepoId, 15)).resolves.toEqual([job.id]);
  });

  it('AC-4: runsForPr skips a merge-request URL from another GitLab host', async () => {
    await gitlabUrlJob('gitlab-foreign-ready', 'https://gitlab.example.com/acme/gitlab-app/-/merge_requests/16/');
    await expect(app.get(PrismaFleetPrRulingRepository).runsForPr(gitlabRepoId, 16)).resolves.toEqual([]);
  });

  /**
   * A stored URL that is not a URL names no PR: neither lookup may read a PR number out of it.
   * The schemeless URL still carries the `/pull/62` suffix the latest lookup pre-filters on, so
   * it reaches the origin check before it is skipped.
   */
  it('AC-4: latestRunForPr and runsForPr skip an unparseable stored URL', async () => {
    await newUrlJob('variant-unparseable', 'github.com/acme/app/pull/62');
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(repoId, 62)).resolves.toBeNull();
    await expect(app.get(PrismaFleetPrRulingRepository).runsForPr(repoId, 62)).resolves.toEqual([]);
  });

  /**
   * A repo row whose configured host is not a URL vouches for no URL at all: without a configured
   * origin every stored URL would be a candidate for the latest, ready and retirement lookups.
   */
  it('AC-4: an unparseable configured host resolves to no PR', async () => {
    const older = await newUrlJob('host-unparseable-older', 'https://github.com/acme/app/pull/63');
    const newer = await newUrlJob('host-unparseable-newer', 'https://github.com/acme/app/pull/63/');
    await db.fleetJob.update({ where: { id: newer.id }, data: { createdAt: new Date(older.createdAt.getTime() + 1000) } });
    const pending = await db.fleetPrRuling.create({ data: {
      projectId, repoId, prNumber: 63, jobId: older.id, itemId: 'D-1', itemKind: 'review', text: 'verified',
      disposition: 'verified', actorType: 'AGENT', actorId: principal.id, state: 'pending',
    } });
    await db.fleetRepo.update({ where: { id: repoId }, data: { host: 'github.com' } });
    try {
      await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(repoId, 63)).resolves.toBeNull();
      await expect(app.get(PrismaFleetPrRulingRepository).runsForPr(repoId, 63)).resolves.toEqual([]);
      await app.get(PrismaFleetPrRulingRepository).replaceOlderRuns(newer.id);
      expect((await db.fleetPrRuling.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('pending');
    } finally {
      await db.fleetRepo.update({ where: { id: repoId }, data: { host: 'https://github.com' } });
    }
  });

  it('AC-5: applies configured origin including port to latest, ready, and retirement lookups', async () => {
    await db.fleetRepo.update({ where: { id: repoId }, data: { host: 'https://github.com:8443' } });
    try {
      const canonical = await newUrlJob('port-canonical', 'https://github.com:8443/acme/app/pull/61');
      const foreignPort = await newUrlJob('port-foreign', 'https://github.com:9443/acme/app/pull/61');
      const newer = new Date(canonical.createdAt.getTime() + 1000);
      await db.fleetJob.update({ where: { id: foreignPort.id }, data: { createdAt: newer } });
      await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(repoId, 61)).resolves.toBe(canonical.id);
      await expect(app.get(PrismaFleetPrRulingRepository).runsForPr(repoId, 61)).resolves.toEqual([canonical.id]);
      const pending = await db.fleetPrRuling.create({ data: {
        projectId, repoId, prNumber: 61, jobId: canonical.id, itemId: 'D-1', itemKind: 'review', text: 'verified',
        disposition: 'verified', actorType: 'AGENT', actorId: principal.id, state: 'pending',
      } });
      await app.get(PrismaFleetPrRulingRepository).replaceOlderRuns(foreignPort.id);
      expect((await db.fleetPrRuling.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('pending');
    } finally {
      await db.fleetRepo.update({ where: { id: repoId }, data: { host: 'https://github.com' } });
    }
  });

  it('AC-7: create accepts the latest draft RUN when its PR URL has a trailing slash', async () => {
    const older = await newUrlJob('ruling-variant-older', 'https://github.com/acme/app/pull/57');
    const newer = await newUrlJob('ruling-variant-newer', 'https://github.com/acme/app/pull/57/');
    await db.fleetJob.update({ where: { id: newer.id }, data: { createdAt: new Date(older.createdAt.getTime() + 1000) } });
    await expect(create(newer.id)).resolves.toMatchObject({ jobId: newer.id, prNumber: 57 });
  });

  it('AC-1: findTarget reads the merge-request number and the repo id and host of a GitLab job', async () => {
    const job = await gitlabJob('gitlab-target', 12);
    const target = await app.get(PrismaFleetPrRulingRepository).findTarget(projectId, job.id);
    expect(target).toMatchObject({ prNumber: 12, repo: { id: gitlabRepoId, host: 'https://gitlab.com', provider: 'gitlab' } });
  });

  it('AC-2: latestRunForPr returns the newest RUN of MR 12 and never the same repo\'s MR 112', async () => {
    const older = await gitlabJob('gitlab-latest-older', 12);
    const newest = await gitlabJob('gitlab-latest-newest', 12);
    // The 112 job must not be matched by the `/merge_requests/12` suffix, nor be the newest hit.
    await gitlabJob('gitlab-latest-112', 112);
    await db.fleetJob.update({ where: { id: newest.id }, data: { createdAt: new Date(older.createdAt.getTime() + 1000) } });
    await expect(app.get(PrismaFleetPrRulingRepository).latestRunForPr(gitlabRepoId, 12)).resolves.toBe(newest.id);
  });

  it('AC-3: runsForPr returns every RUN of MR 12 and no other merge request', async () => {
    const first = await gitlabJob('gitlab-runs-first', 13);
    const second = await gitlabJob('gitlab-runs-second', 13);
    await gitlabJob('gitlab-runs-other', 113);
    const ids = await app.get(PrismaFleetPrRulingRepository).runsForPr(gitlabRepoId, 13);
    expect([...ids].sort()).toEqual([first.id, second.id].sort());
  });

  it('AC-4: replaceOlderRuns replaces an older GitLab RUN\'s pending ruling on the same MR', async () => {
    const older = await gitlabJob('gitlab-replace-older', 14);
    const newer = await gitlabJob('gitlab-replace-newer', 14);
    await db.fleetJob.update({ where: { id: newer.id }, data: { createdAt: new Date(older.createdAt.getTime() + 1000) } });
    const pending = await db.fleetPrRuling.create({ data: {
      projectId, repoId: gitlabRepoId, prNumber: 14, jobId: older.id, itemId: 'D-1', itemKind: 'review', text: 'verified',
      disposition: 'verified', actorType: 'AGENT', actorId: principal.id, state: 'pending',
    } });
    await withTestActor({ type: 'AGENT', id: principal.id }, () => app.get(PrismaFleetPrRulingRepository).replaceOlderRuns(newer.id));
    expect((await db.fleetPrRuling.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('replaced');
  });
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
