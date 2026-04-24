import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { EmbeddingService } from './embedding.service';
import { EntityStore } from './entity-store';
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
  entityScore: 0.2,
  recencyScore: 0.1,
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
  private readonly graphifyEnabledCache = new Map<string, { value: boolean; expiresAt: number }>();
  private lanceAvailable = true;
  private readonly lancedbPath: string;
  private readonly similarityHigh: number;
  private readonly similarityMedium: number;
  private readonly similarityLow: number;
  private readonly inMemoryOnly: boolean;
  private readonly graphifyEnabledCacheTtlMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly embeddingService: EmbeddingService,
    private readonly entityStore: EntityStore,
    private readonly prisma: PrismaService<PrismaClient>,
  ) {
    this.lancedbPath = configService.get<string>('rag.lancedbPath') ?? './lancedb';
    this.similarityHigh = configService.get<number>('rag.similarityHigh') ?? 0.85;
    this.similarityMedium = configService.get<number>('rag.similarityMedium') ?? 0.7;
    this.similarityLow = configService.get<number>('rag.similarityLow') ?? 0.5;
    this.inMemoryOnly = configService.get<boolean>('rag.inMemoryOnly') ?? false;
    this.graphifyEnabledCacheTtlMs = configService.get<number>('rag.graphifyEnabledCacheTtlSec') ?? 60;
    this.graphifyEnabledCacheTtlMs = this.graphifyEnabledCacheTtlMs * 1000;

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
    this.graphifyEnabledCache.clear();
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
    const limit = query.limit ?? 20;

    const weights = INTENT_WEIGHTS[query.intent ?? 'answer'] ?? ANSWER_WEIGHTS;

    const effectiveGraphifyEnabled = await this.resolveGraphifyEnabled(projectId, query.graphifyEnabled);

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

    if (vectorRows.length === 0 && this.lanceAvailable === false) {
      const queryVector = await this.embeddingService.embed(query.query);
      const dims = this.embeddingService.dimensions ?? 8;
      const allWithVectors = allRows.map((r) => {
        const docVec = (r.vector as number[]) ?? Array(dims).fill(0);
        const dot = queryVector.reduce((sum, qv, i) => sum + qv * docVec[i], 0);
        const qMag = Math.sqrt(queryVector.reduce((s, v) => s + v * v, 0));
        const dMag = Math.sqrt(docVec.reduce((s, v) => s + v * v, 0));
        const cosineSim = qMag > 0 && dMag > 0 ? dot / (qMag * dMag) : 0;
        return { ...r, _distance: 1 - cosineSim };
      });
      vectorRows = allWithVectors
        .filter((r) => (r._distance as number) < 1)
        .sort((a, b) => (a._distance as number) - (b._distance as number))
        .slice(0, candidatePoolSize);
    }

    const merged = (vectorRows.length > 0 && this.lanceAvailable)
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

    const rawScoreMap: Map<string, { vector: number; lexical: number; entity: number; recency: number; hasVector: boolean; hasLexical: boolean }> = new Map();

    for (const { id } of candidates) {
      const record = recordMap.get(id);
      if (!record) continue;

      if (record.source !== 'ticket' && record.source !== 'doc' && record.source !== 'manual' && record.source !== 'code') continue;

      if (!effectiveGraphifyEnabled && record.source === 'code') continue;

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

      const hasVector = simMap.has(id);
      const vectorScore = hasVector ? Math.max(0, 1 - (vectorRows.find((r) => r.id === id)?._distance ?? 1)) : 0;
      const hasLexical = ftsScoreMap.has(id);
      const lexicalScore = hasLexical ? ftsScoreMap.get(id) ?? 0 : 0;

      const matchedEntities = this.entityStore.searchEntities(projectId, query.query);
      const docEntity = matchedEntities.find((e) => e.sourceId === (record.source_id as string));
      const entityScore = docEntity ? this.entityStore.computeEntityScore(query.query, docEntity.tags) : 0;

      const rawRecencyScore = this.calcRawRecencyScore(record.created_at);

      rawScoreMap.set(id, { vector: vectorScore, lexical: lexicalScore, entity: entityScore, recency: rawRecencyScore, hasVector, hasLexical });
    }

    const rawScores = Array.from(rawScoreMap.values());
    const vectorScores = rawScores.map((s) => s.vector);
    const lexicalScores = rawScores.map((s) => s.lexical);
    const entityScores = rawScores.map((s) => s.entity);
    const recencyScores = rawScores.map((s) => s.recency);

    const normalizeMinMax = (scores: number[], hasPresence: boolean[]): number[] => {
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      if (min === max) {
        return scores.map((s, i) => (s > 0 && hasPresence[i] ? 1 : 0));
      }
      return scores.map((s) => (s - min) / (max - min));
    };

    const hasVectorArr = rawScores.map((s) => s.hasVector);
    const hasLexicalArr = rawScores.map((s) => s.hasLexical);

    const normVector = normalizeMinMax(vectorScores, hasVectorArr);
    const normLexical = normalizeMinMax(lexicalScores, hasLexicalArr);
    const normEntity = normalizeMinMax(entityScores, entityScores.map(() => true));
    const normRecency = normalizeMinMax(recencyScores, recencyScores.map(() => true));

    const scoredCandidates: { id: string; finalScore: number; normVector: number; normLexical: number; normEntity: number; normRecency: number; record: LanceRecord }[] = [];

    for (const [id] of rawScoreMap) {
      const record = recordMap.get(id);
      if (!record) continue;
      const normVectorScore = normVector[scoredCandidates.length];
      const normLexicalScore = normLexical[scoredCandidates.length];
      const normEntityScore = normEntity[scoredCandidates.length];
      const normRecencyScore = normRecency[scoredCandidates.length];
      const finalScore =
        normVectorScore * weights.vectorScore +
        normLexicalScore * weights.lexicalScore +
        normEntityScore * weights.entityScore +
        normRecencyScore * weights.recencyScore;
      scoredCandidates.push({ id, finalScore, normVector: normVectorScore, normLexical: normLexicalScore, normEntity: normEntityScore, normRecency: normRecencyScore, record });
    }

    scoredCandidates.sort((a, b) => b.finalScore - a.finalScore);

    const results: HybridSearchResultItem[] = [];
    const scores: ScoreBreakdown[] = [];

    for (let rank = 0; rank < scoredCandidates.length; rank++) {
      const { id, finalScore, normVector: vectorScore, normLexical: lexicalScore, normEntity: entityScore, normRecency: recencyScore, record } = scoredCandidates[rank];

      const meta = (() => {
        try {
          return JSON.parse(record.metadata as string) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();

      results.push({
        id,
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
        rank: rank + 1,
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

  private async resolveGraphifyEnabled(projectId: string, explicitValue?: boolean): Promise<boolean> {
    if (typeof explicitValue === 'boolean') {
      return explicitValue;
    }

    const cacheKey = `graphifyEnabled:${projectId}`;
    const cached = this.graphifyEnabledCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const project = await this.prisma.client.project.findUnique({
      where: { id: projectId },
      select: { graphifyEnabled: true },
    });

    const enabled = project?.graphifyEnabled ?? false;

    this.graphifyEnabledCache.set(cacheKey, {
      value: enabled,
      expiresAt: Date.now() + this.graphifyEnabledCacheTtlMs,
    });

    return enabled;
  }

  invalidateGraphifyEnabledCache(projectId: string): void {
    const cacheKey = `graphifyEnabled:${projectId}`;
    this.graphifyEnabledCache.delete(cacheKey);
  }

  private calcRawRecencyScore(createdAt: string): number {
    const docDate = new Date(createdAt).getTime();
    const now = Date.now();
    const ageDays = (now - docDate) / (1000 * 60 * 60 * 24);
    return Math.pow(0.5, ageDays / 30);
  }

  private calcRecencyScore(rawScore: number): number {
    return rawScore;
  }

  private getSimilarityTier(score: number): 'high' | 'medium' | 'low' | 'none' {
    if (score >= this.similarityHigh) return 'high';
    if (score >= this.similarityMedium) return 'medium';
    if (score >= this.similarityLow) return 'low';
    return 'none';
  }
}