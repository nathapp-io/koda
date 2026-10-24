import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b 1c-b — the two DB projections the PROJECT-session code read stands on, against real rows (PG):
 * `PrismaFleetJobRepository.findProjectRepos` (US-003 AC-5: the anchor order `createdAt` asc then `id` asc, one
 * project only, at most 60 rows) and `findThreadTokenScope` (US-002 AC-14: the thread kind and turn action a
 * `repoId` token request is fenced by, null for a job with no thread turn).
 *
 * The unit specs next to the repository stub Prisma; this one lets Postgres order, scope and cap the rows.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-project-code-repository.integration.spec.ts
 */
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import { createTestPrismaClient } from '../../helpers/test-prisma';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const bind = (client: unknown) => new PrismaFleetJobRepository({ client } as unknown as PrismaService<PrismaClient>);

describeIntegration('PrismaFleetJobRepository project-code projections (PG, S5b 1c-b)', () => {
  const prisma = createTestPrismaClient();
  const repo = bind(prisma);
  let creatorId: string;
  let seq = 0;

  const project = async (prefix: string) => {
    const slug = `${prefix}-${++seq}`;
    return prisma.project.create({ data: { name: slug, slug, key: `K${seq}${prefix.slice(0, 1).toUpperCase()}` } });
  };

  /** A fleet repo whose id and `createdAt` the test controls, so ordering is never insertion order. */
  const fleetRepo = (input: {
    id: string; projectId: string; name?: string; createdAt: string; provider?: string; installation?: bigint | null;
  }) => prisma.fleetRepo.create({
    data: {
      id: input.id, projectId: input.projectId, provider: input.provider ?? 'github', owner: 'acme', name: input.name ?? input.id,
      defaultBranch: 'main', githubInstallationId: input.installation === undefined ? BigInt(7) : input.installation,
      createdById: creatorId, createdAt: new Date(input.createdAt),
    },
  });

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'project-code@koda.test', passwordHash: 'x' } });
    creatorId = user.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('US-003 AC-5: returns one project’s repositories, oldest createdAt first with ties by id', async () => {
    const web = await project('order');
    const other = await project('order-other');
    const sameInstant = '2026-02-01T00:00:00.000Z';
    const oldest = await fleetRepo({ id: 'ord-oldest', projectId: web.id, createdAt: '2026-01-01T00:00:00.000Z' });
    // Written in reverse id order on purpose: a tie on `createdAt` is broken by the smallest id, not by insertion.
    const tieB = await fleetRepo({ id: 'ord-tie-b', projectId: web.id, createdAt: sameInstant });
    const tieA = await fleetRepo({ id: 'ord-tie-a', projectId: web.id, createdAt: sameInstant });
    const newest = await fleetRepo({ id: 'ord-newest', projectId: web.id, createdAt: '2026-03-01T00:00:00.000Z' });
    const foreign = await fleetRepo({ id: 'ord-foreign', projectId: other.id, createdAt: '2020-01-01T00:00:00.000Z' });

    const found = await repo.findProjectRepos(web.id);

    expect(found.map((r) => r.id)).toEqual([oldest.id, tieA.id, tieB.id, newest.id]);
    expect(found.map((r) => r.id)).not.toContain(foreign.id);
  });

  it('US-003 AC-5: maps the rows to FleetRepoRef, keeping a GitLab provider and a null installation as stored', async () => {
    const web = await project('mapping');
    await fleetRepo({ id: 'map-github', projectId: web.id, createdAt: '2026-01-01T00:00:00.000Z' });
    await fleetRepo({ id: 'map-gitlab', projectId: web.id, createdAt: '2026-01-02T00:00:00.000Z', provider: 'gitlab', installation: null });

    const found = await repo.findProjectRepos(web.id);

    expect(found).toEqual([
      { id: 'map-github', projectId: web.id, provider: 'github', owner: 'acme', name: 'map-github', defaultBranch: 'main', githubInstallationId: BigInt(7) },
      // The fence and the ASSIGN walk classify these two as unavailable; the projection must not hide that.
      { id: 'map-gitlab', projectId: web.id, provider: 'gitlab', owner: 'acme', name: 'map-gitlab', defaultBranch: 'main', githubInstallationId: null },
    ]);
  });

  it('US-003 AC-5: at most 60 rows of a project with 61, the oldest ones', async () => {
    const web = await project('cap');
    await prisma.fleetRepo.createMany({
      data: Array.from({ length: 61 }, (_unused, i) => ({
        id: `cap-${String(i).padStart(2, '0')}`, projectId: web.id, provider: 'github', owner: 'acme', name: `r${i}`,
        defaultBranch: 'main', githubInstallationId: BigInt(7), createdById: creatorId,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      })),
    });

    const found = await repo.findProjectRepos(web.id);

    expect(found).toHaveLength(60);
    expect(found[0].id).toBe('cap-00');
    expect(found.at(-1)?.id).toBe('cap-59');
  });

  it('US-002 AC-14: reads a PROJECT thread’s SESSION turn, a REPO thread’s kind, and null without a turn', async () => {
    const web = await project('scope');
    const anchor = await fleetRepo({ id: `scope-anchor-${seq}`, projectId: web.id, createdAt: '2026-01-01T00:00:00.000Z' });
    const thread = (kind: string, title: string) => prisma.chatThread.create({
      data: {
        projectId: web.id, kind, repoId: kind === 'PROJECT' ? null : anchor.id, baseRef: kind === 'PROJECT' ? null : 'main',
        feature: kind === 'PROJECT' ? null : 'scope-repo', title, createdById: creatorId, backend: { kind: 'native', model: 'm1' },
        skills: [], specPath: kind === 'PROJECT' ? null : '.nax/features/scope-repo/spec.md',
      },
    });
    const job = async (threadId: string | null, command: string) => prisma.fleetJob.create({
      data: {
        projectId: web.id, repoId: anchor.id, ref: 'main', command, feature: `scope-${command}-${++seq}`, profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(1), requestedById: creatorId, state: 'QUEUED', threadId,
      },
    });

    const projectThread = await thread('PROJECT', 'Project scope');
    const sessionJob = await job(projectThread.id, 'THREAD');
    await prisma.fleetThreadTurn.create({
      data: { jobId: sessionJob.id, threadId: projectThread.id, action: 'SESSION', instructions: 'go', backend: { kind: 'native' }, skills: [], resume: false },
    });
    // A PUBLISH turn is not a session: the fence rejects a repoId request that names this job (US-002 §1c-b-D5).
    const publishTurnJob = await job(projectThread.id, 'THREAD');
    await prisma.fleetThreadTurn.create({
      data: { jobId: publishTurnJob.id, threadId: projectThread.id, action: 'PUBLISH', instructions: 'go', backend: { kind: 'native' }, skills: [], resume: false },
    });
    const repoThread = await thread('REPO', 'Repo scope');
    const repoJob = await job(repoThread.id, 'THREAD');
    await prisma.fleetThreadTurn.create({
      data: { jobId: repoJob.id, threadId: repoThread.id, action: 'SESSION', instructions: 'go', backend: { kind: 'native' }, skills: [], resume: false },
    });
    // A RUN job never has a thread turn.
    const runJob = await job(null, 'RUN');

    expect(await repo.findThreadTokenScope(sessionJob.id)).toEqual({ kind: 'PROJECT', action: 'SESSION' });
    expect(await repo.findThreadTokenScope(publishTurnJob.id)).toEqual({ kind: 'PROJECT', action: 'PUBLISH' });
    expect(await repo.findThreadTokenScope(repoJob.id)).toEqual({ kind: 'REPO', action: 'SESSION' });
    expect(await repo.findThreadTokenScope(runJob.id)).toBeNull();
    expect(await repo.findThreadTokenScope('no-such-job')).toBeNull();
  });
});
