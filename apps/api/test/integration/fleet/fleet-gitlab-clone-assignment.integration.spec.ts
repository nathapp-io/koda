import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-003 (GitLab parity F1): a job assigned on a GitLab repo is cloned from the repo's own host,
 * so a self-hosted instance is addressed the way it stores the repository.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-gitlab-clone-assignment.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner } from '../../helpers/fleet-fixtures';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('fleet GitLab clone assignment (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let placement: PlacementService;
  let adminId: string;
  let projectId: string;

  /** Dispatch reaches `placeJob` for the requester's job, so a direct call runs as that admin. */
  const place = (jobId: string) => withTestActor({ type: 'USER', id: adminId }, () => placement.placeJob(jobId));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    placement = app.get(PlacementService);
    const admin = await prisma.user.create({ data: { email: 'gitlab-clone@koda.test', passwordHash: 'x' } });
    await grantBaseline(prisma, { type: 'USER', id: admin.id });
    await grantRole(prisma, { type: 'USER', id: admin.id }, 'admin', null);
    adminId = admin.id;
    const project = await prisma.project.create({ data: { name: 'gl', slug: 'gl', key: 'GL' } });
    projectId = project.id;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.fleetRepo.deleteMany();
    await prisma.runner.deleteMany();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('US-003 AC-9: assigns a GitLab job with the clone url of the repo host', async () => {
    const repo = await prisma.fleetRepo.create({
      data: {
        projectId, provider: 'gitlab', owner: 'acme', name: 'app', defaultBranch: 'main',
        host: 'https://gitlab.example.com', createdById: adminId,
      },
    });
    await insertRunner(prisma, { capacity: 2 });
    const job = await prisma.fleetJob.create({
      data: {
        projectId, repoId: repo.id, ref: 'main', command: 'RUN', feature: 'gitlab-clone', profiles: ['fast'],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: adminId,
      },
    });

    const outcome = await place(job.id);
    expect(outcome).toEqual(expect.objectContaining({ assigned: true, leaseEpoch: 1 }));

    const commands = await prisma.fleetCommand.findMany({ where: { jobId: job.id, type: 'ASSIGN' } });
    expect(commands).toHaveLength(1);
    expect(commands[0].payload).toEqual(expect.objectContaining({
      repo: expect.objectContaining({
        provider: 'gitlab', owner: 'acme', name: 'app', cloneUrl: 'https://gitlab.example.com/acme/app.git',
      }),
    }));
  });
});
