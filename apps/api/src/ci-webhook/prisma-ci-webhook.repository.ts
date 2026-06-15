import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient } from '@prisma/client';
import { CiProjectDomain, CiTicketDomain } from './domain/ci-webhook.domain';

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
  ): Promise<CiTicketDomain> {
    return this.txManager.run(async () => {
      const lastTicket = await this.prisma.client.ticket.findFirst({
        where: { projectId },
        orderBy: { number: 'desc' },
      });
      const nextNumber = (lastTicket?.number ?? 0) + 1;
      return this.prisma.client.ticket.create({
        data: { projectId, number: nextNumber, ...data },
      });
    });
  }
}
