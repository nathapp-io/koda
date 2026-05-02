import { Injectable, Inject } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Comment, PrismaClient } from '@prisma/client';
import { CommentDomain } from './domain/comment.domain';

@Injectable()
export class PrismaCommentRepository extends AbstractPrismaRepository<CommentDomain, Comment, string> {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<Comment, string> {
    return (client as unknown as PrismaClient).comment as unknown as PrismaModelDelegate<Comment, string>;
  }

  protected toDomain(m: Comment): CommentDomain {
    return {
      id: m.id,
      ticketId: m.ticketId,
      body: m.body,
      type: m.type,
      authorUserId: m.authorUserId,
      authorAgentId: m.authorAgentId,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  protected toPersistenceCreate(d: CommentDomain): Omit<Comment, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      ticketId: d.ticketId,
      body: d.body,
      type: d.type,
      authorUserId: d.authorUserId ?? null,
      authorAgentId: d.authorAgentId ?? null,
    };
  }

  protected toPersistenceUpdate(patch: Partial<CommentDomain>): Partial<Omit<Comment, 'id' | 'createdAt' | 'updatedAt'>> {
    const data: Partial<Omit<Comment, 'id' | 'createdAt' | 'updatedAt'>> = {};
    if (patch.body !== undefined) data.body = patch.body;
    if (patch.type !== undefined) data.type = patch.type;
    if (patch.authorUserId !== undefined) data.authorUserId = patch.authorUserId;
    if (patch.authorAgentId !== undefined) data.authorAgentId = patch.authorAgentId;
    if (patch.ticketId !== undefined) data.ticketId = patch.ticketId;
    return data;
  }

  async findByTicketId(ticketId: string): Promise<CommentDomain[]> {
    const models = await this.prisma.client.comment.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
    });
    return models.map((m) => this.toDomain(m as Comment));
  }
}
