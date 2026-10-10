import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ChatMessageRecord, ChatThreadRecord, ChatThreadRepository } from './domain/chat-thread.domain';
import type { ThreadSkillSource } from '../../skills/skill-catalog.domain';
import type { ThreadBackend } from '../common/thread-jobs';

@Injectable()
export class PrismaChatThreadRepository implements ChatThreadRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async create(input: { projectId: string; repoId: string; baseRef: string; feature: string; title: string; createdById: string; backend: ThreadBackend; skills: ThreadSkillSource[]; maxCostUsd: string }): Promise<ChatThreadRecord> {
    const row = await this.prisma.client.chatThread.create({ data: {
      ...input,
      backend: input.backend as Prisma.InputJsonValue,
      skills: input.skills as unknown as Prisma.InputJsonValue,
      specPath: `.nax/features/${input.feature}/spec.md`,
    } });
    return this.mapThread(row, null);
  }

  async list(projectId: string, status: string | undefined, skip: number, take: number): Promise<ChatThreadRecord[]> {
    const rows = await this.prisma.client.chatThread.findMany({ where: { projectId, ...(status ? { status } : {}) }, skip, take, orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }] });
    const jobs = rows.length ? await this.prisma.client.fleetJob.findMany({ where: { threadId: { in: rows.map((row) => row.id) }, command: 'THREAD', state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED'] } }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, state: true, threadId: true } }) : [];
    const active = new Map<string, { id: string; state: string }>();
    for (const job of jobs) if (job.threadId && !active.has(job.threadId)) active.set(job.threadId, { id: job.id, state: job.state });
    return rows.map((row) => this.mapThread(row, active.get(row.id) ?? null));
  }

  async get(projectId: string, id: string): Promise<ChatThreadRecord | null> {
    const row = await this.prisma.client.chatThread.findFirst({ where: { id, projectId } });
    if (!row) return null;
    const job = await this.prisma.client.fleetJob.findFirst({ where: { threadId: id, command: 'THREAD', state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED'] } }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, state: true } });
    return this.mapThread(row, job);
  }

  async messages(threadId: string, afterSeq: number, limit: number): Promise<ChatMessageRecord[]> {
    const rows = await this.prisma.client.chatMessage.findMany({ where: { threadId, seq: { gt: afterSeq } }, orderBy: { seq: 'asc' }, take: limit });
    return rows.map(({ threadId: _threadId, ...row }) => ({ ...row, costUsd: row.costUsd?.toString() ?? null }));
  }

  private mapThread(row: Prisma.ChatThreadGetPayload<object>, activeJob: { id: string; state: string } | null): ChatThreadRecord {
    return {
      id: row.id, repoId: row.repoId, baseRef: row.baseRef, feature: row.feature,
      title: row.title, createdById: row.createdById, runnerId: row.runnerId,
      backend: row.backend as unknown as ThreadBackend, status: row.status, archivedAt: row.archivedAt,
      skills: row.skills as unknown as ThreadSkillSource[], maxCostUsd: row.maxCostUsd.toString(),
      costUsd: row.costUsd.toString(), tokens: row.tokens, specPath: row.specPath,
      pendingQuestion: row.pendingQuestion, lastActivityAt: row.lastActivityAt, createdAt: row.createdAt, activeJob,
    };
  }
}
