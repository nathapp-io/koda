import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

export interface CreateQueryMetricInput {
  projectId: string;
  intent: string;
  latencyMs: number;
  tokensUsed?: number | null;
  hadProvenance: boolean;
  staleHitCount: number;
  resultCount: number;
  leakageIncidentCount?: number;
  docId?: string | null;
}

export interface QueryMetricRecord {
  latencyMs: number;
  staleHitCount: number;
  resultCount: number;
  hadProvenance: boolean;
  leakageIncidentCount: number;
}

@Injectable()
export class PrismaMonitoringRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async createQueryMetric(data: CreateQueryMetricInput): Promise<void> {
    await this.prisma.client.memoryQueryMetric.create({
      data: {
        projectId: data.projectId,
        intent: data.intent,
        latencyMs: data.latencyMs,
        tokensUsed: data.tokensUsed ?? null,
        hadProvenance: data.hadProvenance,
        staleHitCount: data.staleHitCount,
        resultCount: data.resultCount,
        leakageIncidentCount: data.leakageIncidentCount ?? 0,
        docId: data.docId ?? null,
      },
    });
  }

  async findQueryMetrics(timeWindow: { from: Date; to: Date }): Promise<QueryMetricRecord[]> {
    return this.prisma.client.memoryQueryMetric.findMany({
      where: {
        createdAt: { gte: timeWindow.from, lte: timeWindow.to },
      },
      select: {
        latencyMs: true,
        staleHitCount: true,
        resultCount: true,
        hadProvenance: true,
        leakageIncidentCount: true,
      },
    });
  }

  async countMemoryItems(timeWindow: { from: Date; to: Date }): Promise<number> {
    return this.prisma.client.memoryItem.count({
      where: {
        createdAt: { gte: timeWindow.from, lte: timeWindow.to },
      },
    });
  }
}
