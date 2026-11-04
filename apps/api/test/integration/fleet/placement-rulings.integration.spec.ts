import { canRunDbTests } from '../../helpers/test-environment';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, type FleetHttpWorld, FLEET_CAPS, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('FIX ruling placement (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    runner = await enrollRunner(app.getHttpServer(), world.tokens.root, 'rulings-runner', {
      capabilities: { ...FLEET_CAPS, botReview: true, botFix: true },
    });
  });
  afterAll(async () => { await app?.close(); });

  it('AC-7 leaves a FIX queued with bot_rulings when the only runner lacks support', async () => {
    const now = new Date();
    const job = await prisma.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'FIX', feature: 'review-pr-42',
      profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: world.ids.dev, state: 'QUEUED',
      prRulings: { headSha: 'a'.repeat(40), rulings: [{ rulingId: 'ruling-1', item: 'D-1', ruling: 'confirm: checked test', by: 'koda:user:Dev', at: now.toISOString() }] },
    } });
    const placement = asTestActor(app.get(PlacementService), { type: 'USER', id: world.ids.dev });
    const result = await placement.placeJob(job.id, now);
    expect(result.assigned).toBe(false);
    expect(result.misfits).toEqual([{ runnerId: runner.runnerId, name: 'rulings-runner', reason: 'bot_rulings' }]);
    expect(await placement.fillRunner(runner.runnerId, 1, now)).toBe(0);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'QUEUED', runnerId: null });
    expect(await prisma.fleetCommand.count({ where: { jobId: job.id, type: 'ASSIGN' } })).toBe(0);
  });
});
