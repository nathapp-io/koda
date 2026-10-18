import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { AssistantToolCall as AssistantToolCallModel, PrismaClient } from '../../generated/prisma/client';
import type {
  AssistantToolCallRecord, AssistantToolCallRepository, ProjectCounts, ProjectCountsReader, ToolCallContext, ToolCallOutcome,
} from './assistant-tool-call.domain';

type Persisted = Omit<AssistantToolCallModel, 'id' | 'createdAt'>;

/** 1d2-D7: the statuses `koda_my_projects` counts as open; a soft-deleted ticket never counts. */
const OPEN_TICKET_STATUSES = ['CREATED', 'VERIFIED', 'IN_PROGRESS', 'VERIFY_FIX'] as const;
/** 1d2-D7: the states `koda_my_projects` counts as failed. `ESCALATED` is deliberately not one of them. */
const FAILED_JOB_STATES = ['FAILED', 'CRASHED'] as const;

/** One `groupBy` group: the key, and the count of its rows. */
interface GroupCount {
  projectId: string | null;
  _count: { _all: number };
}

/**
 * The audit rows of koda tool calls. Module-private (never exported). `findCallContext` is the one escape-hatch read
 * across FleetJob, ChatThread, User and Project (1b-D6): no exported service returns a job's thread creator with the
 * user's role and disabled flag beside the project's slug. `findProjectCounts` is the second (1d2-D7): the counts of
 * many projects in three reads, which no exported service answers together.
 */
@Injectable()
export class PrismaAssistantToolCallRepository
  extends AbstractPrismaRepository<AssistantToolCallRecord, AssistantToolCallModel, string>
  implements AssistantToolCallRepository, ProjectCountsReader {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<AssistantToolCallModel, string> {
    return (client as unknown as PrismaClient).assistantToolCall as unknown as PrismaModelDelegate<AssistantToolCallModel, string>;
  }

  protected toDomain(m: AssistantToolCallModel): AssistantToolCallRecord {
    return {
      actorType: m.actorType as AssistantToolCallRecord['actorType'],
      actorId: m.actorId,
      jobId: m.jobId,
      threadId: m.threadId,
      projectId: m.projectId,
      toolCallId: m.toolCallId,
      tool: m.tool,
      inputHash: m.inputHash,
      outcome: m.outcome as ToolCallOutcome,
      content: m.content,
      isError: m.isError,
      resultBytes: m.resultBytes,
      durationMs: m.durationMs,
    };
  }

  protected toPersistenceCreate(d: AssistantToolCallRecord): Persisted {
    return { ...d };
  }

  protected toPersistenceUpdate(p: Partial<AssistantToolCallRecord>): Partial<Persisted> {
    return { ...p };
  }

  async findByCall(jobId: string, toolCallId: string): Promise<AssistantToolCallRecord | null> {
    const row = await this.prisma.client.assistantToolCall.findUnique({ where: { jobId_toolCallId: { jobId, toolCallId } } });
    return row ? this.toDomain(row) : null;
  }

  async record(row: AssistantToolCallRecord): Promise<void> {
    await this.prisma.client.assistantToolCall.create({ data: this.toPersistenceCreate(row) });
  }

  async findUserActor(userId: string): Promise<ToolCallContext['creator'] | null> {
    return this.prisma.client.user.findUnique({
      where: { id: userId }, select: { id: true, email: true, role: true, disabled: true },
    });
  }

  async findCallContext(jobId: string): Promise<ToolCallContext | null> {
    const job = await this.prisma.client.fleetJob.findUnique({
      where: { id: jobId },
      select: {
        project: { select: { id: true, slug: true } },
        thread: { select: { id: true, kind: true, createdBy: { select: { id: true, email: true, role: true, disabled: true } } } },
      },
    });
    if (!job?.thread) return null;
    const kind = job.thread.kind;
    return {
      project: job.project,
      threadId: job.thread.id,
      creator: job.thread.createdBy,
      kind: kind === 'PROJECT' || kind === 'WORKSPACE' ? kind : 'REPO',
    };
  }

  /**
   * 1d2-D7: the three counts of every named project, one `groupBy` per table, run together. A project with no
   * matching row in a table keeps the zero it started with, so the caller never has to tell "absent" from "none".
   * An empty list short-circuits: Prisma's `in: []` matches nothing, but there is no read to make.
   */
  async findProjectCounts(projectIds: readonly string[], failedSince: Date): Promise<Map<string, ProjectCounts>> {
    const counts = new Map<string, ProjectCounts>(
      projectIds.map((projectId) => [projectId, { openTickets: 0, failedJobs7d: 0, pendingApprovals: 0 }]),
    );
    if (projectIds.length === 0) return counts;
    const ids = [...projectIds];
    const [openTickets, failedJobs, pendingApprovals] = await Promise.all([
      this.prisma.client.ticket.groupBy({
        by: ['projectId'],
        where: { projectId: { in: ids }, deletedAt: null, status: { in: [...OPEN_TICKET_STATUSES] } },
        _count: { _all: true },
      }),
      this.prisma.client.fleetJob.groupBy({
        by: ['projectId'],
        where: { projectId: { in: ids }, state: { in: [...FAILED_JOB_STATES] }, finishedAt: { gte: failedSince } },
        _count: { _all: true },
      }),
      this.prisma.client.fleetApproval.groupBy({
        by: ['projectId'],
        where: { projectId: { in: ids }, status: 'pending' },
        _count: { _all: true },
      }),
    ]);
    applyCounts(counts, openTickets, (entry, value) => { entry.openTickets = value; });
    applyCounts(counts, failedJobs, (entry, value) => { entry.failedJobs7d = value; });
    applyCounts(counts, pendingApprovals, (entry, value) => { entry.pendingApprovals = value; });
    return counts;
  }
}

/**
 * Writes one table's groups onto the entries the caller asked for. A null key (`FleetApproval.projectId` is
 * nullable) and a project outside the requested list are both ignored rather than invented.
 */
function applyCounts(
  counts: Map<string, ProjectCounts>,
  groups: readonly GroupCount[],
  set: (entry: ProjectCounts, value: number) => void,
): void {
  for (const group of groups) {
    const entry = group.projectId === null ? undefined : counts.get(group.projectId);
    if (entry) set(entry, group._count._all);
  }
}
