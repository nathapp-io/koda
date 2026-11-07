import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-004 — the flow fields of a job (`flowId`, `flowStep`) written at dispatch, and the conditional
 * adoption of an existing job (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-flow-fields.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { FLEET_JOB_REPOSITORY, type IFleetJobRepository } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import type { DispatchFleetJobDto } from '../../../src/fleet/jobs/dto/dispatch-fleet-job.dto';
import { fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

vi.setConfig({ testTimeout: 30_000 });

interface FlowFieldsRow { flowId: string | null; flowStep: string | null }

describeIntegration('fleet job flow fields (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let jobs: FleetJobsService;
  let repository: IFleetJobRepository;
  let projectId: string;
  let repoId: string;
  let userId: string;
  let flowId: string;
  let otherFlowId: string;

  /** A PLAN job the flow engine dispatches: the flow's branch as `ref`, its spec as `planFrom`. */
  const planDto = (feature: string): DispatchFleetJobDto => ({
    repoId, command: 'PLAN', feature, ref: 'feat/x', planFrom: `.nax/features/${feature}/spec.md`,
    profiles: [], maxCostUsd: 5, bashMode: 'raw', approvalTimeoutSec: 600,
  } as DispatchFleetJobDto);

  const dispatch = (feature: string, opts: Parameters<FleetJobsService['dispatch']>[3] = {}) =>
    withTestActor({ type: 'USER', id: userId }, () => jobs.dispatch(userId, projectId, planDto(feature), opts));

  const createFlow = async (branch: string): Promise<string> => {
    const flow = await db.fleetFlow.create({
      data: {
        projectId, repoId, entry: 'NAX', createdByType: 'USER', createdById: userId, branch, specSha: 'a'.repeat(40),
        reviewerRole: 'opus', supervisorRole: 'native:fast', costCapUsd: new Prisma.Decimal(25),
      },
    });
    return flow.id;
  };

  const rowOf = async (jobId: string): Promise<FlowFieldsRow> =>
    db.fleetJob.findUniqueOrThrow({ where: { id: jobId }, select: { flowId: true, flowStep: true } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    const base = await seedFleetBase(db);
    ({ projectId, repoId } = base);
    userId = base.adminId;
    jobs = app.get(FleetJobsService);
    repository = app.get<IFleetJobRepository>(FLEET_JOB_REPOSITORY);
    flowId = await createFlow('feat/x');
    otherFlowId = await createFlow('feat/other');
  });
  afterAll(async () => {
    await app.close();
  });

  it('AC-1: dispatch with a flowId and flowStep stores both on the created job', async () => {
    const res = await dispatch('flow-plan', { flowId, flowStep: 'PLAN', auditKey: 'system.flow.advance' });

    expect(await rowOf(res.job.id)).toEqual({ flowId, flowStep: 'PLAN' });
    const audit = await db.auditEntry.findFirstOrThrow({ where: { resourceId: res.job.id, resourceType: 'fleet-job' } });
    expect(audit.key).toBe('system.flow.advance');
  });

  it('AC-2: dispatch without a flowId stores null flowId and flowStep', async () => {
    const res = await dispatch('no-flow');

    expect(await rowOf(res.job.id)).toEqual({ flowId: null, flowStep: null });
  });

  it('AC-3: a job created with a flowId reads back through findById with flowId and flowStep', async () => {
    const res = await dispatch('flow-read', { flowId, flowStep: 'SPEC_REVIEW' });

    expect(await repository.findById(res.job.id)).toEqual(expect.objectContaining({ flowId, flowStep: 'SPEC_REVIEW' }));
  });

  it('AC-4: adoptForFlow links a job that has no flow and reports true', async () => {
    const res = await dispatch('flow-adopt');

    await expect(withTestActor({ type: 'SYSTEM', id: 'flow' }, () => jobs.adoptForFlow(res.job.id, otherFlowId, 'REVIEW')))
      .resolves.toBe(true);
    expect(await rowOf(res.job.id)).toEqual({ flowId: otherFlowId, flowStep: 'REVIEW' });
  });

  it('AC-5: adoptForFlow writes nothing and reports false when the job belongs to another flow', async () => {
    const res = await dispatch('flow-adopt-taken', { flowId, flowStep: 'PLAN' });

    await expect(withTestActor({ type: 'SYSTEM', id: 'flow' }, () => jobs.adoptForFlow(res.job.id, otherFlowId, 'REVIEW')))
      .resolves.toBe(false);
    expect(await rowOf(res.job.id)).toEqual({ flowId, flowStep: 'PLAN' });
  });
});
