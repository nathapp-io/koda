import { Inject, Injectable } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient, type AssistantActionRequest as Model, type ApprovalRequest } from '../../../generated/prisma/client';
import { allocateThreadSeq } from '../../threads/domain/chat-thread.domain';
import { AssistantActionRequestRecord, ASSISTANT_ACTION_REQUEST_REPOSITORY, AssistantActionRequestRepository, LinkedApprovalRequest, NewAssistantActionRequest, OwnApprovalRequest } from './assistant-action-request.domain';

@Injectable()
export class PrismaAssistantActionRequestRepository extends AbstractPrismaRepository<AssistantActionRequestRecord, Model, string> implements AssistantActionRequestRepository {
  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService<PrismaClient>) { super(tx); }
  private get db() { return this.prisma.client; }
  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<Model, string> { return (client as unknown as PrismaClient).assistantActionRequest as unknown as PrismaModelDelegate<Model, string>; }
  protected toDomain(model: Model): AssistantActionRequestRecord { return { ...model }; }
  protected toPersistenceCreate(record: AssistantActionRequestRecord) { return { ...record }; }
  protected toPersistenceUpdate(patch: Partial<AssistantActionRequestRecord>) { return { ...patch }; }

  async insert(link: NewAssistantActionRequest): Promise<AssistantActionRequestRecord> {
    return this.toDomain(await this.db.assistantActionRequest.create({ data: link }));
  }
  async findByRequest(requestId: string): Promise<AssistantActionRequestRecord | null> {
    const row = await this.db.assistantActionRequest.findUnique({ where: { requestId } });
    return row ? this.toDomain(row) : null;
  }
  async lockThread(threadId: string): Promise<boolean> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
    return rows.length > 0;
  }
  async lockByRequest(requestId: string): Promise<AssistantActionRequestRecord | null> {
    const rows = await this.db.$queryRaw<Array<{ requestId: string }>>`SELECT "requestId" FROM "AssistantActionRequest" WHERE "requestId" = ${requestId} FOR UPDATE`;
    return rows.length ? this.findByRequest(requestId) : null;
  }
  async insertSystemNote(threadId: string, content: string): Promise<string> {
    const seq = await allocateThreadSeq(this.db, threadId);
    const row = await this.db.chatMessage.create({ data: { threadId, seq, role: 'system', status: 'complete', content } });
    return row.id;
  }
  async markNoted(requestId: string, noteMessageId: string, at: Date): Promise<void> {
    await this.db.assistantActionRequest.update({ where: { requestId }, data: { noteMessageId, notedAt: at } });
  }
  async countPendingInThread(threadId: string): Promise<number> {
    return this.db.assistantActionRequest.count({ where: { threadId, request: { status: 'pending' } } });
  }
  async findScopedInThread(requestId: string, projectId: string, threadId: string): Promise<LinkedApprovalRequest | null> {
    return this.db.assistantActionRequest.findFirst({ where: { requestId, threadId, request: { projectId } }, include: { request: { select: { id: true, projectId: true, status: true, createdAt: true, decidedAt: true, settledAt: true, result: true } } } }) as Promise<LinkedApprovalRequest | null>;
  }
  async findOwnRequest(requestId: string, projectId: string, actor: { type: 'USER' | 'AGENT'; id: string }): Promise<OwnApprovalRequest | null> {
    const row = await this.db.approvalRequest.findFirst({ where: { id: requestId, projectId, actorType: actor.type, actorId: actor.id }, include: { assistantAction: true } });
    return row as OwnApprovalRequest | null;
  }
}
