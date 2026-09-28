import { Injectable, Logger } from '@nestjs/common';
import { PageOption } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItem, ProjectMemoryQuery } from './memory-item-repository';
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

  constructor(private readonly repository: PrismaMemoryItemRepository) {}

  async getProjectMemory(query: ProjectMemoryQuery, page: IPageOption): Promise<IPageResult<MemoryItem>> {
    return this.repository.findByProjectMemory(query, page);
  }

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
    let expiredCount = 0;
    let afterId: string | null = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.repository.findActiveAfterId(projectId, afterId, PAGE_SIZE);
      for (const item of batch) {
        if (item.ttlAt && item.ttlAt < now) {
          await this.repository.updateDirect(item.id, { status: 'rejected', activeKey: null });
          expiredCount++;
        }
      }
      if (batch.length < PAGE_SIZE) return { count: expiredCount };
      afterId = batch[batch.length - 1].id;
    }

    this.logger.warn(`expireMemories: pagination exceeded ${MAX_PAGES} pages for project ${projectId}`);
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
      const result = await this.repository.findByProject(
        { projectId, status: 'active' },
        PageOption.from(page, PAGE_SIZE),
      );

      hasMore = result.records.length >= PAGE_SIZE;

      const staleItems = result.records.filter(
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
    let supersededCount = 0;
    for (const key of await this.repository.findDuplicateActiveKeys(projectId)) {
      const group = await this.repository.findActiveByKey(projectId, key);
      supersededCount += await this.supersedeAllBut(group, (a, b) => b.confidence - a.confidence);
    }
    return { count: supersededCount };
  }

  async applySupersession(projectId: string): Promise<{ count: number }> {
    let supersededCount = 0;
    for (const key of await this.repository.findDuplicateActiveKeys(projectId, MemoryKind.DECISION)) {
      const group = await this.repository.findActiveByKey(projectId, key);
      supersededCount += await this.supersedeAllBut(group, (a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    return { count: supersededCount };
  }

  /** Keeps the first row under `rank` and supersedes the keyed rest; returns how many changed. */
  private async supersedeAllBut(group: MemoryItem[], rank: (a: MemoryItem, b: MemoryItem) => number): Promise<number> {
    if (group.length <= 1) return 0;
    const [winner, ...rest] = [...group].sort(rank);
    let count = 0;
    for (const item of rest) {
      if (item.activeKey) {
        await this.repository.updateDirect(item.id, { status: 'superseded', supersededBy: winner.id, activeKey: null });
        count++;
      }
    }
    return count;
  }
}