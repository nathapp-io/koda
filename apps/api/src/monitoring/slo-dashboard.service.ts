import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

export interface MemoryQueryMetricInput {
  projectId: string;
  intent: string;
  latencyMs: number;
  tokensUsed?: number;
  hadProvenance: boolean;
  staleHitCount: number;
  resultCount: number;
  leakageIncidentCount?: number;
}

export interface SloMetrics {
  retrievalLatency: {
    p50: number;
    p95: number;
    p99: number;
    sampleCount: number;
  };
  staleHitRate: number;
  provenanceCoverage: number;
  leakageIncidents: number;
  memoryGrowthRate: number;
}

const STALE_HIT_THRESHOLD_DAYS = 7;

@Injectable()
export class SloDashboardService {
  private readonly logger = new Logger(SloDashboardService.name);

  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async recordQueryMetric(metric: MemoryQueryMetricInput): Promise<void> {
    await this.prisma.client.memoryQueryMetric.create({
      data: {
        projectId: metric.projectId,
        intent: metric.intent,
        latencyMs: metric.latencyMs,
        tokensUsed: metric.tokensUsed ?? null,
        hadProvenance: metric.hadProvenance,
        staleHitCount: metric.staleHitCount ?? 0,
        resultCount: metric.resultCount ?? 0,
        leakageIncidentCount: metric.leakageIncidentCount ?? 0,
      },
    });
  }

  async recordStaleHit(projectId: string, _docId: string): Promise<void> {
    await this.prisma.client.memoryQueryMetric.create({
      data: {
        projectId,
        intent: 'search',
        latencyMs: 0,
        tokensUsed: null,
        hadProvenance: true,
        staleHitCount: 1,
        resultCount: 1,
        leakageIncidentCount: 0,
      },
    });
  }

  async getSloMetrics(timeWindow: { from: Date; to: Date }): Promise<SloMetrics> {
    const records = await this.prisma.client.memoryQueryMetric.findMany({
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

    return {
      retrievalLatency: this.computeLatencyPercentiles(records),
      staleHitRate: this.computeStaleHitRate(records),
      provenanceCoverage: this.computeProvenanceCoverage(records),
      leakageIncidents: this.computeLeakageIncidents(records),
      memoryGrowthRate: await this.computeMemoryGrowthRate(timeWindow),
    };
  }

  isStaleHit(indexedAt: string): boolean {
    const ageMs = Date.now() - new Date(indexedAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return ageDays > STALE_HIT_THRESHOLD_DAYS;
  }

  private computeLatencyPercentiles(
    records: Array<{ latencyMs: number }>,
  ): SloMetrics['retrievalLatency'] {
    const latencies = records.map((r) => r.latencyMs);
    if (latencies.length === 0) {
      return { p50: 0, p95: 0, p99: 0, sampleCount: 0 };
    }
    return {
      p50: this.percentile(latencies, 50),
      p95: this.percentile(latencies, 95),
      p99: this.percentile(latencies, 99),
      sampleCount: latencies.length,
    };
  }

  private computeStaleHitRate(
    records: Array<{ staleHitCount: number; resultCount: number }>,
  ): number {
    const totalStale = records.reduce((sum, r) => sum + r.staleHitCount, 0);
    const totalResults = records.reduce((sum, r) => sum + r.resultCount, 0);
    if (totalResults === 0) return 0;
    const rate = totalStale / totalResults;
    return Math.min(Math.max(rate, 0), 1);
  }

  private computeProvenanceCoverage(
    records: Array<{ hadProvenance: boolean }>,
  ): number {
    if (records.length === 0) return 0;
    const withProvenance = records.filter((r) => r.hadProvenance).length;
    const coverage = withProvenance / records.length;
    return Math.min(Math.max(coverage, 0), 1);
  }

  private computeLeakageIncidents(
    records: Array<{ leakageIncidentCount: number }>,
  ): number {
    return records.reduce((sum, r) => sum + r.leakageIncidentCount, 0);
  }

  private async computeMemoryGrowthRate(
    timeWindow: { from: Date; to: Date },
  ): Promise<number> {
    const sevenDaysAgo = new Date(timeWindow.to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const from = sevenDaysAgo > timeWindow.from ? sevenDaysAgo : timeWindow.from;
    const count = await this.prisma.client.memoryItem.count({
      where: {
        createdAt: { gte: from, lte: timeWindow.to },
      },
    });
    const daysInWindow = Math.max(
      (timeWindow.to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24),
      1,
    );
    return Math.round(count / daysInWindow * 100) / 100;
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
  }
}
