import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { NotificationDraft, NotificationParams, NotificationRow } from './notification.types';

const ROW_SELECT = {
  id: true, userId: true, projectId: true, category: true, kind: true, title: true, body: true, link: true,
  params: true, actorId: true, readAt: true, createdAt: true,
} as const;

type RawRow = Prisma.NotificationGetPayload<{ select: typeof ROW_SELECT }>;

const toParams = (value: Prisma.JsonValue): NotificationParams =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as NotificationParams) : {};

const toRow = (r: RawRow): NotificationRow => ({ ...r, params: toParams(r.params) });

/** Fleet S4a §1: every Prisma access to `Notification`. Joins an open txManager.run. */
@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  /** D501: the unique (userId, sourceType, sourceId, kind) key makes a repeat insert a no-op. */
  async insertMany(drafts: readonly NotificationDraft[]): Promise<readonly { id: string; userId: string }[]> {
    if (drafts.length === 0) return [];
    return this.db.notification.createManyAndReturn({
      data: drafts.map((d) => ({
        userId: d.userId, projectId: d.projectId, category: d.category, kind: d.kind, title: d.title, body: d.body,
        link: d.link, params: { ...d.params } as Prisma.InputJsonObject, sourceType: d.sourceType, sourceId: d.sourceId,
        actorId: d.actorId,
      })),
      skipDuplicates: true,
      select: { id: true, userId: true },
    });
  }

  async page(userId: string, opts: { unreadOnly: boolean; page: number; limit: number }): Promise<{ items: NotificationRow[]; total: number }> {
    const where = opts.unreadOnly ? { userId, readAt: null } : { userId };
    const [rows, total] = await Promise.all([
      this.db.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (opts.page - 1) * opts.limit,
        take: opts.limit,
        select: ROW_SELECT,
      }),
      this.db.notification.count({ where }),
    ]);
    return { items: rows.map(toRow), total };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.db.notification.count({ where: { userId, readAt: null } });
  }

  /** False only when the row does not exist or is not the caller's; marking a read row again is true. */
  async markRead(userId: string, id: string, now: Date): Promise<boolean> {
    const { count } = await this.db.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: now } });
    if (count === 1) return true;
    return (await this.db.notification.count({ where: { id, userId } })) === 1;
  }

  /** Review Focus 5: only rows created at or before the cutoff, so a racing new notification stays unread. */
  async markAllRead(userId: string, cutoff: Date): Promise<number> {
    const { count } = await this.db.notification.updateMany({
      where: { userId, readAt: null, createdAt: { lte: cutoff } },
      data: { readAt: cutoff },
    });
    return count;
  }

  async purgeRead(before: Date): Promise<number> {
    const { count } = await this.db.notification.deleteMany({ where: { readAt: { not: null }, createdAt: { lt: before } } });
    return count;
  }
}
