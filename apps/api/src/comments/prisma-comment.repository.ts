import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { CommentDomain } from './domain/comment.domain';

@Injectable()
export class PrismaCommentRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client.comment;
  }

  private toDomain(m: {
    id: string;
    ticketId: string;
    body: string;
    type: string;
    authorUserId: string | null;
    authorAgentId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): CommentDomain {
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

  async create(data: {
    ticketId: string;
    body: string;
    type: string;
    authorUserId: string | null;
    authorAgentId: string | null;
  }): Promise<CommentDomain> {
    const model = await this.db.create({
      data: {
        ticketId: data.ticketId,
        body: data.body,
        type: data.type,
        authorUserId: data.authorUserId ?? null,
        authorAgentId: data.authorAgentId ?? null,
      },
    });
    return this.toDomain(model);
  }

  async findById(id: string): Promise<CommentDomain | null> {
    const model = await this.db.findUnique({ where: { id } });
    return model ? this.toDomain(model) : null;
  }

  async findByTicketId(ticketId: string): Promise<CommentDomain[]> {
    const models = await this.db.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
    });
    return models.map((m) => this.toDomain(m));
  }

  async update(id: string, data: { body: string }): Promise<CommentDomain> {
    const model = await this.db.update({
      where: { id },
      data: { body: data.body },
    });
    return this.toDomain(model);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete({ where: { id } });
  }
}
