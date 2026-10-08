import { Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { NotificationsRepository } from './notifications.repository';
import type { NotificationRow } from './notification.types';
import type { NotificationDto } from './dto/notification.dto';

const toDto = (r: NotificationRow): NotificationDto => ({
  id: r.id, category: r.category as NotificationDto['category'], kind: r.kind, title: r.title, body: r.body, link: r.link,
  params: { ...r.params }, projectId: r.projectId, actorId: r.actorId,
  readAt: r.readAt ? r.readAt.toISOString() : null, createdAt: r.createdAt.toISOString(),
});

/** Fleet S4a §3: the caller's own inbox. Every method takes the caller's user id, never a parameter. */
@Injectable()
export class MeNotificationsService {
  constructor(private readonly repo: NotificationsRepository) {}

  async list(userId: string, q: { current: number; size: number; unreadOnly: boolean }): Promise<IPageResult<NotificationDto>> {
    const { items, total } = await this.repo.page(userId, { unreadOnly: q.unreadOnly, page: q.current, limit: q.size });
    return {
      total, current: q.current, size: q.size,
      hasNext: q.current * q.size < total, hasPrev: q.current > 1,
      records: items.map(toDto),
    };
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    return { count: await this.repo.unreadCount(userId) };
  }

  async markRead(userId: string, id: string): Promise<void> {
    if (!(await this.repo.markRead(userId, id, new Date()))) throw new NotFoundAppException({}, 'notifications');
  }

  async markAllRead(userId: string, cutoff: Date): Promise<void> {
    await this.repo.markAllRead(userId, cutoff);
  }
}
