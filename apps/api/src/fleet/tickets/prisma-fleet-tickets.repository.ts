import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { CommentType, TicketLinkSource } from '../../common/enums';
import { parseTicketRef } from '../../common/utils/ticket-ref.util';

export interface TicketRow { id: string; number: number; title: string; status: string; deletedAt: Date | null }
export interface LinkedTicket { ticketId: string; ref: string; title: string; status: string; notifiedEpoch: number | null }
export interface EffectJob {
  id: string; projectId: string; projectSlug: string; command: string; state: string; leaseEpoch: number;
  stateReason: string | null; escalationReason: string | null; requestedById: string;
}
export interface PrLinkJob {
  id: string; projectId: string; requestedById: string; resultPrUrl: string | null;
  repo: { provider: 'github' | 'gitlab'; owner: string; name: string };
}
export interface FleetPrLinkInput {
  ticketId: string; jobId: string; url: string; provider: string; prNumber: number; externalRef: string; now: Date;
}
export interface TicketJobRow {
  id: string; command: string; feature: string; state: string; stateReason: string | null; escalationReason: string | null;
  resultBranch: string | null; resultSha: string | null; resultPrUrl: string | null;
  costSpentUsd: string; costCarriedUsd: string; queuedAt: Date; finishedAt: Date | null;
}

/** Fleet C9 (spec §1-§3.2): every Prisma access of the fleet tickets module. Joins an open txManager.run. */
@Injectable()
export class PrismaFleetTicketsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findProject(projectId: string): Promise<{ key: string; slug: string } | null> {
    return this.db.project.findUnique({ where: { id: projectId }, select: { key: true, slug: true } });
  }

  async findTicketsByNumbers(projectId: string, numbers: readonly number[]): Promise<TicketRow[]> {
    if (numbers.length === 0) return [];
    return this.db.ticket.findMany({
      where: { projectId, number: { in: [...numbers] } },
      select: { id: true, number: true, title: true, status: true, deletedAt: true },
    });
  }

  /** `KEY-N` (case-insensitive, this project's key only) or a ticket id of this project; deleted tickets never resolve. */
  async findTicketByRef(projectId: string, projectKey: string, ref: string): Promise<{ id: string } | null> {
    const parsed = parseTicketRef(ref.trim().toUpperCase());
    if (parsed) {
      if (parsed.prefix !== projectKey) return null;
      return this.db.ticket.findFirst({ where: { projectId, number: parsed.number, deletedAt: null }, select: { id: true } });
    }
    return this.db.ticket.findFirst({ where: { id: ref, projectId, deletedAt: null }, select: { id: true } });
  }

  async linkTickets(jobId: string, ticketIds: readonly string[]): Promise<void> {
    if (ticketIds.length === 0) return;
    await this.db.fleetJobTicket.createMany({ data: ticketIds.map((ticketId) => ({ jobId, ticketId })), skipDuplicates: true });
  }

  async findTicketsForJob(jobId: string): Promise<LinkedTicket[]> {
    const rows = await this.db.fleetJobTicket.findMany({
      where: { jobId, ticket: { deletedAt: null } },
      select: {
        notifiedEpoch: true,
        ticket: { select: { id: true, number: true, title: true, status: true, project: { select: { key: true } } } },
      },
      orderBy: { ticket: { number: 'asc' } },
    });
    return rows.map((r) => ({
      ticketId: r.ticket.id,
      ref: `${r.ticket.project.key}-${r.ticket.number}`,
      title: r.ticket.title,
      status: r.ticket.status,
      notifiedEpoch: r.notifiedEpoch,
    }));
  }

  async findJobForEffects(jobId: string): Promise<EffectJob | null> {
    const r = await this.db.fleetJob.findUnique({
      where: { id: jobId },
      select: {
        id: true, projectId: true, command: true, state: true, leaseEpoch: true, stateReason: true, escalationReason: true,
        requestedById: true, project: { select: { slug: true } },
      },
    });
    if (!r) return null;
    const { project, ...rest } = r;
    return { ...rest, projectSlug: project.slug };
  }

  /** D453: true for exactly one caller per (job, ticket, epoch); a later epoch claims again. */
  async claimNotified(jobId: string, ticketId: string, epoch: number): Promise<boolean> {
    const { count } = await this.db.fleetJobTicket.updateMany({
      where: { jobId, ticketId, OR: [{ notifiedEpoch: null }, { notifiedEpoch: { lt: epoch } }] },
      data: { notifiedEpoch: epoch },
    });
    return count === 1;
  }

  async createSystemComment(ticketId: string, body: string): Promise<{ id: string }> {
    return this.db.comment.create({
      data: { ticketId, body, type: CommentType.GENERAL, authorUserId: null, authorAgentId: null },
      select: { id: true },
    });
  }

  async findJobForPrLinks(jobId: string): Promise<PrLinkJob | null> {
    const r = await this.db.fleetJob.findUnique({
      where: { id: jobId },
      select: { id: true, projectId: true, requestedById: true, resultPrUrl: true, repo: { select: { provider: true, owner: true, name: true } } },
    });
    return r ? { ...r, repo: { ...r.repo, provider: r.repo.provider as 'github' | 'gitlab' } } : null;
  }

  /**
   * D455: insert the fleet PR link, or point the existing (ticketId, url) link at this job
   * (a vcs link keeps source=vcs; plan P4: latest job wins). True only when a row was created.
   * Never writes prState on an existing row (M12; see vcs/pr-state-write-sites.spec.ts).
   * Call inside txManager.run.
   */
  async upsertFleetPrLink(input: FleetPrLinkInput): Promise<boolean> {
    const { ticketId, jobId, url, provider, prNumber, externalRef, now } = input;
    const { count } = await this.db.ticketLink.createMany({
      data: [{ ticketId, url, provider, linkType: 'pr', source: TicketLinkSource.FLEET, jobId, prNumber, externalRef, prState: 'open', prUpdatedAt: now }],
      skipDuplicates: true,
    });
    if (count === 1) return true;
    await this.db.ticketLink.updateMany({ where: { ticketId, url }, data: { jobId } });
    return false;
  }

  async findJobsForTicket(ticketId: string, limit: number): Promise<TicketJobRow[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { tickets: { some: { ticketId } } },
      orderBy: { queuedAt: 'desc' },
      take: limit,
      select: {
        id: true, command: true, feature: true, state: true, stateReason: true, escalationReason: true,
        resultBranch: true, resultSha: true, resultPrUrl: true, costSpentUsd: true, costCarriedUsd: true,
        queuedAt: true, finishedAt: true,
      },
    });
    return rows.map((r) => ({ ...r, costSpentUsd: r.costSpentUsd.toString(), costCarriedUsd: r.costCarriedUsd.toString() }));
  }

  /** D459: the join row plus that job's fleet links on that ticket. Call inside txManager.run. */
  async unlink(jobId: string, ticketId: string): Promise<boolean> {
    const { count } = await this.db.fleetJobTicket.deleteMany({ where: { jobId, ticketId } });
    if (count === 0) return false;
    await this.db.ticketLink.deleteMany({ where: { ticketId, jobId, source: TicketLinkSource.FLEET } });
    return true;
  }
}
