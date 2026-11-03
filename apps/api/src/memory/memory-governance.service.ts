import { Injectable, Logger } from '@nestjs/common';
import { PageOption } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItem, ProjectMemoryQuery, MemoryItemOwner, memoryOwnerKey } from './memory-item-repository';
import { MemoryKind, MemoryScope } from '../common/enums';

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

  /**
   * memory-notes US-002/US-005: one memory item by id, or null.
   *
   * The row is read through the repository and answered only when it is not soft-deleted and is either a row of
   * `projectId` or — US-005 — a user-scoped row whose `ownerKey` is the owner's. Every other case — an id of
   * another project, another principal's user note, a deleted row, an id that names nothing — is the same null,
   * so a caller cannot tell a foreign id from a missing one. This is what `koda_get_memory` reads, and the owner
   * is the caller the tool built from its context, never an id the model named.
   */
  async getMemoryItem(projectId: string, id: string, owner?: MemoryItemOwner): Promise<MemoryItem | null> {
    const item = await this.repository.findById(id);
    if (!item || item.deletedAt !== undefined) return null;
    if (item.projectId === projectId) return item;
    if (owner !== undefined && item.scope === MemoryScope.USER && item.ownerKey === memoryOwnerKey(owner)) {
      return item;
    }
    return null;
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