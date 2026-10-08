import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { parseTicketRef } from '../common/utils/ticket-ref.util';
import type { WatchReason } from './notification.types';

/** Fleet S4a §1 (D502): every Prisma access to `TicketWatcher`. Joins an open txManager.run. */
@Injectable()
export class TicketWatchersRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  /** Insert-if-absent; never un-mutes or changes the reason of an existing row. First reason per user wins. */
  async ensure(ticketId: string, entries: readonly { userId: string; reason: WatchReason }[]): Promise<void> {
    const firstByUser = entries.reduce<ReadonlyMap<string, WatchReason>>(
      (acc, e) => (acc.has(e.userId) ? acc : new Map([...acc, [e.userId, e.reason]])),
      new Map(),
    );
    if (firstByUser.size === 0) return;
    await this.db.ticketWatcher.createMany({
      data: [...firstByUser].map(([userId, reason]) => ({ ticketId, userId, reason })),
      skipDuplicates: true,
    });
  }

  async findUnmutedUserIds(ticketId: string): Promise<readonly string[]> {
    const rows = await this.db.ticketWatcher.findMany({ where: { ticketId, muted: false }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  async watch(ticketId: string, userId: string): Promise<void> {
    await this.setMuted(ticketId, userId, false);
  }

  async unwatch(ticketId: string, userId: string): Promise<void> {
    await this.setMuted(ticketId, userId, true);
  }

  async state(ticketId: string, userId: string): Promise<{ watching: boolean; count: number }> {
    const [row, count] = await Promise.all([
      this.db.ticketWatcher.findUnique({ where: { ticketId_userId: { ticketId, userId } }, select: { muted: true } }),
      this.db.ticketWatcher.count({ where: { ticketId, muted: false } }),
    ]);
    return { watching: row !== null && !row.muted, count };
  }

  /** `KEY-N` (case-insensitive, this project's key only) or a ticket id of this project; deleted tickets never resolve. */
  async findTicketIdByRef(projectId: string, ref: string): Promise<string | null> {
    const parsed = parseTicketRef(ref.trim().toUpperCase());
    if (parsed) {
      const project = await this.db.project.findUnique({ where: { id: projectId }, select: { key: true } });
      if (!project || parsed.prefix !== project.key) return null;
      const row = await this.db.ticket.findFirst({ where: { projectId, number: parsed.number, deletedAt: null }, select: { id: true } });
      return row?.id ?? null;
    }
    const row = await this.db.ticket.findFirst({ where: { id: ref, projectId, deletedAt: null }, select: { id: true } });
    return row?.id ?? null;
  }

  private async setMuted(ticketId: string, userId: string, muted: boolean): Promise<void> {
    await this.db.ticketWatcher.upsert({
      where: { ticketId_userId: { ticketId, userId } },
      create: { ticketId, userId, reason: 'MANUAL', muted },
      update: { muted },
    });
  }
}
