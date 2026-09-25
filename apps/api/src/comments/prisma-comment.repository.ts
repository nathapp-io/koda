import { Injectable, Inject } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Comment, PrismaClient } from '@prisma/client';
import { CommentDomain } from './domain/comment.domain';
import { parseTicketRef } from '../common/utils/ticket-ref.util';

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

  async findProjectBySlug(slug: string): Promise<{ id: string; key: string; deletedAt: Date | null } | null> {
    return this.prisma.client.project.findUnique({
      where: { slug },
      select: { id: true, key: true, deletedAt: true },
    });
  }

  // H5: same scoped predicate as tickets — KEY-N prefix must match the
  // project key and CUIDs are constrained to the project.
  async findTicketScoped(
    projectId: string,
    projectKey: string,
    ticketRef: string,
  ): Promise<{ id: string; deletedAt: Date | null } | null> {
    const match = parseTicketRef(ticketRef);

    if (match) {
      if (match.prefix !== projectKey) return null;
      return this.prisma.client.ticket.findUnique({
        where: { projectId_number: { projectId, number: match.number } },
        select: { id: true, deletedAt: true },
      });
    }

    return this.prisma.client.ticket.findFirst({
      where: { id: ticketRef, projectId },
      select: { id: true, deletedAt: true },
    });
  }
}
