import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { CreateWebhookDto } from './webhook.dto';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import type { WebhookDomain, WebhookListItem } from './domain/webhook.domain';

@Injectable()
export class WebhookService {
  constructor(private readonly webhookRepo: PrismaWebhookRepository) {}

  async create(projectId: string, dto: CreateWebhookDto): Promise<WebhookDomain> {
    const secret = dto.secret ?? randomBytes(20).toString('hex');
    return this.webhookRepo.createWebhook({
      projectId,
      url: dto.url,
      secret,
      events: JSON.stringify(dto.events),
    });
  }

  async findAll(projectId: string): Promise<WebhookListItem[]> {
    return this.webhookRepo.findByProject(projectId);
  }

  async findById(id: string): Promise<WebhookDomain | null> {
    return this.webhookRepo.findById(id);
  }

  async remove(id: string): Promise<void> {
    const webhook = await this.webhookRepo.findById(id);
    if (!webhook) {
      throw new NotFoundAppException({}, 'webhooks');
    }
    await this.webhookRepo.deleteWebhook(id);
  }

  async findByProjectSlug(slug: string): Promise<WebhookListItem[]> {
    const project = await this.webhookRepo.findProjectBySlug(slug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'webhooks');
    }
    return this.findAll(project.id);
  }

  async getProjectBySlug(slug: string): Promise<{ id: string }> {
    const project = await this.webhookRepo.findProjectBySlug(slug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'webhooks');
    }
    return { id: project.id };
  }
}
