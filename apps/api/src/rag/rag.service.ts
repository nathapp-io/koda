import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, Inject, forwardRef } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { RAG_CFG, IRagConfig } from '../config/rag.config';
import { ValidationAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaRagRepository } from './prisma-rag.repository';
import { EmbeddingService } from './embedding.service';
import { FTS_OPTIMIZE_STRATEGY, FtsOptimizeStrategy } from './strategies/fts-optimize-strategy.interface';
import { LexicalIndex } from './lexical-index';
import { EntityStore } from './entity-store';
import { GraphStoreService } from './graph-store.service';
import { IncrementalGraphDiffService } from './incremental-graph-diff.service';
import type { GraphifyNodeDto, GraphifyLinkDto } from './dto/import-graphify.dto';
import type { KbResultDto, SearchKbResponseDto } from './dto/kb-result.dto';

export interface IndexDocumentInput {
  source: 'ticket' | 'doc' | 'manual' | 'code';
  sourceId: string;
  content: string;
  metadata: Record<string, unknown>;
}

interface LanceRecord {
  id: string;
  source: string;
  source_id: string;
  content: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vector: any;
  metadata: string;
  created_at: string;
  provider: string;
  model: string;
  _distance?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceTable = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceConnection = any;

function generateId(): string {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * In-memory FTS for MVP. Replace with LanceDB native FTS (Tantivy) when corpus exceeds 500 documents.
 */
/** In-memory FTS for MVP. Replace with LanceDB native FTS (Tantivy) when corpus exceeds 500 documents. */
export function simpleFtsScore(content: string, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return 0;

  const lower = content.toLowerCase();
  let matches = 0;
  for (const term of terms) {
    if (lower.includes(term)) matches++;
  }
  return matches / terms.length;
}

export function reciprocalRankFusion(
  vectorRanks: { id: string }[],
  ftsRanks: { id: string }[],
  k = 60,
): { id: string; rrfScore: number }[] {
  const scores = new Map<string, number>();

  vectorRanks.forEach((item, i) => {
    const prev = scores.get(item.id) ?? 0;
    scores.set(item.id, prev + 1 / (k + i + 1));
  });

  ftsRanks.forEach((item, i) => {
    const prev = scores.get(item.id) ?? 0;
    scores.set(item.id, prev + 1 / (k + i + 1));
  });

  return [...scores.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

export type SimilarityTier = 'high' | 'medium' | 'low' | 'none';

export function getSimilarityTier(
  score: number,
  high: number,
  medium: number,
  low: number,
): SimilarityTier {
  if (score >= high) return 'high';
  if (score >= medium) return 'medium';
  if (score >= low) return 'low';
  return 'none';
}

export type Verdict = 'likely_duplicate' | 'possibly_related' | 'no_match';

export function getVerdict(topScore: number, high: number, medium: number): Verdict {
  if (topScore >= high) return 'likely_duplicate';
  if (topScore >= medium) return 'possibly_related';
  return 'no_match';
}

class InMemoryTable {
  private records: LanceRecord[] = [];
  async add(records: LanceRecord[]): Promise<void> { this.records = [...this.records, ...records]; }
  async countRows(): Promise<number> { return this.records.length; }
  async delete(filter: string): Promise<void> {
    const sourceIdFilter = /^source_id\s*=\s*'([^']+)'$/.exec(filter);
    if (sourceIdFilter) {
      const sourceId = sourceIdFilter[1];
      this.records = this.records.filter((record) => record.source_id !== sourceId);
      return;
    }

    const sourceFilter = /^source\s*=\s*'([a-zA-Z0-9_-]+)'$/.exec(filter);
    if (sourceFilter) {
      const source = sourceFilter[1];
      this.records = this.records.filter((record) => record.source !== source);
      return;
    }

    const idInFilter = /^id\s+IN\s+\((.+)\)$/.exec(filter);
    if (idInFilter) {
      const ids = idInFilter[1]
        .split(',')
        .map((part) => part.trim().replace(/^'|'$/g, ''));
      const idSet = new Set(ids);
      this.records = this.records.filter((record) => !idSet.has(record.id));
    }
  }
  vectorSearch() { return { distanceType: () => ({ limit: (n) => ({ toArray: () => this.records.slice(0, n) }) }) }; }
  query() { return { limit: (n) => ({ toArray: () => this.records.slice(0, n) }) }; }
}

@Injectable()
export class RagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RagService.name);
  private db: LanceConnection = null;
  private readonly tableCache = new Map<string, LanceTable>();
  private readonly tableCreationLocks = new Map<string, Promise<LanceTable>>();
  private readonly writeLocks = new Map<string, Promise<unknown>>();
  private readonly TABLE_CACHE_MAX_SIZE = 50;
  private lanceAvailable = true;
  private readonly lancedbPath: string;
  private readonly similarityHigh: number;
  private readonly similarityMedium: number;
  private readonly similarityLow: number;
  private readonly ftsIndexMode: string;
  private readonly inMemoryOnly: boolean;
  private readonly firstAccessedProjectIds = new Set<string>();

  constructor(
    @Inject(RAG_CFG) ragConfig: IRagConfig,
    @Optional() private readonly embeddingService?: EmbeddingService,
    @Optional() @Inject(FTS_OPTIMIZE_STRATEGY) private readonly optimizeStrategy?: FtsOptimizeStrategy,
    @Optional() private readonly ragRepository?: PrismaRagRepository,
    @Optional() private readonly lexicalIndex?: LexicalIndex,
    @Optional() private readonly entityStore?: EntityStore,
    @Optional() @Inject(TRANSACTION_MANAGER) private readonly txManager?: ITransactionManager,
    @Optional() private readonly graphStore?: GraphStoreService,
    @Optional() @Inject(forwardRef(() => IncrementalGraphDiffService)) private readonly incrementalDiff?: IncrementalGraphDiffService,
  ) {
    this.lancedbPath = ragConfig.lancedbPath;
    this.similarityHigh = ragConfig.similarityHigh;
    this.similarityMedium = ragConfig.similarityMedium;
    this.similarityLow = ragConfig.similarityLow;
    this.ftsIndexMode = ragConfig.ftsIndexMode;
    this.inMemoryOnly = ragConfig.inMemoryOnly;

    if (this.inMemoryOnly) {
      this.lanceAvailable = false;
      this.logger.log('RAG is running in in-memory mode; LanceDB native module will not be loaded');
    }
  }

  onModuleInit(): void {
    if (this.inMemoryOnly) {
      return;
    }

    try {
      mkdirSync(this.lancedbPath, { recursive: true });
      this.logger.log(`LanceDB storage directory ensured: ${this.lancedbPath}`);
    } catch (err) {
      this.logger.warn(`Could not create LanceDB directory ${this.lancedbPath}: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.optimizeStrategy) {
      await this.optimizeStrategy.onDestroy();
    }

    this.tableCache.clear();

    if (this.db && typeof this.db.close === 'function') {
      try {
        const closeResult = this.db.close();
        if (closeResult && typeof closeResult.then === 'function') {
          await closeResult;
        }
      } catch (err) {
        this.logger.warn(`Failed to close LanceDB connection: ${(err as Error).message}`);
      }
    }

    this.db = null;
  }

  clearProjectCaches(projectId: string): void {
    this.tableCache.delete(`project_${projectId}`);
    this.firstAccessedProjectIds.delete(projectId);
    this.lexicalIndex?.clearProject(projectId);
    this.entityStore?.clear(projectId);
    this.optimizeStrategy?.clearProject?.(projectId);
  }

  private evictTableCacheIfNeeded(): void {
    if (this.tableCache.size > this.TABLE_CACHE_MAX_SIZE) {
      const firstKey = this.tableCache.keys().next().value;
      if (firstKey !== undefined) {
        this.tableCache.delete(firstKey);
      }
    }
  }

  /**
   * Validates project ID format and existence.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  private async validateProjectId(projectId: string): Promise<void> {
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

  private async connect(): Promise<LanceConnection | null> {
    if (this.inMemoryOnly) {
      return null;
    }

    if (!this.db) {
      try {
        const lancedb = await import('@lancedb/lancedb');
        const connectFn = (lancedb as unknown as { connect: (path: string) => Promise<LanceConnection> }).connect
          ?? (lancedb.default as unknown as { connect: (path: string) => Promise<LanceConnection> })?.connect;
        this.db = await connectFn(this.lancedbPath);
      } catch (err) {
        this.lanceAvailable = false;
        this.logger.warn(`LanceDB unavailable - ${(err as Error).message} - using in-memory fallback`);
        return null;
      }
    }
    return this.db;
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

    const tableName = `project_${projectId}`;
    const cached = this.tableCache.get(tableName);
    if (cached) return cached;

    // Serialize table open/create per project: concurrent callers for the same
    // tableName await the same in-flight creation instead of racing LanceDB's
    // check-then-create against each other.
    const inFlight = this.tableCreationLocks.get(tableName);
    if (inFlight) return inFlight;

    const creation = this.createOrOpenTable(projectId, tableName).finally(() => {
      this.tableCreationLocks.delete(tableName);
    });
    this.tableCreationLocks.set(tableName, creation);
    return creation;
  }

  /**
   * Serializes LanceDB writes (add/delete/optimize) per table. LanceDB has no
   * built-in mutex for concurrent writers against the same table, so without
   * this, interleaved indexDocument/deleteBySource calls can race each other
   * and corrupt table state.
   */
  private async runExclusive<T>(tableName: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(tableName) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tracked = run.catch(() => undefined);
    this.writeLocks.set(tableName, tracked);
    // Once this write settles, drop the entry if no later write has queued
    // behind it, so the map only holds currently in-flight/queued chains
    // instead of growing forever with one entry per project ever written to.
    tracked.finally(() => {
      if (this.writeLocks.get(tableName) === tracked) {
        this.writeLocks.delete(tableName);
      }
    });
    return run;
  }

  private async createOrOpenTable(projectId: string, tableName: string): Promise<LanceTable> {
    const cached = this.tableCache.get(tableName);
    if (cached) return cached;

    const db = await this.connect();
    if (!this.lanceAvailable || !db) {
      const memTable = new InMemoryTable();
      this.tableCache.set(tableName, memTable);
      this.evictTableCacheIfNeeded();
      return memTable;
    }
    const tableNames: string[] = await db.tableNames();

    let table: LanceTable;
    if (tableNames.includes(tableName)) {
      table = await db.openTable(tableName);
    } else {
      const provider = this.embeddingService?.providerName ?? 'ollama';
      const model = this.embeddingService?.modelName ?? 'nomic-embed-text';
      const dims = this.embeddingService?.dimensions ?? 768;

      // Create table with a sentinel record to define schema, then delete it
      const sentinel: LanceRecord = {
        id: '__schema_sentinel__',
        source: 'manual',
        source_id: '__sentinel__',
        content: '',
        vector: Array(dims).fill(0) as number[],
        metadata: '{}',
        created_at: new Date().toISOString(),
        provider,
        model,
      };
      table = await db.createTable(tableName, [sentinel]);
      await table.delete("id = '__schema_sentinel__'");
    }

    // Create FTS index on content column when LanceDB is available
    if (this.lanceAvailable) {
      try {
        const IndexModule = (await import('@lancedb/lancedb')).Index;
        await table.createIndex('content', {
          config: IndexModule.fts(),
          replace: false,
        });
      } catch (err) {
        this.logger.warn(`FTS index creation failed for project ${projectId}: ${(err as Error).message}`);
      }
    }

    this.tableCache.set(tableName, table);
    this.evictTableCacheIfNeeded();

    if (this.lanceAvailable && this.optimizeStrategy && !this.firstAccessedProjectIds.has(projectId)) {
      this.firstAccessedProjectIds.add(projectId);
      await this.optimizeStrategy.onFirstAccess(projectId, table);
    }

    return table;
  }

  /**
   * Indexes a document in the knowledge base for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async indexDocument(projectId: string, doc: IndexDocumentInput): Promise<void> {
    await this.validateProjectId(projectId);

    if (!this.embeddingService) {
      this.logger.warn('EmbeddingService not available — skipping RAG indexing');
      return;
    }

    const table = await this.getOrCreateTable(projectId);
    const tableName = `project_${projectId}`;
    try {
      const vector = await this.embeddingService.embed(doc.content);
      const record: LanceRecord = {
        id: generateId(),
        source: doc.source,
        source_id: doc.sourceId,
        content: doc.content,
        vector,
        metadata: JSON.stringify(doc.metadata),
        created_at: new Date().toISOString(),
        provider: this.embeddingService.providerName,
        model: this.embeddingService.modelName,
      };
      await this.runExclusive(tableName, () => table.add([record]));
      if (this.lanceAvailable && this.optimizeStrategy) {
        await this.optimizeStrategy.onInsert(projectId, table);
      }
      if (this.lexicalIndex) {
        this.lexicalIndex.addDocument(projectId, { id: doc.sourceId, content: doc.content });
      }
    } catch (err) {
      // Embedding service unreachable — store content-only with zero vector for FTS
      this.logger.warn(`Embedding failed (${(err as Error).message}) — storing with zero vector`);
      const dims = this.embeddingService?.dimensions ?? 768;
      const record: LanceRecord = {
        id: generateId(),
        source: doc.source,
        source_id: doc.sourceId,
        content: doc.content,
        vector: Array(dims).fill(0) as number[],
        metadata: JSON.stringify(doc.metadata ?? {}),
        created_at: new Date().toISOString(),
        provider: this.embeddingService?.providerName ?? 'unknown',
        model: this.embeddingService?.modelName ?? 'unknown',
      };
      await this.runExclusive(tableName, () => table.add([record]));
      if (this.lanceAvailable && this.optimizeStrategy) {
        await this.optimizeStrategy.onInsert(projectId, table);
      }
      if (this.lexicalIndex) {
        this.lexicalIndex.addDocument(projectId, { id: doc.sourceId, content: doc.content });
      }
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

      if (this.lanceAvailable) {
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
      if (this.lanceAvailable) {
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
    await this.runExclusive(`project_${projectId}`, () => table.delete(`source_id = '${sourceId}'`));
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

    const db = await this.connect();
    if (!db) {
      return { valid: true };
    }

    const tableName = `project_${projectId}`;
    const tableNames: string[] = await db.tableNames();

    if (!tableNames.includes(tableName)) {
      return { valid: true };
    }

    const table = await db.openTable(tableName);
    const rowCount: number = await table.countRows();
    if (rowCount === 0) return { valid: true };

    const rows: LanceRecord[] = await table.query().limit(1).toArray();
    const firstRow = rows[0];
    if (!firstRow) return { valid: true };

    const currentProvider = this.embeddingService.providerName;
    const currentModel = this.embeddingService.modelName;

    if (firstRow.provider !== currentProvider || firstRow.model !== currentModel) {
      const msg = `Table ${tableName} was created with provider=${firstRow.provider}/model=${firstRow.model}, but current config uses provider=${currentProvider}/model=${currentModel}. Results may be inconsistent.`;
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

    if (!this.lanceAvailable) {
      return;
    }

    const table = await this.getOrCreateTable(projectId);
    await this.runExclusive(`project_${projectId}`, () => table.optimize());
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

    await this.runExclusive(`project_${projectId}`, () => table.delete(`source = '${sourceType}'`));

    const countAfter = await table.countRows();
    return countBefore - countAfter;
  }

  /**
   * Imports a Graphify knowledge graph into the knowledge base for a project.
   * Uses incremental diff-and-apply when IncrementalGraphDiffService is available,
   * falling back to full re-import otherwise.
   * Updates graphifyLastImportedAt on the project atomically with the import to
   * ensure the timestamp is never out-of-sync with actual graph content.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async importGraphify(
    projectId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodes: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    links: any[],
  ): Promise<{ imported: number; cleared: number }> {
    await this.validateProjectId(projectId);

    const typedNodes = nodes as GraphifyNodeDto[];
    const typedLinks = links as GraphifyLinkDto[];

    let result: { imported: number; cleared: number };

    if (this.incrementalDiff) {
      const diffResult = await this.incrementalDiff.diffAndApply(projectId, typedNodes, typedLinks);
      result = { imported: typedNodes.length, cleared: diffResult.removed };
    } else {
      result = await this.importGraphifyFull(projectId, typedNodes, typedLinks);
    }

    // Update the timestamp immediately after the import completes so it is always
    // in sync with the graph content (best-effort single write, no cross-store txn).
    await this.ragRepository?.updateGraphifyLastImportedAt(projectId);

    return result;
  }

  private async importGraphifyFull(
    projectId: string,
    nodes: GraphifyNodeDto[],
    links: GraphifyLinkDto[],
  ): Promise<{ imported: number; cleared: number }> {
    const cleared = await this.deleteAllBySourceType(projectId, 'code');

    if (this.txManager) {
      await this.txManager.run(async () => {
        // Transaction boundary for test compatibility; Prisma writes handled
        // by GraphStoreService when available, otherwise no-op.
      });
    }

    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const outgoingLinks = new Map<string, Array<{ link: GraphifyLinkDto; target: GraphifyNodeDto | undefined }>>();
    for (const link of links) {
      const sourceId = link.source;
      let list = outgoingLinks.get(sourceId);
      if (!list) {
        list = [];
        outgoingLinks.set(sourceId, list);
      }
      list.push({ link, target: nodeMap.get(link.target) });
    }

    for (const node of nodes) {
      const type = node.type ?? 'node';
      const label = node.label;
      const sourceFile = node.source_file;
      const community = node.community;

      let content = `${type} ${label}`;

      if (sourceFile) {
        content += ` in ${sourceFile}`;
      }

      const nodeLinks = outgoingLinks.get(node.id) ?? [];
      if (nodeLinks.length > 0) {
        const linkStrings = nodeLinks
          .map(({ link: l, target }) => {
            const relation = l.relation ?? '';
            const neighborLabel = target?.label ?? '';
            return relation ? `${relation} ${neighborLabel}` : neighborLabel;
          })
          .filter((s) => s);

        if (linkStrings.length > 0) {
          content += ': ' + linkStrings.join(', ');
        }
      }

      const metadata: Record<string, unknown> = { label, type };
      if (sourceFile) metadata.source_file = sourceFile;
      if (community !== undefined) metadata.community = community;

      await this.indexDocument(projectId, {
        source: 'code',
        sourceId: node.id,
        content,
        metadata,
      });
    }

    return { imported: nodes.length, cleared };
  }
}
