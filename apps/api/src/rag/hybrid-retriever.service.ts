import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { EmbeddingService } from './embedding.service';
import {
  HybridSearchQuery,
  HybridSearchResult,
  HybridSearchResultItem,
  ScoreBreakdown,
} from './dto/hybrid-search.dto';
import { simpleFtsScore, reciprocalRankFusion } from './rag.service';

const ANSWER_WEIGHTS = {
  vectorScore: 0.4,
  lexicalScore: 0.3,
  entityScore: 0.1,
  recencyScore: 0.2,
};

const INTENT_WEIGHTS: Record<string, Partial<typeof ANSWER_WEIGHTS>> = {
  answer: ANSWER_WEIGHTS,
  review: { vectorScore: 0.35, lexicalScore: 0.35, entityScore: 0.15, recencyScore: 0.15 },
  reproduce: { vectorScore: 0.5, lexicalScore: 0.2, entityScore: 0.2, recencyScore: 0.1 },
};

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

class InMemoryTable {
  private records: LanceRecord[] = [];
  async add(records: LanceRecord[]): Promise<void> {
    this.records = [...this.records, ...records];
  }
  async countRows(): Promise<number> {
    return this.records.length;
  }
  async delete(_filter: string): Promise<void> {}
  vectorSearch() {
    return { distanceType: () => ({ limit: (n: number) => ({ toArray: () => this.records.slice(0, n) }) }) };
  }
  query() {
    return { limit: (n: number) => ({ toArray: () => this.records.slice(0, n) }) };
  }
}

@Injectable()
export class HybridRetrieverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HybridRetrieverService.name);
  private db: LanceConnection = null;
  private readonly tableCache = new Map<string, LanceTable>();
  private lanceAvailable = true;
  private readonly lancedbPath: string;
  private readonly similarityHigh: number;
  private readonly similarityMedium: number;
  private readonly similarityLow: number;
  private readonly inMemoryOnly: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly embeddingService: EmbeddingService,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    this.lancedbPath = configService.get<string>('rag.lancedbPath') ?? './lancedb';
    this.similarityHigh = configService.get<number>('rag.similarityHigh') ?? 0.85;
    this.similarityMedium = configService.get<number>('rag.similarityMedium') ?? 0.7;
    this.similarityLow = configService.get<number>('rag.similarityLow') ?? 0.5;
    this.inMemoryOnly = configService.get<boolean>('rag.inMemoryOnly') ?? false;

    if (this.inMemoryOnly) {
      this.lanceAvailable = false;
      this.logger.log('HybridRetriever is running in in-memory mode');
    }
  }

  onModuleInit(): void {
    if (this.inMemoryOnly) return;
    try {
      mkdirSync(this.lancedbPath, { recursive: true });
    } catch {
      this.lanceAvailable = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.tableCache.clear();
    if (this.db && typeof this.db.close === 'function') {
      try {
        const result = this.db.close();
        if (result && typeof result.then === 'function') await result;
      } catch (err) {
        this.logger.warn(`Failed to close LanceDB: ${(err as Error).message}`);
      }
    }
    this.db = null;
  }

  private async connect(): Promise<LanceConnection | null> {
    if (this.inMemoryOnly) return null;
    if (!this.db) {
      try {
        const lancedb = await import('@lancedb/lancedb');
        const connectFn =
          (lancedb as unknown as { connect: (path: string) => Promise<LanceConnection> }).connect ??
          (lancedb.default as unknown as { connect: (path: string) => Promise<LanceConnection> })?.connect;
        this.db = await connectFn(this.lancedbPath);
      } catch (err) {
        this.lanceAvailable = false;
        this.logger.warn(`LanceDB unavailable: ${(err as Error).message}`);
        return null;
      }
    }
    return this.db;
  }

  async indexDocument(
    projectId: string,
    doc: { source: string; sourceId: string; content: string; metadata: Record<string, unknown> },
  ): Promise<void> {
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
      this.logger.warn(`Embedding failed: ${(err as Error).message}`);
      const dims = this.embeddingService.dimensions ?? 768;
      const record: LanceRecord = {
        id: generateId(),
        source: doc.source,
        source_id: doc.sourceId,
        content: doc.content,
        vector: Array(dims).fill(0) as number[],
        metadata: JSON.stringify(doc.metadata ?? {}),
        created_at: new Date().toISOString(),
        provider: this.embeddingService.providerName,
        model: this.embeddingService.modelName,
      };
      await table.add([record]);
    }
  }

  private async getOrCreateTable(projectId: string): Promise<LanceTable> {
    const tableName = `project_${projectId}`;
    const cached = this.tableCache.get(tableName);
    if (cached) return cached;

    const db = await this.connect();
    if (!this.lanceAvailable || !db) {
      const memTable = new InMemoryTable();
      this.tableCache.set(tableName, memTable);
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

    try {
      const IndexModule = (await import('@lancedb/lancedb')).Index;
      await table.createIndex('content', { config: IndexModule.fts(), replace: false });
    } catch (err) {
      this.logger.warn(`FTS index creation failed: ${(err as Error).message}`);
    }

    this.tableCache.set(tableName, table);
    return table;
  }

  async search(query: HybridSearchQuery): Promise<HybridSearchResult> {
    const retrievedAt = new Date().toISOString();
    const projectId = query.projectId;
    const limit = Math.min(query.limit ?? 20, 50);

    const weights = INTENT_WEIGHTS[query.intent ?? 'answer'] ?? ANSWER_WEIGHTS;

    const table = await this.getOrCreateTable(projectId);
    const rowCount: number = await table.countRows();
    if (rowCount === 0) {
      return { results: [], scores: [], retrievedAt };
    }

    const candidatePoolSize = Math.max(100, limit * 5);
    const allRows: LanceRecord[] = await table.query().limit(Math.min(rowCount, 500)).toArray();

    let ftsRanked: { id: string; score: number }[] = [];
    if (this.lanceAvailable) {
      try {
        const nativeFtsResult = await table.search(query.query, 'fts', 'content');
        let nativeFtsRows: LanceRecord[] = [];
        if (Array.isArray(nativeFtsResult)) {
          nativeFtsRows = nativeFtsResult as LanceRecord[];
        } else if (nativeFtsResult && typeof nativeFtsResult === 'object' && 'toArray' in nativeFtsResult) {
          nativeFtsRows = await (nativeFtsResult as { toArray: () => Promise<LanceRecord[]> }).toArray();
        }
        ftsRanked = nativeFtsRows.map((r, i) => ({ id: r.id as string, score: 1 / (i + 1) }));
      } catch {
        ftsRanked = allRows
          .map((r) => ({ id: r.id as string, score: simpleFtsScore(r.content as string, query.query) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, candidatePoolSize);
      }
    } else {
      ftsRanked = allRows
        .map((r) => ({ id: r.id as string, score: simpleFtsScore(r.content as string, query.query) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, candidatePoolSize);
    }

    const ftsScoreMap = new Map<string, number>(ftsRanked.map((r) => [r.id, r.score]));

    let vectorRows: LanceRecord[] = [];
    if (this.lanceAvailable) {
      try {
        const queryVector = await this.embeddingService.embed(query.query);
        vectorRows = await table
          .vectorSearch(queryVector)
          .distanceType('cosine')
          .limit(candidatePoolSize)
          .toArray();
      } catch (err) {
        this.logger.warn(`Vector search failed: ${(err as Error).message}`);
      }
    }

    const merged = vectorRows.length > 0
      ? reciprocalRankFusion(
          vectorRows.map((r) => ({ id: r.id as string })),
          ftsRanked.map((r) => ({ id: r.id })),
        )
      : ftsRanked.slice(0, limit).map((r) => ({ id: r.id, score: r.score }));

    const recordMap = new Map<string, LanceRecord>();
    allRows.forEach((r) => recordMap.set(r.id as string, r));
    vectorRows.forEach((r) => recordMap.set(r.id as string, r));

    const simMap = new Map<string, number>();
    vectorRows.forEach((r) => {
      const dist = typeof r._distance === 'number' ? r._distance : 1;
      simMap.set(r.id as string, Math.max(0, 1 - dist));
    });

    const candidateLimit = Math.max(100, limit * 5);
    const candidates = merged.slice(0, candidateLimit);

    const results: HybridSearchResultItem[] = [];
    const scores: ScoreBreakdown[] = [];

    for (const { id } of candidates) {
      const record = recordMap.get(id);
      if (!record) continue;

      if (record.source !== 'ticket' && record.source !== 'doc' && record.source !== 'manual' && record.source !== 'code') continue;

      if (query.timeWindow?.start) {
        const startTime = new Date(query.timeWindow.start).getTime();
        const docTime = new Date(record.created_at).getTime();
        if (docTime < startTime) continue;
      }
      if (query.timeWindow?.end) {
        const endTime = new Date(query.timeWindow.end).getTime();
        const docTime = new Date(record.created_at).getTime();
        if (docTime > endTime) continue;
      }

      const meta = (() => {
        try {
          return JSON.parse(record.metadata as string) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();

      const rawScore = simMap.get(id) ?? ftsScoreMap.get(id) ?? 0;

      const vectorScore = simMap.has(id) ? Math.max(0, 1 - (vectorRows.find((r) => r.id === id)?._distance ?? 1)) : 0;
      const lexicalScore = ftsScoreMap.get(id) ?? 0;
      const entityScore = 0;
      const recencyScore = this.calcRecencyScore(record.created_at);
      const finalScore =
        vectorScore * weights.vectorScore +
        lexicalScore * weights.lexicalScore +
        entityScore * weights.entityScore +
        recencyScore * weights.recencyScore;

      results.push({
        id: record.id as string,
        source: record.source as 'ticket' | 'doc' | 'manual' | 'code',
        sourceId: record.source_id as string,
        content: record.content as string,
        score: finalScore,
        similarity: this.getSimilarityTier(finalScore),
        metadata: meta,
        createdAt: record.created_at as string,
        provenance: {
          indexedAt: record.created_at as string,
          sourceProjectId: projectId,
        },
      });

      scores.push({
        vectorScore,
        lexicalScore,
        entityScore,
        recencyScore,
        finalScore,
      });
    }

    const limitedResults = results.slice(0, limit);
    const limitedScores = scores.slice(0, limit);

    return {
      results: limitedResults,
      scores: limitedScores,
      retrievedAt,
    };
  }

  private calcRecencyScore(createdAt: string): number {
    const docDate = new Date(createdAt).getTime();
    const now = Date.now();
    const ageDays = (now - docDate) / (1000 * 60 * 60 * 24);
    return Math.max(0, 1 - ageDays / 365);
  }

  private getSimilarityTier(score: number): 'high' | 'medium' | 'low' | 'none' {
    if (score >= this.similarityHigh) return 'high';
    if (score >= this.similarityMedium) return 'medium';
    if (score >= this.similarityLow) return 'low';
    return 'none';
  }
}