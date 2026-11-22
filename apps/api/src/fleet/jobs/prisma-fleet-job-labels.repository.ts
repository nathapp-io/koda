import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { readPrincipalNames } from '../../common/utils/event-labels';

@Injectable()
export class PrismaFleetJobLabelsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Requester names by principal id and thread titles by thread id, for one page of jobs. */
  async read(jobs: ReadonlyArray<{ requestedById: string; threadId: string | null }>): Promise<{ names: Map<string, string>; threads: Map<string, string> }> {
    const [names, threads] = await Promise.all([
      readPrincipalNames(this.prisma.client, jobs.map((job) => job.requestedById)),
      this.readThreads(jobs),
    ]);
    return { names, threads };
  }

  private async readThreads(jobs: ReadonlyArray<{ threadId: string | null }>): Promise<Map<string, string>> {
    const threadIds = [...new Set(jobs.map((job) => job.threadId).filter((id): id is string => id !== null))];
    if (threadIds.length === 0) return new Map();
    const rows = await this.prisma.client.chatThread.findMany({
      where: { id: { in: threadIds } },
      select: { id: true, title: true },
    });
    return new Map(rows.map((thread) => [thread.id, thread.title]));
  }
}
