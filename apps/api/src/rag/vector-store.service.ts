import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { RAG_CFG, IRagConfig } from '../config/rag.config';
import { ValidationAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaRagRepository } from './prisma-rag.repository';
import { EmbeddingService } from './embedding.service';
import { FTS_OPTIMIZE_STRATEGY, FtsOptimizeStrategy } from './strategies/fts-optimize-strategy.interface';
import { LexicalIndex } from './lexical-index';
import { EntityStore } from './entity-store';
import { LanceTableManager } from './lance-table-manager';
import type { LanceRecord, LanceTable } from './lance-table-manager';
import { simpleFtsScore, reciprocalRankFusion, getSimilarityTier, getVerdict } from './rag.service';
import type { IndexDocumentInput } from './rag.service';
import type { KbResultDto, SearchKbResponseDto } from './dto/kb-result.dto';

function generateId(): string {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

@Injectable()
export class VectorStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VectorStore.name);
  /**
   * Shared LanceDB connection/table/mutex owner. In production, RagModule
   * provides ONE LanceTableManager instance that is injected into both
   * VectorStore and HybridRetrieverService, so all writes to the same
   * `project_<id>` table are serialized and deletes are visible to both
   * services (H7). When not injected (direct construction in unit tests),
   * a private manager is created for this service alone.
   */
  private readonly lanceTable: LanceTableManager;
  private readonly similarityHigh: number;
  private readonly similarityMedium: number;
  private readonly similarityLow: number;
  private readonly ftsIndexMode: string;

  constructor(
    @Inject(RAG_CFG) ragConfig: IRagConfig,
    @Optional() private readonly embeddingService?: EmbeddingService,
    @Optional() @Inject(FTS_OPTIMIZE_STRATEGY) private readonly optimizeStrategy?: FtsOptimizeStrategy,
    @Optional() private readonly ragRepository?: PrismaRagRepository,
    @Optional() private readonly lexicalIndex?: LexicalIndex,
    @Optional() private readonly entityStore?: EntityStore,
    @Optional() lanceTableManager?: LanceTableManager,
  ) {
    this.lanceTable = lanceTableManager ?? new LanceTableManager(ragConfig, embeddingService);
    this.similarityHigh = ragConfig.similarityHigh;
    this.similarityMedium = ragConfig.similarityMedium;
    this.similarityLow = ragConfig.similarityLow;
    this.ftsIndexMode = ragConfig.ftsIndexMode;

    if (ragConfig.inMemoryOnly) {
      this.logger.log('RAG is running in in-memory mode; LanceDB native module will not be loaded');
    }
  }

  // --- Compatibility surface -------------------------------------------------
  // Connection state, the table cache, and availability now live on the shared
  // LanceTableManager. These accessors keep the historical internal surface
  // (used extensively by vector-store.service.spec.ts) working by delegating to
  // the manager; they are not part of the service's behavioral API.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get db(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.lanceTable as any).db;
  }

  set db(value: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.lanceTable as any).db = value;
  }

  get lanceAvailable(): boolean {
    return this.lanceTable.available;
  }

  set lanceAvailable(value: boolean) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.lanceTable as any).lanceAvailable = value;
  }

  get tableCache(): Map<string, LanceTable> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.lanceTable as any).tableCache;
  }

  set tableCache(value: Map<string, LanceTable>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.lanceTable as any).tableCache = value;
  }

  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    this.lanceTable.ensureStorage();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.optimizeStrategy) {
      await this.optimizeStrategy.onDestroy();
    }

    await this.lanceTable.close();
  }

  clearProjectCaches(projectId: string): void {
    this.lanceTable.evictTable(`project_${projectId}`);
    this.lexicalIndex?.clearProject(projectId);
    this.entityStore?.clear(projectId);
    this.optimizeStrategy?.clearProject?.(projectId);
  }

  /**
   * Validates project ID format and existence.
   *
   * Public because RagService.importGraphify also needs to validate a
   * projectId before choosing between the incremental-diff and full-reimport
   * paths, in addition to every LanceDB-touching method below calling it.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async validateProjectId(projectId: string): Promise<void> {
    // Check if projectId is empty or whitespace-only
    if (!projectId || typeof projectId !== 'string' || projectId.trim().length === 0) {
      const exception = new ForbiddenAppException({}, 'rag');
      exception.message = 'Project ID is required';
      throw exception;
    }

    // Only perform format and existence validation when the repository is available.
    // This ensures the RAG service can still be used in tests or contexts without the database.
    if (!this.ragRepository) {
      return;
    }

    // Check if projectId matches CUID format: lowercase alphanumeric, 21+ characters
    // CUIDs are typically 24-25 characters and contain only lowercase letters and numbers
    if (!/^[a-z0-9]{21,}$/.test(projectId)) {
      const exception = new ForbiddenAppException({}, 'rag');
      exception.message = 'Project ID is invalid';
      throw exception;
    }

    // Verify project exists in the database
    const project = await this.ragRepository.findProjectById(projectId);

    if (!project || project.deletedAt !== null) {
      const exception = new ForbiddenAppException({}, 'rag');
      exception.message = 'Project not found or deleted';
      throw exception;
    }
  }

  /**
   * Gets or creates a LanceDB table for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async getOrCreateTable(projectId: string): Promise<LanceTable> {
    await this.validateProjectId(projectId);

    if (this.ftsIndexMode === 'eager') {
      this.logger.warn('FTS_INDEX_MODE=eager is not yet implemented — using in-memory FTS fallback');
    }

    const optimizeStrategy = this.optimizeStrategy;
    return this.lanceTable.getOrCreateTable(`project_${projectId}`, {
      onFirstAccess: optimizeStrategy
        ? (table) => {
            if (!this.lanceTable.available) return Promise.resolve();
            return optimizeStrategy.onFirstAccess(projectId, table);
          }
        : undefined,
    });
  }

  /**
   * Indexes a document in the knowledge base for a project.
   *
   * This is the single KB write path used by the controller (H7): the document
   * is written once, through the shared LanceTableManager, so HybridRetriever
   * reads the same row from the shared table. Re-indexing the same sourceId
   * replaces the previous row (manager.addRecord) instead of duplicating it.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async indexDocument(projectId: string, doc: IndexDocumentInput): Promise<void> {
    await this.validateProjectId(projectId);

    if (!this.embeddingService) {
      this.logger.warn('EmbeddingService not available — skipping RAG indexing');
      return;
    }

    const tableName = `project_${projectId}`;
    let vector: number[];
    try {
      vector = await this.embeddingService.embed(doc.content);
    } catch (err) {
      // Embedding service unreachable — store content-only with zero vector for FTS
      this.logger.warn(`Embedding failed (${(err as Error).message}) — storing with zero vector`);
      const dims = this.embeddingService?.dimensions ?? 768;
      vector = Array(dims).fill(0) as number[];
    }

    // createdAtOverride lets callers backdate a record's created_at (matches
    // the previous HybridRetrieverService.indexDocument behavior).
    const createdAtOverride = doc.metadata?.['createdAtOverride'];
    const createdAt =
      typeof createdAtOverride === 'string' ? createdAtOverride : new Date().toISOString();

    const record: LanceRecord = {
      id: generateId(),
      source: doc.source,
      source_id: doc.sourceId,
      content: doc.content,
      vector,
      metadata: JSON.stringify(doc.metadata ?? {}),
      created_at: createdAt,
      provider: this.embeddingService.providerName,
      model: this.embeddingService.modelName,
    };

    const table = await this.getOrCreateTable(projectId);
    await this.lanceTable.addRecord(tableName, table, record);

    if (this.lanceTable.available && this.optimizeStrategy) {
      await this.optimizeStrategy.onInsert(projectId, table);
    }
    if (this.lexicalIndex) {
      this.lexicalIndex.addDocument(projectId, { id: doc.sourceId, content: doc.content });
    }
  }

  /**
   * Searches the knowledge base for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async search(
    projectId: string,
    query: string,
    limit = 5,
  ): Promise<SearchKbResponseDto> {
    const searchStartTime = new Date();
    const emptyResponse = (): SearchKbResponseDto => ({
      results: [],
      verdict: 'no_match',
      provenance: { retrievedAt: searchStartTime.toISOString(), sources: [] },
    });

    try {
      await this.validateProjectId(projectId);

      if (!this.embeddingService) {
        return emptyResponse();
      }

      const table = await this.getOrCreateTable(projectId);
      const rowCount: number = await table.countRows();
      if (rowCount === 0) {
        return emptyResponse();
      }

      const fetchLimit = Math.min(rowCount, limit * 4);
      const scanLimit = Math.min(rowCount, 500);
      const allRows: LanceRecord[] = await table.query().limit(scanLimit).toArray();

      // Native FTS path when LanceDB is available; fall back to in-memory simpleFtsScore
      let nativeFtsRows: LanceRecord[] = [];
      let ftsRanked: { id: string; score: number }[];

      if (this.lanceTable.available) {
        let nativeFtsFailed = false;
        try {
          const nativeFtsResult = await table.search(query, 'fts', 'content');

          if (Array.isArray(nativeFtsResult)) {
            nativeFtsRows = nativeFtsResult as LanceRecord[];
          } else if (
            nativeFtsResult &&
            typeof nativeFtsResult === 'object' &&
            'toArray' in nativeFtsResult &&
            typeof (nativeFtsResult as { toArray?: unknown }).toArray === 'function'
          ) {
            nativeFtsRows = await (nativeFtsResult as { toArray: () => Promise<LanceRecord[]> }).toArray();
          } else {
            nativeFtsFailed = true;
            this.logger.warn('Native FTS returned unsupported shape — using in-memory FTS');
          }
        } catch (err) {
          nativeFtsFailed = true;
          this.logger.warn(`Native FTS search failed (${(err as Error).message}) — using in-memory FTS`);
        }
        if (nativeFtsFailed) {
          // Fall back to in-memory FTS when native FTS is unavailable
          ftsRanked = allRows
            .map((r) => ({ id: r.id as string, score: simpleFtsScore(r.content as string, query) }))
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, fetchLimit);
        } else {
          // Score by reciprocal position: 1/(i+1)
          ftsRanked = nativeFtsRows.map((r, i) => ({ id: r.id as string, score: 1 / (i + 1) }));
        }
      } else {
        ftsRanked = allRows
          .map((r) => ({ id: r.id as string, score: simpleFtsScore(r.content as string, query) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, fetchLimit);
      }

      const ftsScoreMap = new Map<string, number>(ftsRanked.map((r) => [r.id, r.score]));

      // Skip vector search when LanceDB is unavailable — use pure FTS
      let vectorRows: LanceRecord[] = [];
      if (this.lanceTable.available) {
        try {
          const queryVector = await this.embeddingService.embed(query);
          vectorRows = await table
            .vectorSearch(queryVector)
            .distanceType('cosine')
            .limit(fetchLimit)
            .toArray();
        } catch (err) {
          this.logger.warn(`Vector search failed (${(err as Error).message}) — using FTS only`);
        }
      }

      // RRF merge (or pure FTS when vector unavailable)
      const merged = vectorRows.length > 0
        ? reciprocalRankFusion(
            vectorRows.map((r) => ({ id: r.id as string })),
            ftsRanked.map((r) => ({ id: r.id })),
          )
        : ftsRanked.slice(0, limit).map((r) => ({ id: r.id, score: r.score }));

      // Build id → record lookup (include nativeFtsRows so FTS-only records resolve)
      const recordMap = new Map<string, LanceRecord>();
      allRows.forEach((r) => recordMap.set(r.id as string, r));
      vectorRows.forEach((r) => recordMap.set(r.id as string, r));
      nativeFtsRows.forEach((r) => recordMap.set(r.id as string, r));

      // Build vectorSimilarity lookup (1 - cosine_distance)
      const simMap = new Map<string, number>();
      vectorRows.forEach((r) => {
        const dist = typeof r._distance === 'number' ? r._distance : 1;
        simMap.set(r.id as string, Math.max(0, 1 - dist));
      });

      const results: KbResultDto[] = merged
        .slice(0, limit)
        .map(({ id }) => {
          const record = recordMap.get(id);
          if (!record) return null;

          const score = simMap.get(id) ?? ftsScoreMap.get(id) ?? 0;
          const similarity = getSimilarityTier(
            score,
            this.similarityHigh,
            this.similarityMedium,
            this.similarityLow,
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const meta = (() => { try { return JSON.parse(record.metadata as string) as Record<string, unknown>; } catch { return {}; } })();

          const result: KbResultDto = {
            id: record.id as string,
            source: record.source as 'ticket' | 'doc' | 'manual' | 'code',
            sourceId: record.source_id as string,
            content: record.content as string,
            score,
            similarity,
            metadata: meta,
            createdAt: record.created_at as string,
            provenance: {
              indexedAt: record.created_at as string,
              sourceProjectId: projectId,
            },
          };
          return result;
        })
        .filter((r): r is KbResultDto => r !== null);

      const topScore = results[0]?.score ?? 0;
      const verdict = getVerdict(topScore, this.similarityHigh, this.similarityMedium);

      // Build unique sources from recordMap (defensive approach — source of truth is the records)
      const sourceSet = new Set<string>();
      const sources: Array<{ sourceType: 'ticket' | 'doc' | 'manual' | 'code'; sourceId: string }> = [];
      for (const result of results) {
        const record = recordMap.get(result.id);
        if (record) {
          const sourceKey = `${record.source}:${record.source_id}`;
          if (!sourceSet.has(sourceKey)) {
            sourceSet.add(sourceKey);
            sources.push({
              sourceType: record.source as 'ticket' | 'doc' | 'manual' | 'code',
              sourceId: record.source_id as string,
            });
          }
        }
      }

      return {
        results,
        verdict,
        provenance: {
          retrievedAt: searchStartTime.toISOString(),
          sources,
        },
      };
    } catch (err) {
      this.logger.error(`Search failed for project ${projectId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Lists documents in the knowledge base for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async listDocuments(projectId: string, limit = 100): Promise<KbResultDto[]> {
    await this.validateProjectId(projectId);

    const table = await this.getOrCreateTable(projectId);
    const rowCount: number = await table.countRows();
    if (rowCount === 0) return [];

    const rows: LanceRecord[] = await table.query().limit(limit).toArray();

    return rows.map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = (() => { try { return JSON.parse(r.metadata as string) as Record<string, unknown>; } catch { return {}; } })();
      return {
        id: r.id as string,
        source: r.source as 'ticket' | 'doc' | 'manual' | 'code',
        sourceId: r.source_id as string,
        content: r.content as string,
        score: 0,
        similarity: 'none' as const,
        metadata: meta,
        createdAt: r.created_at as string,
        provenance: {
          indexedAt: r.created_at as string,
          sourceProjectId: projectId,
        },
      };
    });
  }

  /**
   * Deletes documents by source ID in the knowledge base for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async deleteBySource(projectId: string, sourceId: string): Promise<void> {
    await this.validateProjectId(projectId);

    // Graph/code source IDs are often path-like, so allow punctuation used in
    // repo paths while rejecting quote/control characters used to break filters.
    if (
      !sourceId ||
      sourceId.includes("'") ||
      [...sourceId].some((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      throw new ValidationAppException();
    }
    const table = await this.getOrCreateTable(projectId);
    await this.lanceTable.exclusive(`project_${projectId}`, () => table.delete(`source_id = '${sourceId}'`));
    if (this.lexicalIndex) {
      this.lexicalIndex.removeDocument(projectId, sourceId);
    }
  }

  /**
   * Validates the embedding provider for a project's table.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async validateTableProvider(projectId: string): Promise<{ valid: boolean; message?: string }> {
    await this.validateProjectId(projectId);

    if (!this.embeddingService) return { valid: true };

    const table = await this.lanceTable.openTableIfLance(`project_${projectId}`);
    if (!table) {
      return { valid: true };
    }

    const rowCount: number = await table.countRows();
    if (rowCount === 0) return { valid: true };

    const rows: LanceRecord[] = await table.query().limit(1).toArray();
    const firstRow = rows[0];
    if (!firstRow) return { valid: true };

    const currentProvider = this.embeddingService.providerName;
    const currentModel = this.embeddingService.modelName;

    if (firstRow.provider !== currentProvider || firstRow.model !== currentModel) {
      const msg = `Table project_${projectId} was created with provider=${firstRow.provider}/model=${firstRow.model}, but current config uses provider=${currentProvider}/model=${currentModel}. Results may be inconsistent.`;
      this.logger.warn(msg);
      return { valid: false, message: msg };
    }

    return { valid: true };
  }

  /**
   * Optimizes the LanceDB table for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async optimizeTable(projectId: string): Promise<void> {
    await this.validateProjectId(projectId);

    if (!this.lanceTable.available) {
      return;
    }

    const table = await this.getOrCreateTable(projectId);
    await this.lanceTable.exclusive(`project_${projectId}`, () => table.optimize());
  }

  /**
   * Deletes all documents by source type in the knowledge base for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async deleteAllBySourceType(projectId: string, sourceType: string): Promise<number> {
    await this.validateProjectId(projectId);

    const validSources = ['ticket', 'doc', 'manual', 'code'];
    if (!validSources.includes(sourceType)) {
      throw new ValidationAppException();
    }

    const table = await this.getOrCreateTable(projectId);
    const countBefore = await table.countRows();
    if (countBefore === 0) return 0;

    await this.lanceTable.exclusive(`project_${projectId}`, () => table.delete(`source = '${sourceType}'`));

    const countAfter = await table.countRows();
    return countBefore - countAfter;
  }
}
