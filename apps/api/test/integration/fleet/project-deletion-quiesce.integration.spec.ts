import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Review P2 remainder (US-001) — soft-deleting a project cancels its unstarted fleet jobs (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/project-deletion-quiesce.integration.spec.ts
 *
 * Real `EventEmitter2` and the real `ProjectDeletionJobsListener`: `ProjectsService.softDeleteById`
 * emits after its transaction committed, the listener opens a transaction of its own, ends the project's
 * QUEUED (and never-acked ASSIGNED) jobs through `JobTransitionsService`, and the delete resolves once the
 * listeners settled. RUNNING jobs and other projects' jobs are untouched.
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import { fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('project soft-delete quiesce (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let projects: ProjectsService;
  let jobs: FleetJobsService;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let runnerId: string;
  let n = 0;

  /** A project of its own, so a delete never touches the seeded one. */
  const insertProject = async (): Promise<string> => {
    const slug = `quiesce${++n}`;
    const project = await prisma.project.create({ data: { name: slug, slug, key: `Q${n}` } });
    return project.id;
  };

  const insertJob = (projectId: string, state: 'QUEUED' | 'RUNNING', over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `quiesce${++n}`, profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, state,
        ...(state === 'RUNNING' ? { runnerId, leaseEpoch: 1, startedAt: new Date() } : {}), ...over,
      },
    });

  const reload = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  const reloadProject = (id: string) => prisma.project.findUniqueOrThrow({ where: { id } });

  /** The delete's caller: a REST user, as the approval-executed route runs it. */
  const softDelete = (projectId: string) =>
    withTestActor({ type: 'USER', id: base.adminId }, () => projects.softDeleteById(projectId));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    projects = app.get(ProjectsService);
    jobs = app.get(FleetJobsService);
    base = await seedFleetBase(prisma);
    runnerId = (await insertRunner(prisma, { capacity: 10 })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-17/AC-18/AC-19: a real delete cancels the QUEUED job only', async () => {
    const projectId = await insertProject();
    const otherProjectId = await insertProject();
    const queued = await insertJob(projectId, 'QUEUED');
    const running = await insertJob(projectId, 'RUNNING');
    const foreign = await insertJob(otherProjectId, 'QUEUED');

    await softDelete(projectId);

    expect(await reload(queued.id)).toEqual(expect.objectContaining({
      state: 'CANCELLED', stateReason: 'project_deleted', cancelReason: 'project_deleted',
    }));
    expect((await reload(running.id)).state).toBe('RUNNING');
    expect((await reload(foreign.id)).state).toBe('QUEUED');
  });

  it('AC-20: a failing listener leaves the committed soft delete alone', async () => {
    const projectId = await insertProject();
    const queued = await insertJob(projectId, 'QUEUED');
    // The listener's transaction fails after the delete committed: nothing is published, nothing rolled back.
    vi.spyOn(jobs, 'cancelForProjectDelete').mockRejectedValueOnce(new Error('quiesce transaction failed'));

    const deleted = await softDelete(projectId);

    expect(deleted.id).toBe(projectId);
    expect(deleted.deletedAt).not.toBeNull();
    expect((await reloadProject(projectId)).deletedAt).not.toBeNull();
    // The listener never ran to completion, so the job it would have cancelled is untouched.
    expect((await reload(queued.id)).state).toBe('QUEUED');
  });
});
