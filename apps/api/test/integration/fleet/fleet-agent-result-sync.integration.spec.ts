import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('fleet AGENT result sync and GET (PG, US-006)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };

  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync')
      .set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody(over)).expect(200));
  const event = (seq: number, payload: object) => ({ seq, type: 'snapshot' as const, payload });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'agent-result-runner');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('stores a valid snapshot from a held AGENT runner and returns it from authenticated job GET', async () => {
    const result = {
      status: 'completed', model: 'acp:claude', output: 'Review complete', truncated: false,
      deniedAsks: [{ kind: 'question', text: 'Which spec?' }], deniedAsksTruncated: false, costUsd: '0.0100',
    };
    const job = await prisma.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'AGENT', feature: 'agent-result-sync',
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev,
      runnerId: runner.runnerId, state: 'RUNNING', leaseEpoch: 1, startedAt: new Date(),
      agentInput: { name: 'spec-reviewer', task: 'Review this spec' },
    } });

    const response = await sync({ jobs: [{ jobId: job.id, leaseEpoch: 1, events: [event(1, { agentResult: result })] }] });
    expect(response.jobAcks).toEqual([{ jobId: job.id, ackedSeq: 1 }]);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(expect.objectContaining({ agentResult: result }));

    const dto = data<Record<string, unknown>>(await request(server).get(`/api/projects/web/fleet/jobs/${job.id}`)
      .set({ Authorization: `Bearer ${world.tokens.dev}` }).expect(200));
    expect(dto).toEqual(expect.objectContaining({ id: job.id, command: 'AGENT', agentResult: result }));
  });
});
