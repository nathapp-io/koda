import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { OutboxStatus } from '@nathapp/nestjs-outbox';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { OutboxEventDomain } from './domain/outbox-event.domain';
import { PrismaOutboxRepository } from './prisma-outbox.repository';

const LIST_LIMIT = 100;
const RETRYABLE: readonly string[] = [OutboxStatus.DEAD, OutboxStatus.PENDING];

export interface OutboxEventPage {
  items: OutboxEventDomain[];
  total: number;
}

@Injectable()
export class OutboxAdminService {
  constructor(private readonly outboxRepo: PrismaOutboxRepository, private readonly audit: AuditRecorder) {}

  async list(status: OutboxStatus = OutboxStatus.PENDING, limit = LIST_LIMIT): Promise<OutboxEventPage> {
    const [items, total] = await Promise.all([
      this.outboxRepo.findByStatus(status, limit),
      this.outboxRepo.countByStatus(status),
    ]);
    return { items, total };
  }

  /**
   * Resets a dead (or stuck pending) event to pending, due now. Rows that are
   * processing or published are refused: resetting an in-flight row would clear
   * its owner and deliver it twice.
   */
  async retry(eventId: string): Promise<void> {
    const event = await this.outboxRepo.findById(eventId);
    if (!event) {
      throw new NotFoundAppException({}, 'outbox');
    }
    if (!RETRYABLE.includes(event.status)) {
      throw new HttpException(`Outbox event is ${event.status}; only dead or pending events can be retried`, HttpStatus.CONFLICT);
    }
    const changed = await this.audit.audited(
      () => this.outboxRepo.resetForRetry(eventId, new Date()),
      (count) => count === 0 ? [] : [{
        key: 'outbox.retry',
        resourceType: 'outbox-event',
        resourceId: event.id,
        projectId: event.projectId ?? null,
        summary: `retried ${event.type}, was ${event.status}`,
      }],
    );
    if (changed === 0) {
      throw new HttpException('Outbox event changed state concurrently; retry the request', HttpStatus.CONFLICT);
    }
  }
}
