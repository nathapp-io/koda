import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { isRecordNotFound } from '../common/utils/prisma-errors';
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
    return (await this.prepareCreate(projectId, dto))();
  }

  /**
   * US-004: the gated create's `prepare` step. The outbound URL guard (which resolves DNS) runs here,
   * outside the approval transaction, and the returned callback is the write itself: an immediate call
   * and a redemption both answer exactly what `create` always did, including the one-time generated
   * secret.
   */
  async prepareCreate(projectId: string, dto: CreateWebhookDto): Promise<() => Promise<WebhookDomain>> {
    await this.assertUrlAllowed(dto.url);

    return () => this.audit.audited(
      () => this.webhookRepo.createWebhook({
        projectId,
        url: dto.url,
        secret: dto.secret ?? randomBytes(20).toString('hex'),
        events: JSON.stringify(dto.events),
      }),
      (webhook) => ({
        key: 'webhook.create', resourceType: 'webhook', resourceId: webhook.id,
        projectId, summary: 'created',
      }),
    );
  }

  async update(projectId: string, id: string, dto: UpdateWebhookDto): Promise<WebhookView> {
    return (await this.prepareUpdate(projectId, id, dto))();
  }

  /**
   * US-004: the gated update's `prepare` step. Ownership and an optional new URL are checked here,
   * outside the approval transaction; the callback re-reads the webhook before it writes, so a row
   * deleted (or otherwise gone) between the approval and the redemption answers 404 instead of being
   * recreated.
   */
  async prepareUpdate(projectId: string, id: string, dto: UpdateWebhookDto): Promise<() => Promise<WebhookView>> {
    await this.assertOwnedWebhook(projectId, id);
    if (dto.url !== undefined) {
      await this.assertUrlAllowed(dto.url);
    }

    return async () => {
      // The webhook was this project's when the gate opened the request; it may be gone by now.
      const webhook = await this.assertOwnedWebhook(projectId, id);
      const updated = await this.audit.audited(
        () => this.writeWebhook(id, dto),
        (result) => ({
          key: 'webhook.update', resourceType: 'webhook', resourceId: result.id,
          projectId: webhook.projectId, summary: fieldsSummary(dto),
        }),
      );

      return this.toView(updated);
    };
  }

  /** The update's own write; a row that vanished after the callback's re-read is a 404, not a 500. */
  private async writeWebhook(id: string, dto: UpdateWebhookDto): Promise<WebhookDomain> {
    try {
      return await this.webhookRepo.update(id, {
        ...(dto.url !== undefined && { url: dto.url }),
        ...(dto.secret !== undefined && { secret: dto.secret }),
        ...(dto.events !== undefined && { events: JSON.stringify(dto.events) }),
        ...(dto.active !== undefined && { active: dto.active }),
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw new NotFoundAppException({}, 'webhooks');
      throw error;
    }
  }

  /** The project's own webhook; a missing one and another project's are the same 404. */
  private async assertOwnedWebhook(projectId: string, id: string): Promise<WebhookDomain> {
    const webhook = await this.webhookRepo.findById(id);
    if (!webhook || webhook.projectId !== projectId) {
      throw new NotFoundAppException({}, 'webhooks');
    }
    return webhook;
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
    const webhook = await this.assertOwnedWebhook(projectId, id);
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
