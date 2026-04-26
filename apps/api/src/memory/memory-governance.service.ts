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
        (item) => item.ttlAt && item.ttlAt < now,
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
          item.confidence < 0.3,
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

      // Group by (kind, subject, predicate) — skip items already superseded in this run
      const groups = new Map<string, { item: MemoryItem; supersededInRun: boolean }[]>();
      for (const item of result.data) {
        const key = `${item.kind}:${item.subject}:${item.predicate}`;
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        const group = groups.get(key);
        if (group) {
          group.push({ item, supersededInRun: false });
        }
      }

      for (const [, group] of groups) {
        if (group.length <= 1) {
          continue;
        }

        const sorted = [...group].sort((a, b) => (b.item.confidence ?? 0) - (a.item.confidence ?? 0));

        // Find the first item that is genuinely still active
        const activeCandidate = sorted.find(
          ({ item, supersededInRun }) => item.activeKey && !supersededInRun,
        );
        if (!activeCandidate) {
          continue;
        }

        // Mark lower-confidence items as superseded (skip already superseded in this run)
        for (let i = 1; i < sorted.length; i++) {
          const entry = sorted[i];
          if (entry.item.activeKey && !entry.supersededInRun) {
            await this.repository.upsert({
              ...entry.item,
              id: entry.item.id,
              kind: entry.item.kind as MemoryKind,
              status: 'superseded',
              supersededBy: activeCandidate.item.id,
              activeKey: null,
            });
            entry.supersededInRun = true;
            supersededCount++;
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

      // Group by topic (subject + predicate) — only apply supersession within each topic group
      const topicGroups = new Map<string, MemoryItem[]>();
      for (const item of result.data) {
        const topicKey = `${item.subject}:${item.predicate}`;
        if (!topicGroups.has(topicKey)) {
          topicGroups.set(topicKey, []);
        }
        const group = topicGroups.get(topicKey);
        if (group) {
          group.push(item);
        }
      }

      for (const [, topicDecisions] of topicGroups) {
        if (topicDecisions.length <= 1) {
          continue;
        }

        const sorted = [...topicDecisions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const newest = sorted[0];

        // Only supersede items that are still active and not the newest
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].activeKey) {
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
      }

      page++;
    } while (hasMore);

    return { count: supersededCount };
  }
}