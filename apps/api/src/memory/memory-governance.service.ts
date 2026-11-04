import { Injectable, Logger } from '@nestjs/common';
import { PageOption, ValidationAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItem, ProjectMemoryQuery, MemoryItemOwner, memoryOwnerKey } from './memory-item-repository';
import { decodeMemoryExportCursor, encodeMemoryExportCursor } from './memory-export-cursor';
import { MemoryKind, MemoryScope } from '../common/enums';

export interface GovernanceResult {
  expiredCount: number;
  downrankedCount: number;
  deduplicatedCount: number;
  supersessionCount: number;
  durationMs: number;
}

/**
 * memory-notes US-006: how far behind the server clock a row's `updatedAt` must be before the export
 * hands it out.
 *
 * `updatedAt` is stamped by the writing transaction's clock, and a row's commit can become visible after a
 * read that already ran with a later position. A mirror that stored the cursor of the last row it saw would
 * then never ask for that row again — it would silently miss the change. Holding back everything inside
 * this window means the row is answered by the next call, when the caller's cursor is still behind it, and it
 * is why the read bounds `updatedAt` strictly (`<`): the cursor a caller stores never lands on a timestamp an
 * uncommitted transaction may still be writing at.
 */
export const MEMORY_EXPORT_SETTLE_MS = 5000;

/**
 * memory-notes US-006: one export page — the changed rows, the cursor that continues after the last of them,
 * and whether this page was full.
 *
 * `nextCursor` is the last row's own cursor, or the `since` the caller gave when the page is empty (null when
 * it gave none), so storing it unconditionally is safe. `hasMore` is `items.length === take`: a full page is
 * worth another call. The rows are exactly as stored — every status, kind and soft-deleted row, with its
 * `deletedAt` — because fencing belongs to the LLM prompt the MCP tools build, not to the feed.
 */
export interface MemoryExportPage {
  items: MemoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
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
   * memory-notes US-006: one page of the incremental memory feed a mirror replays.
   *
   * The method composes the three inputs of the read: the cursor (`since`, decoded here so an unreadable one is
   * a 400 naming `since` before anything is read), the settle window, which ends `MEMORY_EXPORT_SETTLE_MS`
   * before the clock, and the page — the caller's authorized union, the project's rows plus the caller's own
   * user rows, every status, kind and soft-deleted row included. A blank `since` is no cursor at all: a client
   * that sends an empty value is asking for the feed from its beginning.
   */
  async exportProjectMemory(
    projectId: string,
    owner: MemoryItemOwner,
    since: string | undefined,
    take: number,
  ): Promise<MemoryExportPage> {
    const given = since !== undefined && since.trim().length > 0 ? since : undefined;
    const after = given === undefined ? null : decodeMemoryExportCursor(given);
    if (given !== undefined && after === null) {
      throw new ValidationAppException({ field: 'since' }, 'memory.export');
    }

    const until = new Date(Date.now() - MEMORY_EXPORT_SETTLE_MS);
    const items = await this.repository.findChangedAfter(
      { projectId, ownerKey: memoryOwnerKey(owner) },
      after,
      until,
      take,
    );

    const last = items[items.length - 1];
    return {
      items,
      nextCursor: last
        ? encodeMemoryExportCursor({ updatedAt: last.updatedAt, id: last.id })
        : given ?? null,
      hasMore: items.length === take,
    };
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