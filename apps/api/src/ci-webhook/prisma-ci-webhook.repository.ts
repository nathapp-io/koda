import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient } from '../generated/prisma/client';
import { runWithTicketNumberRetry } from '../common/utils/ticket-number-retry';
import { CiProjectDomain, CiTicketDomain, OnCiTicketCreated } from './domain/ci-webhook.domain';

@Injectable()
export class PrismaCiWebhookRepository {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  async findProjectBySlug(slug: string): Promise<CiProjectDomain | null> {
    return this.prisma.client.project.findUnique({
      where: { slug },
      select: {
        id: true,
        key: true,
        deletedAt: true,
        ciWebhookToken: true,
      },
    });
  }

  /**
   * Create the failed-pipeline ticket inside a transaction, allocating its number as MAX(number)+1 for
   * the project and retrying a concurrent-number conflict in a NEW transaction (M6).
   *
   * `onCreated` runs inside that same attempt, after the insert (Permissions P2 US-006): a rejection
   * rolls the ticket back and propagates — it is not a number conflict, so the attempt is not retried.
   * Wrapping the call in `audited` instead would make every number conflict take the outer transaction
   * with it and answer 409.
   */
  async createTicket(
    projectId: string,
    data: {
      type: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      gitRefVersion: string;
      gitRefFile: string | null;
      gitRefLine: number | null;
    },
    onCreated?: OnCiTicketCreated,
  ): Promise<CiTicketDomain> {
    return runWithTicketNumberRetry(this.txManager, async () => {
      const lastTicket = await this.prisma.client.ticket.findFirst({
        where: { projectId },
        orderBy: { number: 'desc' },
      });
      const nextNumber = (lastTicket?.number ?? 0) + 1;
      const ticket = await this.prisma.client.ticket.create({
        data: { projectId, number: nextNumber, ...data },
      });

      if (onCreated) await onCreated({ id: ticket.id, number: ticket.number });

      return ticket;
    });
  }
}
