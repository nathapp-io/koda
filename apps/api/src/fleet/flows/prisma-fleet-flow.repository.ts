import { posix } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { resolvePageOption, type IPageOption } from '@nathapp/nestjs-common';
import { AbstractPrismaRepository, Paginate, PrismaService, type PrismaModelDelegate } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER, type IPageResult, type ITransactionManager } from '@nathapp/nestjs-data';
import { Prisma, type FleetFlow as FleetFlowRow, type FleetFlowFeature as FleetFlowFeatureRow, type PrismaClient } from '../../generated/prisma/client';
import { canTransitionFlow, FleetFlowState, isLiveFlowState } from './flow-states';
import { FlowTransitionError, type CreateFleetFlow, type FleetFlowFeatureRecord, type FleetFlowRecord, type IFleetFlowRepository } from './domain/fleet-flow.domain';
import type { FlowAnswer, FlowQuestion } from './flow-calls';

const PAGE_SIZE_MAX = 100;

@Injectable()
export class PrismaFleetFlowRepository extends AbstractPrismaRepository<FleetFlowRecord, FleetFlowRow, string> implements IFleetFlowRepository {
  constructor(@Inject(TRANSACTION_MANAGER) private readonly transactionManager: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) { super(transactionManager); }

  protected modelDelegate(client: unknown): PrismaModelDelegate<FleetFlowRow, string> {
    return (client as Record<string, unknown>).fleetFlow as PrismaModelDelegate<FleetFlowRow, string>;
  }
  protected toDomain(row: FleetFlowRow & { features?: FleetFlowFeatureRow[] }): FleetFlowRecord {
    return { ...row, costCapUsd: row.costCapUsd.toFixed(4), spentUsd: row.spentUsd.toFixed(4), entry: row.entry as FleetFlowRecord['entry'], createdByType: row.createdByType as FleetFlowRecord['createdByType'], state: row.state as FleetFlowRecord['state'], approvalMode: row.approvalMode as FleetFlowRecord['approvalMode'], features: [...(row.features ?? [])].sort((a, b) => a.position - b.position).map((feature) => this.toFeature(feature)) };
  }
  /** The questions and the answers are JSON columns: an array when the column holds one, null when it is empty. */
  private toFeature(row: FleetFlowFeatureRow): FleetFlowFeatureRecord {
    return { ...row, questions: jsonArray<FlowQuestion>(row.questions), answers: jsonArray<FlowAnswer>(row.answers) };
  }
  protected toPersistenceCreate(record: FleetFlowRecord) { return { ...record }; }
  protected toPersistenceUpdate(patch: Partial<FleetFlowRecord>) { return { ...patch }; }

  async create(data: CreateFleetFlow): Promise<FleetFlowRecord> {
    return this.toDomain(await this.prisma.client.fleetFlow.create({ data: {
      projectId: data.projectId, repoId: data.repoId, threadId: data.threadId ?? null, entry: data.entry,
      createdByType: data.createdByType, createdById: data.createdById, branch: data.branch, specSha: data.specSha,
      // US-001: a new flow's set sha is the sha it was approved with.
      setSha: data.specSha,
      pinnedRunnerId: data.pinnedRunnerId ?? null, reviewerRole: data.reviewerRole, supervisorRole: data.supervisorRole,
      costCapUsd: data.costCapUsd, approvalMode: data.approvalMode ?? null,
      features: { create: data.features.map(({ feature, specPath, dependsOn }, position) => ({ position, feature, specPath: posix.normalize(specPath), dependsOn, state: 'PENDING' })) },
    }, include: { features: true } }));
  }
  async findById(id: string): Promise<FleetFlowRecord | null> {
    const row = await this.prisma.client.fleetFlow.findUnique({ where: { id }, include: { features: { orderBy: { position: 'asc' } } } });
    return row ? this.toDomain(row) : null;
  }
  async lockById(id: string): Promise<FleetFlowRecord | null> {
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "FleetFlow" WHERE id = ${id} FOR UPDATE`);
    return rows.length ? this.findById(id) : null;
  }
  async findPage(filters: { projectId: string }, page: IPageOption): Promise<IPageResult<FleetFlowRecord>> {
    const { current, size } = resolvePageOption(page, PAGE_SIZE_MAX);
    const result = await Paginate(this.prisma.client.fleetFlow, { current, size }, { where: { projectId: filters.projectId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { features: { orderBy: { position: 'asc' } } } });
    return result.remap((row) => this.toDomain(row));
  }
  async findLiveForThread(threadId: string): Promise<FleetFlowRecord | null> {
    const rows = await this.prisma.client.fleetFlow.findMany({ where: { threadId, state: { notIn: [FleetFlowState.COMPLETED, FleetFlowState.STOPPED] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, include: { features: { orderBy: { position: 'asc' } } } });
    const row = rows[0]; return row && isLiveFlowState(row.state) ? this.toDomain(row) : null;
  }
  async findLiveForSpec(repoId: string, branch: string, specSha: string): Promise<FleetFlowRecord | null> {
    const rows = await this.prisma.client.fleetFlow.findMany({ where: { repoId, branch, specSha, state: { notIn: [FleetFlowState.COMPLETED, FleetFlowState.STOPPED] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, include: { features: { orderBy: { position: 'asc' } } } });
    const row = rows[0]; return row && isLiveFlowState(row.state) ? this.toDomain(row) : null;
  }
  private async transition(id: string, target: FleetFlowRecord['state'], data: Prisma.FleetFlowUpdateInput): Promise<FleetFlowRecord> {
    const result = await this.transactionManager.run(async () => {
      const current = await this.lockById(id);
      if (!current) throw new FlowTransitionError(id, 'missing', target);
      if (!canTransitionFlow(current.state, target)) throw new FlowTransitionError(id, current.state, target);
      await this.prisma.client.fleetFlow.update({ where: { id }, data });
      if (target === FleetFlowState.STOPPED) {
        await this.prisma.client.fleetFlowFeature.updateMany({ where: { flowId: id }, data: { state: 'STOPPED' } });
      } else if (target === FleetFlowState.PENDING) {
        await this.prisma.client.fleetFlowFeature.updateMany({ where: { flowId: id }, data: { state: 'PENDING', currentStep: null } });
      }
      return this.findById(id);
    });
    if (!result) throw new FlowTransitionError(id, 'missing', target);
    return result;
  }
  approve(id: string, data: { mode: FleetFlowRecord['approvalMode'] & string; approverId: string; approvedAt: Date; approvalRequestId: string | null }): Promise<FleetFlowRecord> {
    return this.transition(id, FleetFlowState.APPROVED, { state: FleetFlowState.APPROVED, approvalMode: data.mode, approverId: data.approverId, approvedAt: data.approvedAt, approvalRequestId: data.approvalRequestId });
  }
  async setApprovalRequestId(id: string, approvalRequestId: string): Promise<FleetFlowRecord> {
    const result = await this.transactionManager.run(async () => {
      const current = await this.lockById(id);
      if (!current) throw new FlowTransitionError(id, 'missing', 'same-state');
      await this.prisma.client.fleetFlow.update({ where: { id }, data: { approvalRequestId } });
      return this.findById(id);
    });
    if (!result) throw new FlowTransitionError(id, 'missing', 'same-state');
    return result;
  }
  reask(id: string, data: { specSha: string; approvalRequestId: string }): Promise<FleetFlowRecord> {
    return this.transition(id, FleetFlowState.PENDING, { state: FleetFlowState.PENDING, specSha: data.specSha, setSha: data.specSha, approvalRequestId: data.approvalRequestId, approvalMode: null, approverId: null, approvedAt: null });
  }
  async updateSha(id: string, specSha: string): Promise<FleetFlowRecord> {
    const result = await this.transactionManager.run(async () => {
      const current = await this.lockById(id);
      if (!current) throw new FlowTransitionError(id, 'missing', 'same-state');
      await this.prisma.client.fleetFlow.update({ where: { id }, data: { specSha, setSha: specSha } });
      return this.findById(id);
    });
    if (!result) throw new FlowTransitionError(id, 'missing', 'same-state');
    return result;
  }
  stop(id: string, reason: string, now: Date, detail?: string | null): Promise<FleetFlowRecord> {
    return this.transition(id, FleetFlowState.STOPPED, { state: FleetFlowState.STOPPED, stopReason: reason, stopDetail: detail ?? null, endedAt: now });
  }
  /**
   * The answers a human gave to the review the feature waits on. The feature keeps the questions and
   * the job they belong to, so the stored answers apply to that review only; the flow resumes.
   */
  async recordAnswers(flowId: string, featureId: string, input: { answers: FlowAnswer[]; userId: string; at: Date }): Promise<FleetFlowRecord> {
    const result = await this.transactionManager.run(async () => {
      await this.prisma.client.fleetFlow.update({ where: { id: flowId }, data: { state: FleetFlowState.RUNNING } });
      await this.prisma.client.fleetFlowFeature.update({
        where: { id: featureId },
        data: {
          answers: input.answers as unknown as Prisma.InputJsonValue,
          answeredById: input.userId,
          answeredAt: input.at,
          state: FleetFlowState.RUNNING,
        },
      });
      return this.findById(flowId);
    });
    if (!result) throw new FlowTransitionError(flowId, 'missing', FleetFlowState.RUNNING);
    return result;
  }
}

/** A JSON column holds the questions or the answers as an array; an empty column reads back as null. */
function jsonArray<T>(value: Prisma.JsonValue | null | undefined): T[] | null {
  return Array.isArray(value) ? (value as unknown as T[]) : null;
}
