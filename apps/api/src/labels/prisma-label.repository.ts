import { Injectable, Inject } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient, Prisma } from '@prisma/client';
import { ValidationAppException } from '@nathapp/nestjs-common';
import type {
  ILabelRepository,
  LabelDomain,
  ProjectRow,
  TicketRow,
  TicketWithFlatLabels,
} from './domain/label.domain';

const REF_PATTERN = /^([A-Z]+)-(\d+)$/;

@Injectable()
export class PrismaLabelRepository implements ILabelRepository {
  constructor(
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  private async exec<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ValidationAppException({}, 'labels');
      }
      throw error;
    }
  }

  async findProjectBySlug(slug: string): Promise<ProjectRow | null> {
    return this.db.project.findUnique({
      where: { slug },
      select: { id: true, deletedAt: true },
    });
  }

  async createLabel(data: { projectId: string; name: string; color: string | null }): Promise<LabelDomain> {
    const row = await this.exec(() => this.db.label.create({ data }));
    return { id: row.id, projectId: row.projectId, name: row.name, color: row.color };
  }

  async findLabelsByProject(projectId: string): Promise<LabelDomain[]> {
    const rows = await this.db.label.findMany({ where: { projectId } });
    return rows.map((r) => ({ id: r.id, projectId: r.projectId, name: r.name, color: r.color }));
  }

  async findLabelById(id: string): Promise<LabelDomain | null> {
    const row = await this.db.label.findUnique({ where: { id } });
    if (!row) return null;
    return { id: row.id, projectId: row.projectId, name: row.name, color: row.color };
  }

  async deleteLabel(id: string): Promise<void> {
    await this.exec(() => this.db.label.delete({ where: { id } }));
  }

  async updateLabel(id: string, data: { name?: string; color?: string | null }): Promise<LabelDomain> {
    const row = await this.exec(() => this.db.label.update({ where: { id }, data }));
    return { id: row.id, projectId: row.projectId, name: row.name, color: row.color };
  }

  async findTicketByRef(projectId: string, ticketRef: string): Promise<TicketRow | null> {
    const match = ticketRef.match(REF_PATTERN);
    if (match) {
      const number = parseInt(match[2], 10);
      return this.db.ticket.findUnique({
        where: { projectId_number: { projectId, number } },
        select: {
          id: true,
          projectId: true,
          number: true,
          deletedAt: true,
          labels: { include: { label: true } },
        },
      });
    }
    return this.db.ticket.findUnique({
      where: { id: ticketRef },
      select: {
        id: true,
        projectId: true,
        number: true,
        deletedAt: true,
        labels: { include: { label: true } },
      },
    });
  }

  async findTicketLabelAssignment(
    ticketId: string,
    labelId: string,
  ): Promise<{ ticketId: string; labelId: string } | null> {
    return this.db.ticketLabel.findUnique({
      where: { ticketId_labelId: { ticketId, labelId } },
    });
  }

  async findTicketLabelWithLabel(
    ticketId: string,
    labelId: string,
  ): Promise<{ ticketId: string; labelId: string; label: LabelDomain } | null> {
    const row = await this.db.ticketLabel.findUnique({
      where: { ticketId_labelId: { ticketId, labelId } },
      include: { label: true },
    });
    if (!row) return null;
    return {
      ticketId: row.ticketId,
      labelId: row.labelId,
      label: { id: row.label.id, projectId: row.label.projectId, name: row.label.name, color: row.label.color },
    };
  }

  async assignLabelToTicket(ticketId: string, labelId: string): Promise<void> {
    await this.exec(() => this.db.ticketLabel.create({ data: { ticketId, labelId } }));
  }

  async removeLabelFromTicket(ticketId: string, labelId: string): Promise<void> {
    await this.db.ticketLabel.delete({ where: { ticketId_labelId: { ticketId, labelId } } });
  }

  async createTicketActivity(data: {
    ticketId: string;
    action: string;
    field: string;
    newValue?: string | null;
    oldValue?: string | null;
    actorUserId?: string | null;
    actorAgentId?: string | null;
  }): Promise<void> {
    await this.db.ticketActivity.create({ data });
  }

  async findTicketWithLabels(ticketId: string): Promise<TicketWithFlatLabels | null> {
    const row = await this.db.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        projectId: true,
        number: true,
        deletedAt: true,
        labels: { include: { label: true } },
      },
    });
    if (!row) return null;
    return {
      ...row,
      labels: row.labels.map((tl) => ({
        id: tl.label.id,
        projectId: tl.label.projectId,
        name: tl.label.name,
        color: tl.label.color,
      })),
    };
  }

  runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.txManager.run(fn);
  }
}
