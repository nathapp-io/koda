import { Injectable, Logger } from '@nestjs/common';
import { MemoryItemRepository, MemoryItem } from './memory-item-repository';
import { MemoryKind } from '../common/enums';

export interface GovernanceResult {
  expiredCount: number;
  downrankedCount: number;
  deduplicatedCount: number;
  supersessionCount: number;
  durationMs: number;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10_000;

@Injectable()
export class MemoryGovernanceService {
  private readonly logger = new Logger(MemoryGovernanceService.name);

  constructor(private readonly repository: MemoryItemRepository) {}

  async runCleanup(projectId: string): Promise<GovernanceResult> {
    const start = Date.now();

    const expiredResult = await this.expireMemories(projectId);
    const downrankedResult = await this.downrankStaleLowConfidence(projectId);
    const deduplicatedResult = await this.deduplicate(projectId);
    const supersessionResult = await this.applySupersession(projectId);

    return {
      expiredCount: expiredResult.count,
      downrankedCount: downrankedResult.count,
      deduplicatedCount: deduplicatedResult.count,
      supersessionCount: supersessionResult.count,
      durationMs: Date.now() - start,
    };
  }

  async expireMemories(projectId: string): Promise<{ count: number }> {
    const now = new Date();
    let page = 1;
    let expiredCount = 0;
    let hasMore = true;

    do {
      if (page > MAX_PAGES) {
        this.logger.warn(`expireMemories: pagination exceeded ${MAX_PAGES} pages for project ${projectId}`);
        break;
      }
      const result = await this.repository.findByProject({
        projectId,
        status: 'active',
        page,
        limit: PAGE_SIZE,
      });

      hasMore = result.data.length >= PAGE_SIZE;

      const expiredItems = result.data.filter(
        (item) => item.ttlAt && item.ttlAt < now,
      );

      for (const item of expiredItems) {
        await this.repository.updateDirect(item.id, {
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
      if (page > MAX_PAGES) {
        this.logger.warn(`downrankStaleLowConfidence: pagination exceeded ${MAX_PAGES} pages for project ${projectId}`);
        break;
      }
      const result = await this.repository.findByProject({
        projectId,
        status: 'active',
        page,
        limit: PAGE_SIZE,
      });

      hasMore = result.data.length >= PAGE_SIZE;

      const staleItems = result.data.filter(
        (item) =>
          item.createdAt < ninetyDaysAgo &&
          item.confidence < 0.3,
      );

      for (const item of staleItems) {
        await this.repository.updateDirect(item.id, { confidence: 0.1 });
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

    while (hasMore && page <= MAX_PAGES) {
      if (page > MAX_PAGES) {
        this.logger.warn(`deduplicate: pagination exceeded ${MAX_PAGES} pages for project ${projectId}`);
        break;
      }
      const result = await this.repository.findByProject({
        projectId,
        status: 'active',
        page,
        limit: PAGE_SIZE,
      });

      hasMore = result.data.length >= PAGE_SIZE;

      const groups = new Map<string, MemoryItem[]>();
      for (const item of result.data) {
        const key = `${item.kind}:${item.subject}:${item.predicate}`;
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        const group = groups.get(key);
        if (group) {
          group.push(item);
        }
      }

      for (const [, group] of groups) {
        if (group.length <= 1) {
          continue;
        }

        const sorted = [...group].sort((a, b) => b.confidence - a.confidence);
        const winner = sorted[0];

        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].activeKey) {
            await this.repository.updateDirect(sorted[i].id, {
              status: 'superseded',
              supersededBy: winner.id,
              activeKey: null,
            });
            supersededCount++;
          }
        }
      }

      page++;
    }

    return { count: supersededCount };
  }

  async applySupersession(projectId: string): Promise<{ count: number }> {
    let page = 1;
    let supersededCount = 0;
    let hasMore = true;

    while (hasMore && page <= MAX_PAGES) {
      if (page > MAX_PAGES) {
        this.logger.warn(`applySupersession: pagination exceeded ${MAX_PAGES} pages for project ${projectId}`);
        break;
      }
      const result = await this.repository.findByProject({
        projectId,
        kind: MemoryKind.DECISION,
        status: 'active',
        page,
        limit: PAGE_SIZE,
      });

      hasMore = result.data.length >= PAGE_SIZE;

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

        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].activeKey) {
            await this.repository.updateDirect(sorted[i].id, {
              status: 'superseded',
              supersededBy: newest.id,
              activeKey: null,
            });
            supersededCount++;
          }
        }
      }

      page++;
    }

    return { count: supersededCount };
  }
}