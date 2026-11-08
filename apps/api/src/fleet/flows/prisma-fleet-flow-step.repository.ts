import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type FleetJob as FleetJobRow } from '../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { agentInputOf, agentResultOf, fixOutcomeOf, type FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { PrincipalRef } from '../../permissions/permissions.types';
import type { FlowStep } from './flow-steps';
import type { FlowQuestion } from './flow-calls';
import type { AdvanceableFlow, CreatorAccess, IFleetFlowStepRepository, LatestFlowJob, MarkFlowStepData } from './domain/fleet-flow-step.domain';

@Injectable()
export class PrismaFleetFlowStepRepository implements IFleetFlowStepRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async setSpent(flowId: string, spentUsd: string): Promise<void> {
    await this.db.fleetFlow.update({ where: { id: flowId }, data: { spentUsd: new Prisma.Decimal(spentUsd) } });
  }

  async creatorAccess(ref: PrincipalRef): Promise<CreatorAccess> {
    if (ref.type === 'AGENT') {
      const agent = await this.db.agent.findUnique({ where: { id: ref.id }, select: { id: true } });
      return { exists: agent !== null, disabled: false };
    }
    const user = await this.db.user.findUnique({ where: { id: ref.id }, select: { disabled: true } });
    return user === null ? { exists: false, disabled: false } : { exists: true, disabled: user.disabled };
  }

  async markStep(flowId: string, featureId: string, step: FlowStep, data: MarkFlowStepData): Promise<void> {
    await this.db.fleetFlow.update({ where: { id: flowId }, data: { state: data.flowState } });
    await this.db.fleetFlowFeature.update({
      where: { id: featureId },
      data: { state: 'RUNNING', currentStep: step, ...(data.prNumber !== undefined ? { prNumber: data.prNumber } : {}) },
    });
  }

  async complete(flowId: string, now: Date): Promise<void> {
    await this.db.fleetFlow.update({ where: { id: flowId }, data: { state: 'COMPLETED', endedAt: now } });
    await this.db.fleetFlowFeature.updateMany({ where: { flowId }, data: { state: 'COMPLETED' } });
  }

  async listAdvanceable(limit: number, afterId: string | null): Promise<AdvanceableFlow[]> {
    const rows = await this.db.$queryRaw<Array<{ id: string; createdByType: string; createdById: string }>>(Prisma.sql`
      SELECT flow."id", flow."createdByType", flow."createdById"
        FROM "FleetFlow" AS flow
       WHERE flow."state" IN ('APPROVED', 'RUNNING')
         AND (${afterId}::text IS NULL OR flow."id" > ${afterId})
         AND (SELECT COUNT(*) FROM "FleetFlowFeature" AS feature WHERE feature."flowId" = flow."id") = 1
       ORDER BY flow."id" ASC
       LIMIT ${limit}
    `);
    return rows.map((row) => ({ ...row, createdByType: row.createdByType as AdvanceableFlow['createdByType'] }));
  }

  async latestJob(flowId: string): Promise<FleetJobRecord | null> {
    const row = await this.db.fleetJob.findFirst({ where: { flowId }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }] });
    return row ? this.toJob(row) : null;
  }

  /**
   * One statement, so the row and the status belong to the same snapshot: an ingest that fills a RUN's
   * `resultPrUrl` also marks its attempt settled, in one transaction, and reading the two apart could
   * pair a row from before that commit with a status from after it.
   */
  async latestJobWithIngest(flowId: string): Promise<LatestFlowJob | null> {
    const rows = await this.db.$queryRaw<Array<FleetJobRow & { ingestSettled: boolean }>>(Prisma.sql`
      SELECT job.*, EXISTS (
               SELECT 1
                 FROM "FleetBundleIngest" AS ingest
                WHERE ingest."jobId" = job."id"
                  AND ingest."leaseEpoch" = job."leaseEpoch"
                  AND ingest."status" IN ('done', 'partial', 'failed')
             ) AS "ingestSettled"
        FROM "FleetJob" AS job
       WHERE job."flowId" = ${flowId}
       ORDER BY job."queuedAt" DESC, job."id" DESC
       LIMIT 1
    `);
    const row = rows[0];
    if (!row) return null;
    const { ingestSettled, ...job } = row;
    return { job: this.toJob(job), ingestSettled };
  }

  async latestJobForStep(flowId: string, step: FlowStep): Promise<FleetJobRecord | null> {
    const row = await this.db.fleetJob.findFirst({ where: { flowId, flowStep: step }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }] });
    return row ? this.toJob(row) : null;
  }

  async countJobsForStepSince(flowId: string, step: FlowStep, since: Date): Promise<number> {
    return this.db.fleetJob.count({ where: { flowId, flowStep: step, queuedAt: { gte: since } } });
  }

  async projectSlug(projectId: string): Promise<string | null> {
    const project = await this.db.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { slug: true } });
    return project?.slug ?? null;
  }

  async setBranch(flowId: string, branch: string): Promise<void> {
    await this.db.fleetFlow.update({ where: { id: flowId }, data: { branch } });
  }

  async recordCalls(flowId: string, featureId: string, jobId: string, specSha: string): Promise<void> {
    await this.db.fleetFlowFeature.update({ where: { id: featureId }, data: { callsJobId: jobId } });
    await this.db.fleetFlow.update({ where: { id: flowId }, data: { specSha } });
  }

  async recordRulings(flowId: string, featureId: string, jobId: string): Promise<void> {
    await this.db.fleetFlowFeature.updateMany({ where: { id: featureId, flowId }, data: { rulingsJobId: jobId } });
  }

  async recordPrdEdits(flowId: string, featureId: string, jobId: string): Promise<void> {
    await this.db.fleetFlowFeature.updateMany({ where: { id: featureId, flowId }, data: { prdEditsJobId: jobId } });
  }

  /**
   * The feature waits for the answers to the questions of the review job `jobId`. The answers of an
   * earlier review are cleared with `Prisma.DbNull` (a nullable JSON column keeps its value for a
   * plain `null`), so the stored answers only ever belong to the review that is waited on.
   */
  async setWaiting(flowId: string, featureId: string, input: { jobId: string; questions: FlowQuestion[] }): Promise<void> {
    await this.db.fleetFlow.update({ where: { id: flowId }, data: { state: 'WAITING_ANSWER' } });
    await this.db.fleetFlowFeature.update({
      where: { id: featureId },
      data: {
        questionsJobId: input.jobId,
        questions: input.questions as unknown as Prisma.InputJsonValue,
        state: 'WAITING_ANSWER',
        answers: Prisma.DbNull,
        answeredById: null,
        answeredAt: null,
      },
    });
  }

  async setTicket(flowId: string, ticketId: string): Promise<boolean> {
    const result = await this.db.fleetFlow.updateMany({ where: { id: flowId, ticketId: null }, data: { ticketId } });
    return result.count === 1;
  }

  async sumCost(flowId: string): Promise<string> {
    const totals = await this.db.fleetJob.aggregate({ where: { flowId }, _sum: { costSpentUsd: true, costCarriedUsd: true } });
    return new Prisma.Decimal(totals._sum.costSpentUsd ?? 0)
      .add(totals._sum.costCarriedUsd ?? 0)
      .toFixed(4);
  }

  async ingestSettled(jobId: string, leaseEpoch: number): Promise<boolean> {
    return (await this.db.fleetBundleIngest.findFirst({
      where: { jobId, leaseEpoch, status: { in: ['done', 'partial', 'failed'] } },
      select: { id: true },
    })) !== null;
  }

  private toJob(row: Awaited<ReturnType<typeof this.db.fleetJob.findFirst>> & object): FleetJobRecord {
    const job = row as Record<string, unknown>;
    return {
      ...job,
      maxCostUsd: (job['maxCostUsd'] as Prisma.Decimal).toString(),
      costSpentUsd: (job['costSpentUsd'] as Prisma.Decimal).toString(),
      costCarriedUsd: (job['costCarriedUsd'] as Prisma.Decimal).toString(),
      command: job['command'] as FleetJobRecord['command'],
      state: job['state'] as FleetJobRecord['state'],
      bashMode: job['bashMode'] as FleetJobRecord['bashMode'],
      requestedByType: job['requestedByType'] as FleetJobRecord['requestedByType'],
      fixOutcome: fixOutcomeOf(job['fixOutcome'] as string | null),
      fixReady: job['fixReady'] as FleetJobRecord['fixReady'],
      agentInput: agentInputOf(job['agentInput']),
      agentResult: agentResultOf(job['agentResult']),
      flowId: job['flowId'] as string | null,
      flowStep: job['flowStep'] as string | null,
    } as FleetJobRecord;
  }
}
