import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';

/** Fleet S4a §2.4: lookups the fleet notification consumers need at delivery time. */
@Injectable()
export class FleetNotificationReader {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async projectSlug(projectId: string): Promise<string | null> {
    const p = await this.db.project.findUnique({ where: { id: projectId }, select: { slug: true, deletedAt: true } });
    return p && !p.deletedAt ? p.slug : null;
  }
}
