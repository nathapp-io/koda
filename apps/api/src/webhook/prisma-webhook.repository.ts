import { Injectable, Inject } from '@nestjs/common';
import { AbstractPrismaRepository, PrismaClientLike, PrismaModelDelegate, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Webhook as WebhookModel, PrismaClient } from '@prisma/client';
import { WebhookDomain, WebhookListItem, WebhookProjectRef } from './domain/webhook.domain';

export interface CreateWebhookData {
  projectId: string;
  url: string;
  secret: string;
  events: string;
}

@Injectable()
export class PrismaWebhookRepository
  extends AbstractPrismaRepository<WebhookDomain, WebhookModel, string> {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    super(tx);
  }

  protected modelDelegate(client: PrismaClientLike): PrismaModelDelegate<WebhookModel, string> {
    return (client as unknown as PrismaClient).webhook as unknown as PrismaModelDelegate<WebhookModel, string>;
  }

  protected toDomain(m: WebhookModel): WebhookDomain {
    return {
      id: m.id,
      projectId: m.projectId,
      url: m.url,
      secret: m.secret,
      events: m.events,
      active: m.active,
      createdAt: m.createdAt,
    };
  }

  protected toPersistenceCreate(d: WebhookDomain) {
    return {
      projectId: d.projectId,
      url: d.url,
      secret: d.secret,
      events: d.events,
    };
  }

  protected toPersistenceUpdate(p: Partial<WebhookDomain>) {
    return {
      ...(p.url !== undefined && { url: p.url }),
      ...(p.secret !== undefined && { secret: p.secret }),
      ...(p.events !== undefined && { events: p.events }),
      ...(p.active !== undefined && { active: p.active }),
    };
  }

  async createWebhook(data: CreateWebhookData): Promise<WebhookDomain> {
    const model = await this.prisma.client.webhook.create({ data });
    return this.toDomain(model);
  }

  async findByProject(projectId: string): Promise<WebhookListItem[]> {
    const models = await this.prisma.client.webhook.findMany({
      where: { projectId },
      select: {
        id: true,
        projectId: true,
        url: true,
        events: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return models;
  }

  async findActiveByProject(projectId: string): Promise<WebhookDomain[]> {
    const models = await this.prisma.client.webhook.findMany({
      where: { projectId, active: true },
    });
    return models.map((m) => this.toDomain(m));
  }

  async findById(id: string): Promise<WebhookDomain | null> {
    const model = await this.prisma.client.webhook.findUnique({ where: { id } });
    return model ? this.toDomain(model) : null;
  }

  async deleteWebhook(id: string): Promise<WebhookDomain> {
    const model = await this.prisma.client.webhook.delete({ where: { id } });
    return this.toDomain(model);
  }

  async findProjectBySlug(slug: string): Promise<WebhookProjectRef | null> {
    const project = await this.prisma.client.project.findUnique({
      where: { slug },
      select: { id: true, deletedAt: true },
    });
    return project;
  }
}
