import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { IContextRepository } from './domain/context.domain';

@Injectable()
export class PrismaContextRepository implements IContextRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async projectExistsAndNotDeleted(projectId: string): Promise<boolean> {
    const project = await this.prisma.client.project.findUnique({
      where: { id: projectId },
      select: { id: true, deletedAt: true },
    });
    return project !== null && project.deletedAt === null;
  }
}
