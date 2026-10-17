import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { AssistantToolCall as AssistantToolCallModel, PrismaClient } from '../../generated/prisma/client';
import type { AssistantToolCallRecord, AssistantToolCallRepository, ToolCallContext, ToolCallOutcome } from './assistant-tool-call.domain';

type Persisted = Omit<AssistantToolCallModel, 'id' | 'createdAt'>;

/**
 * The audit rows of koda tool calls. Module-private (never exported). `findCallContext` is the one escape-hatch read
 * across FleetJob, ChatThread, User and Project (1b-D6): no exported service returns a job's thread creator with the
 * user's role and disabled flag beside the project's slug.
 */
@Injectable()
export class PrismaAssistantToolCallRepository
  extends AbstractPrismaRepository<AssistantToolCallRecord, AssistantToolCallModel, string>
  implements AssistantToolCallRepository {
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
}
