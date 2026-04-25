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
    const expiredResult = await this.expireMemories(projectId);
    const downrankedResult = await this.downrankStaleLowConfidence(projectId);
    const deduplicatedResult = await this.deduplicate(projectId);
    const supersessionResult = await this.applySupersession(projectId);

    return {
      expiredCount: expiredResult.count,
      downrankedCount: downrankedResult.count,
      deduplicatedCount: deduplicatedResult.count,
      supersessionCount: supersessionResult.count,
    };
  }

  async expireMemories(projectId: string): Promise<{ count: number }> {
    const now = new Date();
    let page = 1;
    let expiredCount = 0;
    let hasMore = true;

    do {
      const result = await this.repository.findByProject({
        projectId,
        status: 'active',
        page,
        limit: 100,
      });

      hasMore = result.data.length === 100;

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
        expiredCount++;
      }

      page++;
    } while (hasMore);

    return { count: expiredCount };
  }

  async downrankStaleLowConfidence(projectId: string): Promise<{ count: number }> {
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    let page = 1;
    let downrankedCount = 0;
    let hasMore = true;

    do {
      const result = await this.repository.findByProject({
        projectId,
        status: 'active',
        page,
        limit: 100,
      });

      hasMore = result.data.length === 100;

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
        downrankedCount++;
      }

      page++;
    } while (hasMore);

    return { count: downrankedCount };
  }

  async deduplicate(projectId: string): Promise<{ count: number }> {
    let page = 1;
    let supersededCount = 0;
    let hasMore = true;

    do {
      const result = await this.repository.findByProject({
        projectId,
        status: 'active',
        page,
        limit: 100,
      });

      hasMore = result.data.length === 100;

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

      for (const [, items] of groups) {
        if (items.length > 1) {
          const sorted = [...items].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
          const activeCandidate = sorted.find((item) => item.status === 'active' && item.activeKey);
          if (!activeCandidate) {
            continue;
          }
          for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].status === 'active' && sorted[i].activeKey) {
              await this.repository.upsert({
                ...sorted[i],
                id: sorted[i].id,
                kind: sorted[i].kind as MemoryKind,
                status: 'superseded',
                supersededBy: activeCandidate.id,
                activeKey: null,
              });
              supersededCount++;
            }
          }
        }
      }

      page++;
    } while (hasMore);

    return { count: supersededCount };
  }

  async applySupersession(projectId: string): Promise<{ count: number }> {
    let page = 1;
    let supersededCount = 0;
    let hasMore = true;

    do {
      const result = await this.repository.findByProject({
        projectId,
        kind: MemoryKind.DECISION,
        status: 'active',
        page,
        limit: 100,
      });

      hasMore = result.data.length === 100;

      const activeDecisions = result.data.filter((item) => item.status === 'active' && item.activeKey);

      if (activeDecisions.length > 1) {
        const sorted = [...activeDecisions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const newest = sorted[0];

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
      }

      page++;
    } while (hasMore);

    return { count: supersededCount };
  }
}