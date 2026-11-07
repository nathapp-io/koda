import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-005 AC-13 — an AGENT job is placed only on a runner that reports `agentsRun`, on PG.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/placement-agents-run.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase, FLEET_CAPS } from '../../helpers/fleet-fixtures';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('AGENT placement needs agentsRun (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let placement: PlacementService;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;

  /** Dispatch reaches `placeJob` for the requester's job, so a direct call runs as that admin. */
  const place = (jobId: string) => withTestActor({ type: 'USER', id: base.adminId }, () => placement.placeJob(jobId));
  const queueAgent = (feature: string) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'AGENT', feature, profiles: ['fast'],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId,
      agentInput: { name: 'spec-reviewer', task: 'x' },
    },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    placement = app.get(PlacementService);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.runner.deleteMany();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('leaves an otherwise placeable AGENT job QUEUED with agents_run, then assigns it once the runner reports agentsRun', async () => {
    // A runner that fits everything about the job except the AGENT capability.
    const runner = await insertRunner(prisma);
    const job = await queueAgent('flow-a');

    const blocked = await place(job.id);
    expect(blocked.assigned).toBe(false);
    expect(blocked.runnerId).toBeNull();
    expect(blocked.misfits).toEqual([expect.objectContaining({ runnerId: runner.id, reason: 'agents_run' })]);
    expect(await prisma.fleetCommand.count({ where: { jobId: job.id } })).toBe(0);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe('QUEUED');

    // The same runner after an upgrade: the misfit was the only thing holding the job.
    const upgraded = { ...FLEET_CAPS, agentsRun: true as const };
    await prisma.runner.update({ where: { id: runner.id }, data: { capabilities: upgraded as object } });
    const placed = await place(job.id);
    expect(placed).toEqual(expect.objectContaining({ assigned: true, runnerId: runner.id }));
    const assigned = await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(assigned.state).toBe('ASSIGNED');
    const [command] = await prisma.fleetCommand.findMany({ where: { jobId: job.id } });
    expect(command.payload).toEqual(expect.objectContaining({
      jobId: job.id, command: 'AGENT', agent: { name: 'spec-reviewer', task: 'x' },
    }));
    expect(command.payload).not.toHaveProperty('review');
  });
});
