import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { CreateWebhookDto, UpdateWebhookDto } from './webhook.dto';
import { PrismaWebhookRepository } from './prisma-webhook.repository';
import { OutboundUrlGuard, OutboundUrlRejection } from './outbound/outbound-url-guard';
import type { WebhookDomain, WebhookListItem, WebhookView } from './domain/webhook.domain';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { fieldsSummary } from '../audit/audit-summary';

@Injectable()
export class WebhookService {
  constructor(
    private readonly webhookRepo: PrismaWebhookRepository,
    private readonly urlGuard: OutboundUrlGuard,
    private readonly audit: AuditRecorder,
  ) {}

  async create(projectId: string, dto: CreateWebhookDto): Promise<WebhookDomain> {
    await this.assertUrlAllowed(dto.url);
    const secret = dto.secret ?? randomBytes(20).toString('hex');
    return this.audit.audited(
      () => this.webhookRepo.createWebhook({
        projectId,
        url: dto.url,
        secret,
        events: JSON.stringify(dto.events),
      }),
      (webhook) => ({
        key: 'webhook.create', resourceType: 'webhook', resourceId: webhook.id,
        projectId, summary: 'created',
      }),
    );
  }

  async update(projectId: string, id: string, dto: UpdateWebhookDto): Promise<WebhookView> {
    const webhook = await this.webhookRepo.findById(id);
    if (!webhook || webhook.projectId !== projectId) {
      throw new NotFoundAppException({}, 'webhooks');
    }

    if (dto.url !== undefined) {
      await this.assertUrlAllowed(dto.url);
    }

    const updated = await this.audit.audited(
      () => this.webhookRepo.update(id, {
        ...(dto.url !== undefined && { url: dto.url }),
        ...(dto.secret !== undefined && { secret: dto.secret }),
        ...(dto.events !== undefined && { events: JSON.stringify(dto.events) }),
        ...(dto.active !== undefined && { active: dto.active }),
      }),
      (result) => ({
        key: 'webhook.update', resourceType: 'webhook', resourceId: result.id,
        projectId: webhook.projectId, summary: fieldsSummary(dto),
      }),
    );

    return this.toView(updated);
  }

  /** US-003: the guard is the only URL validator; its rejection becomes a localized 400. */
  private async assertUrlAllowed(url: string): Promise<void> {
    try {
      await this.urlGuard.checkUrl(url);
    } catch (error) {
      if (error instanceof OutboundUrlRejection) {
        throw new ValidationAppException({ reason: error.reason }, 'webhooks');
      }
      throw error;
    }
  }

  private toView(webhook: WebhookDomain): WebhookView {
    return {
      id: webhook.id,
      projectId: webhook.projectId,
      url: webhook.url,
      events: webhook.events,
      active: webhook.active,
      createdAt: webhook.createdAt,
    };
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
    await this.audit.audited(
      () => this.webhookRepo.deleteWebhook(id),
      () => ({ key: 'webhook.delete', resourceType: 'webhook', resourceId: id, projectId: webhook.projectId, summary: 'deleted' }),
    );
  }

  /** Deletes a project's webhook. Another project's webhook is a 404, as in `update`. */
  async removeForProject(projectId: string, id: string): Promise<void> {
    const webhook = await this.webhookRepo.findById(id);
    if (!webhook || webhook.projectId !== projectId) {
      throw new NotFoundAppException({}, 'webhooks');
    }
    await this.audit.audited(
      () => this.webhookRepo.deleteWebhook(id),
      () => ({ key: 'webhook.delete', resourceType: 'webhook', resourceId: id, projectId: webhook.projectId, summary: 'deleted' }),
    );
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
