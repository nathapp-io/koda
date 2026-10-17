import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { PendingAction as PendingActionModel, Prisma, PrismaClient } from '../../../generated/prisma/client';
import { allocateThreadSeq } from '../../threads/domain/chat-thread.domain';
import {
  ActionResolution, NewPendingAction, PendingActionRecord, PendingActionRepository, PendingActionStatus,
} from './pending-action.domain';

const asObject = (v: Prisma.JsonValue): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const json = (v: Record<string, unknown>): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/**
 * 2a-D3: the action rows of koda write-tool calls. Module-private (never exported): the only writer is
 * `AssistantActionService.propose`, which calls every method inside its thread-locked transaction.
 */
@Injectable()
export class PrismaPendingActionRepository
  extends AbstractPrismaRepository<PendingActionRecord, PendingActionModel, string>
  implements PendingActionRepository {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<PendingActionModel, string> {
    return (client as unknown as PrismaClient).pendingAction as unknown as PrismaModelDelegate<PendingActionModel, string>;
  }

  /**
   * Mapping of the reads below, which fill `projectSlug` from the project read in `withSlug`. The slug-less
   * fallback that the inherited generic CRUD (`findAll`, `findOne`, `update`) would take is never reached:
   * this repository serves `findById`, `findByCall` and `insert`, which all hydrate the row.
   */
  protected toDomain(m: PendingActionModel): PendingActionRecord {
    return this.toRecord(m, '');
  }

  protected toPersistenceCreate(d: PendingActionRecord) {
    return {
      projectId: d.projectId, threadId: d.threadId, jobId: d.jobId, toolCallId: d.toolCallId, tool: d.tool,
      input: json(d.input), preview: d.preview, status: d.status, requestedById: d.requestedById,
      approvalId: d.approvalId, decidedById: d.decidedById, decidedAt: d.decidedAt, result: d.result,
      deliveredAt: d.deliveredAt, expiresAt: d.expiresAt,
    };
  }

  protected toPersistenceUpdate(patch: Partial<PendingActionRecord>) {
    const data: Record<string, unknown> = {};
    if (patch.input !== undefined) data['input'] = json(patch.input);
    if (patch.status !== undefined) data['status'] = patch.status;
    if (patch.approvalId !== undefined) data['approvalId'] = patch.approvalId;
    if (patch.decidedById !== undefined) data['decidedById'] = patch.decidedById;
    if (patch.decidedAt !== undefined) data['decidedAt'] = patch.decidedAt;
    if (patch.result !== undefined) data['result'] = patch.result;
    if (patch.deliveredAt !== undefined) data['deliveredAt'] = patch.deliveredAt;
    if (patch.expiresAt !== undefined) data['expiresAt'] = patch.expiresAt;
    return data;
  }

  /**
   * 2a-D4 step 1 / 2a-D11: the thread row lock every action writer takes first. False means the thread is gone
   * (its actions cascade with it), which the caller answers as a 404 rather than writing an orphan.
   */
  async lockThread(threadId: string): Promise<boolean> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
    return rows.length > 0;
  }

  async findByCall(jobId: string, toolCallId: string): Promise<PendingActionRecord | null> {
    return this.first(await this.db.pendingAction.findUnique({ where: { jobId_toolCallId: { jobId, toolCallId } } }));
  }

  async findById(id: string): Promise<PendingActionRecord | null> {
    return this.first(await this.db.pendingAction.findUnique({ where: { id } }));
  }

  /**
   * 2a-D14: the scope is part of the read, not a check after it, so another thread's or project's row is never
   * loaded and cannot be answered differently from an id that does not exist.
   */
  async findScopedById(id: string, projectId: string, threadId: string): Promise<PendingActionRecord | null> {
    return this.first(await this.db.pendingAction.findFirst({ where: { id, projectId, threadId } }));
  }

  async countPending(threadId: string): Promise<number> {
    return this.db.pendingAction.count({ where: { threadId, status: 'PENDING' } });
  }

  /** 2a-D10: the sweeper's scan. `expiresAt` at or before `now`, soonest first, then by id for a stable order. */
  async findDue(now: Date, limit: number): Promise<PendingActionRecord[]> {
    const rows = await this.db.pendingAction.findMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: limit,
    });
    return this.withSlug(rows);
  }

  async insert(action: NewPendingAction): Promise<PendingActionRecord> {
    const row = await this.db.pendingAction.create({ data: { ...action, input: json(action.input) } });
    return (await this.withSlug([row]))[0];
  }

  async setApprovalId(id: string, approvalId: string): Promise<void> {
    await this.db.pendingAction.update({ where: { id }, data: { approvalId } });
  }

  async lockById(id: string): Promise<PendingActionRecord | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "PendingAction" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length > 0 ? this.findById(id) : null;
  }

  async resolve(id: string, resolution: ActionResolution): Promise<PendingActionRecord> {
    const row = await this.db.pendingAction.update({
      where: { id },
      data: {
        status: resolution.status,
        decidedAt: resolution.decidedAt,
        ...(resolution.decidedById !== undefined ? { decidedById: resolution.decidedById } : {}),
        // 2a-D8 step 8: the terminal status and the tool's own outcome are written by the same statement.
        ...(resolution.result !== undefined ? { result: resolution.result } : {}),
      },
    });
    return (await this.withSlug([row]))[0];
  }

  async insertSystemNote(threadId: string, content: string): Promise<string> {
    const seq = await allocateThreadSeq(this.db, threadId);
    const note = await this.db.chatMessage.create({ data: { threadId, seq, role: 'system', status: 'complete', content } });
    return note.id;
  }

  private async first(row: PendingActionModel | null): Promise<PendingActionRecord | null> {
    return row === null ? null : (await this.withSlug([row]))[0];
  }

  /**
   * 2a-D3: fills `projectSlug` for the rows of one read. It comes from the action's own `projectId`, so a
   * WORKSPACE thread whose action acts in another project still answers that project's slug.
   */
  private async withSlug(rows: readonly PendingActionModel[]): Promise<PendingActionRecord[]> {
    if (rows.length === 0) return [];
    const projects = await this.db.project.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.projectId))] } }, select: { id: true, slug: true },
    });
    const slugs = new Map(projects.map((project) => [project.id, project.slug]));
    return rows.map((row) => this.toRecord(row, slugs.get(row.projectId) ?? ''));
  }

  private toRecord(m: PendingActionModel, projectSlug: string): PendingActionRecord {
    return {
      id: m.id,
      projectId: m.projectId,
      projectSlug,
      threadId: m.threadId,
      jobId: m.jobId,
      toolCallId: m.toolCallId,
      tool: m.tool,
      input: asObject(m.input),
      preview: m.preview,
      status: m.status as PendingActionStatus,
      requestedById: m.requestedById,
      approvalId: m.approvalId,
      decidedById: m.decidedById,
      decidedAt: m.decidedAt,
      result: m.result,
      deliveredAt: m.deliveredAt,
      expiresAt: m.expiresAt,
      createdAt: m.createdAt,
    };
  }
}
