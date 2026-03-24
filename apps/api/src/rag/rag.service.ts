import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from './embedding.service';
import type { KbResultDto, SearchKbResponseDto } from './dto/kb-result.dto';

export interface IndexDocumentInput {
  source: 'ticket' | 'doc' | 'manual';
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
  async add(records: LanceRecord[]): Promise<void> { this.records.push(...records); }
  async countRows(): Promise<number> { return this.records.length; }
  async delete(_filter: string): Promise<void> {}
  vectorSearch() { return { distanceType: () => ({ limit: (n) => ({ toArray: () => this.records.slice(0, n) }) }) }; }
  query() { return { limit: (n) => ({ toArray: () => this.records.slice(0, n) }) }; }
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private db: LanceConnection = null;
  private readonly tableCache = new Map<string, LanceTable>();
  private lanceAvailable = true;
  private readonly lancedbPath: string;
  private readonly similarityHigh: number;
  private readonly similarityMedium: number;
  private readonly similarityLow: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly embeddingService?: EmbeddingService,
  ) {
    this.lancedbPath = configService.get<string>('rag.lancedbPath') ?? './lancedb';
    this.similarityHigh = configService.get<number>('rag.similarityHigh') ?? 0.85;
    this.similarityMedium = configService.get<number>('rag.similarityMedium') ?? 0.70;
    this.similarityLow = configService.get<number>('rag.similarityLow') ?? 0.50;
  }

  private async connect(): Promise<LanceConnection | null> {
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

  async getOrCreateTable(projectId: string): Promise<LanceTable> {
    const cached = this.tableCache.get(projectId);
    if (cached) return cached;

    const db = await this.connect();
    if (!this.lanceAvailable || !db) {
      const memTable = new InMemoryTable();
      this.tableCache.set(projectId, memTable);
      return memTable;
    }

    const tableName = `project_${projectId}`;
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

    this.tableCache.set(projectId, table);
    return table;
  }

  async indexDocument(projectId: string, doc: IndexDocumentInput): Promise<void> {
    if (!this.embeddingService) {
      this.logger.warn('EmbeddingService not available — skipping RAG indexing');
      return;
    }

    const table = await this.getOrCreateTable(projectId);
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
      await table.add([record]);
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
      await table.add([record]);
    }
  }

  async search(
    projectId: string,
    query: string,
    limit = 5,
  ): Promise<SearchKbResponseDto> {
    if (!this.embeddingService) {
      return { results: [], verdict: 'no_match' };
    }

    const table = await this.getOrCreateTable(projectId);
    const rowCount: number = await table.countRows();
    if (rowCount === 0) {
      return { results: [], verdict: 'no_match' };
    }

    const fetchLimit = Math.min(rowCount, limit * 4);
    const scanLimit = Math.min(rowCount, 500);
    const allRows: LanceRecord[] = await table.query().limit(scanLimit).toArray();

    const ftsRanked = allRows
      .map((r) => ({ id: r.id as string, score: simpleFtsScore(r.content as string, query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, fetchLimit);

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

    // Build id → record lookup
    const recordMap = new Map<string, LanceRecord>();
    allRows.forEach((r) => recordMap.set(r.id as string, r));
    vectorRows.forEach((r) => recordMap.set(r.id as string, r));

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

        const score = simMap.get(id) ?? 0;
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
          source: record.source as string,
          sourceId: record.source_id as string,
          content: record.content as string,
          score,
          similarity,
          metadata: meta,
          createdAt: record.created_at as string,
        };
        return result;
      })
      .filter((r): r is KbResultDto => r !== null);

    const topScore = results[0]?.score ?? 0;
    const verdict = getVerdict(topScore, this.similarityHigh, this.similarityMedium);

    return { results, verdict };
  }

  async listDocuments(projectId: string, limit = 100): Promise<KbResultDto[]> {
    const table = await this.getOrCreateTable(projectId);
    const rowCount: number = await table.countRows();
    if (rowCount === 0) return [];

    const rows: LanceRecord[] = await table.query().limit(limit).toArray();

    return rows.map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = (() => { try { return JSON.parse(r.metadata as string) as Record<string, unknown>; } catch { return {}; } })();
      return {
        id: r.id as string,
        source: r.source as string,
        sourceId: r.source_id as string,
        content: r.content as string,
        score: 0,
        similarity: 'none' as const,
        metadata: meta,
        createdAt: r.created_at as string,
      };
    });
  }

  async deleteBySource(projectId: string, sourceId: string): Promise<void> {
    // Validate sourceId to prevent SQL injection (only allow safe characters)
    if (!/^[a-zA-Z0-9_-]+$/.test(sourceId)) {
      throw new Error('Invalid sourceId format');
    }
    const table = await this.getOrCreateTable(projectId);
    await table.delete(`source_id = '${sourceId}'`);
  }

  async validateTableProvider(projectId: string): Promise<{ valid: boolean; message?: string }> {
    if (!this.embeddingService) return { valid: true };

    const db = await this.connect();
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
}
