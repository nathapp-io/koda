import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Review P2 remainder (US-002) — soft-deleting a project stops its VCS polling (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/vcs/vcs-project-deletion.integration.spec.ts
 *
 * Two halves: the repository contract the listener builds on (`deactivateConnectionsForProject`, and the
 * deletion filters the polling reads carry), then the real seam — `ProjectsService.softDeleteById` with
 * the real `EventEmitter2` and the real `VcsProjectDeletionListener`, plus the recovery path when that
 * listener fails (the next polling tick unschedules the connection because `findVcsConnectionById` no
 * longer answers it).
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { IVcsRepository, VCS_REPOSITORY } from '../../../src/vcs/domain/vcs.repository';
import { VcsPollingService } from '../../../src/vcs/vcs-polling.service';
import { ProjectsService } from '../../../src/projects/projects.service';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('project soft-delete deactivates VCS polling (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let repo: IVcsRepository;
  let polling: VcsPollingService;
  let projects: ProjectsService;
  let registry: SchedulerRegistry;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let n = 0;

  /** A project of its own, so a delete never touches the seeded one. */
  const insertProject = async (): Promise<string> => {
    const slug = `vcsdel${++n}`;
    const project = await prisma.project.create({ data: { name: slug, slug, key: `VD${n}` } });
    return project.id;
  };

  const makeConnection = (projectId: string, over: Partial<Prisma.VcsConnectionUncheckedCreateInput> = {}) =>
    prisma.vcsConnection.create({
      data: {
        projectId, provider: 'github', repoOwner: 'acme', repoName: 'widgets', encryptedToken: 'enc',
        syncMode: 'polling', allowedAuthors: '[]', pollingIntervalMs: 600_000, webhookSecret: null, isActive: true,
        ...over,
      },
    });

  const reload = (id: string) => prisma.vcsConnection.findUniqueOrThrow({ where: { id } });
  /** The repository write as the listener runs it: a system component under the quiesce writer. */
  const deactivate = (projectId: string) =>
    withTestActor({ type: 'SYSTEM', id: 'project' }, () => repo.deactivateConnectionsForProject(projectId));
  /** The delete's caller: a REST user, as the delete route runs it. */
  const softDelete = (projectId: string) =>
    withTestActor({ type: 'USER', id: base.adminId }, () => projects.softDeleteById(projectId));
  /** A soft delete that never reached a listener: the row is marked, its rows stay as they were. */
  const markDeleted = (projectId: string) =>
    prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    repo = app.get<IVcsRepository>(VCS_REPOSITORY);
    polling = app.get(VcsPollingService);
    projects = app.get(ProjectsService);
    registry = app.get(SchedulerRegistry);
    base = await seedFleetBase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-7: sets isActive false on the active connection of the deleted project', async () => {
    const projectId = await insertProject();
    const connection = await makeConnection(projectId);

    await deactivate(projectId);

    expect((await reload(connection.id)).isActive).toBe(false);
  });

  it('AC-8: answers the id of the connection it deactivated', async () => {
    const projectId = await insertProject();
    const connection = await makeConnection(projectId);

    expect(await deactivate(projectId)).toEqual([connection.id]);
  });

  it('AC-9: leaves another project\'s active connection alone', async () => {
    const projectId = await insertProject();
    const otherProjectId = await insertProject();
    await makeConnection(projectId);
    const foreign = await makeConnection(otherProjectId);

    await deactivate(projectId);

    expect((await reload(foreign.id)).isActive).toBe(true);
  });

  it('AC-10: findPollingConnections leaves out an active polling connection of a soft-deleted project', async () => {
    const liveProjectId = await insertProject();
    const deletedProjectId = await insertProject();
    const live = await makeConnection(liveProjectId);
    const deleted = await makeConnection(deletedProjectId);
    await markDeleted(deletedProjectId);

    const listed = (await repo.findPollingConnections()).map((connection) => connection.id);

    // The filter is the deletion, not the mode or the flag the live control shares with it.
    expect(listed).toContain(live.id);
    expect(listed).not.toContain(deleted.id);
  });

  it('AC-11: findVcsConnectionById answers null for a connection of a soft-deleted project', async () => {
    const liveProjectId = await insertProject();
    const deletedProjectId = await insertProject();
    const live = await makeConnection(liveProjectId);
    const deleted = await makeConnection(deletedProjectId);
    await markDeleted(deletedProjectId);

    expect(await repo.findVcsConnectionById(deleted.id)).toBeNull();
    expect((await repo.findVcsConnectionById(live.id))?.id).toBe(live.id);
  });

  it('AC-14: a real delete deactivates the connection through the real listener, with one audit entry', async () => {
    const projectId = await insertProject();
    const connection = await makeConnection(projectId);

    await softDelete(projectId);

    expect((await reload(connection.id)).isActive).toBe(false);
    const entries = await prisma.auditEntry.findMany({ where: { key: 'system.project.quiesce', resourceType: 'vcs-connection' } });
    expect(entries.map((entry) => entry.resourceId)).toContain(connection.id);
  });

  it('AC-15: when the listener fails, the next polling tick unschedules the deleted connection', async () => {
    const projectId = await insertProject();
    const connection = await makeConnection(projectId, { pollingIntervalMs: 25 });
    const scheduleName = `vcs-polling-${connection.id}`;
    const scheduled = await repo.findVcsConnectionById(connection.id);
    if (scheduled === null) throw new Error('the connection of a live project must be readable');
    polling.schedulePolling(scheduled);
    expect(registry.getIntervals()).toContain(scheduleName);

    // The listener's transaction fails after the delete committed: nothing is deactivated, nothing logged
    // against the connection, so only the polling read can recover the schedule.
    const failed = vi.spyOn(repo, 'deactivateConnectionsForProject').mockRejectedValueOnce(new Error('quiesce transaction failed'));
    await softDelete(projectId);
    expect(failed).toHaveBeenCalledWith(projectId);
    expect((await reload(connection.id)).isActive).toBe(true);

    await waitUntil(() => !registry.getIntervals().includes(scheduleName));
  });
});

/** Polls until `predicate` holds (the ticker runs out of band), failing with the wait it exhausted. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition still false after ${timeoutMs}ms`);
}
