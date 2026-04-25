import { Injectable } from '@nestjs/common';
import { MemoryItemRepository, MemoryItem } from './memory-item-repository';
import { MemoryKind } from '../common/enums';

export interface GovernanceResult {
  expiredCount: number;
  downrankedCount: number;
  deduplicatedCount: number;
  supersessionCount: number;
}

@Injectable()
export class MemoryGovernanceService {
  constructor(private readonly repository: MemoryItemRepository) {}

  async runCleanup(projectId: string): Promise<GovernanceResult> {
    const [expiredResult, downrankedResult, deduplicatedResult, supersessionResult] = await Promise.all([
      this.expireMemories(projectId),
      this.downrankStaleLowConfidence(projectId),
      this.deduplicate(projectId),
      this.applySupersession(projectId),
    ]);

    return {
      expiredCount: expiredResult.count,
      downrankedCount: downrankedResult.count,
      deduplicatedCount: deduplicatedResult.count,
      supersessionCount: supersessionResult.count,
    };
  }

  async expireMemories(projectId: string): Promise<{ count: number }> {
    const now = new Date();
    const result = await this.repository.findByProject({
      projectId,
      page: 1,
      limit: 100,
    });

    const expiredItems = result.data.filter(
      (item) => item.ttlAt && item.ttlAt < now && item.status === 'active',
    );

    for (const item of expiredItems) {
      await this.repository.upsert({
        ...item,
        id: item.id,
        kind: item.kind as MemoryKind,
        status: 'rejected',
        activeKey: null,
      });
    }

    return { count: expiredItems.length };
  }

  async downrankStaleLowConfidence(projectId: string): Promise<{ count: number }> {
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const result = await this.repository.findByProject({
      projectId,
      page: 1,
      limit: 100,
    });

    const staleItems = result.data.filter(
      (item) =>
        item.createdAt < ninetyDaysAgo &&
        item.confidence !== undefined &&
        item.confidence < 0.3 &&
        item.status === 'active',
    );

    for (const item of staleItems) {
      await this.repository.upsert({
        ...item,
        id: item.id,
        kind: item.kind as MemoryKind,
        confidence: 0.1,
      });
    }

    return { count: staleItems.length };
  }

  async deduplicate(projectId: string): Promise<{ count: number }> {
    const result = await this.repository.findByProject({
      projectId,
      page: 1,
      limit: 100,
    });

    const activeItems = result.data.filter((item) => item.status === 'active' && item.activeKey);

    const groups = new Map<string, MemoryItem[]>();
    for (const item of activeItems) {
      const key = `${item.kind}:${item.subject}:${item.predicate}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      const group = groups.get(key);
      if (group) {
        group.push(item);
      }
    }

    let supersededCount = 0;
    for (const [, items] of groups) {
      if (items.length > 1) {
        const sorted = [...items].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
        const highest = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          await this.repository.upsert({
            ...sorted[i],
            id: sorted[i].id,
            kind: sorted[i].kind as MemoryKind,
            status: 'superseded',
            supersededBy: highest.id,
            activeKey: null,
          });
          supersededCount++;
        }
      }
    }

    return { count: supersededCount };
  }

  async applySupersession(projectId: string): Promise<{ count: number }> {
    const result = await this.repository.findByProject({
      projectId,
      kind: MemoryKind.DECISION,
      page: 1,
      limit: 100,
    });

    const activeDecisions = result.data.filter((item) => item.status === 'active' && item.activeKey);

    if (activeDecisions.length <= 1) {
      return { count: 0 };
    }

    const sorted = [...activeDecisions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const newest = sorted[0];

    let supersededCount = 0;
    for (let i = 1; i < sorted.length; i++) {
      await this.repository.upsert({
        ...sorted[i],
        id: sorted[i].id,
        kind: sorted[i].kind as MemoryKind,
        status: 'superseded',
        supersededBy: newest.id,
      });
      supersededCount++;
    }

    return { count: supersededCount };
  }
}