import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { RAG_CFG, IRagConfig } from '../config/rag.config';
import { PrismaRagRepository } from './prisma-rag.repository';
import { EmbeddingService } from './embedding.service';
import { EntityStore } from './entity-store';
import { LanceTableManager } from './lance-table-manager';
import type { LanceRecord, LanceTable } from './lance-table-manager';
import {
  HybridSearchQuery,
  HybridSearchResult,
  HybridSearchResultItem,
  ScoreBreakdown,
} from './dto/hybrid-search.dto';
import { simpleFtsScore } from './rag.service';

const ANSWER_WEIGHTS = {
  vectorScore: 0.4,
  lexicalScore: 0.3,
  entityScore: 0.2,
  recencyScore: 0.1,
};

const INTENT_WEIGHTS: Record<string, typeof ANSWER_WEIGHTS> = {
  answer:   { vectorScore: 0.4, lexicalScore: 0.3, entityScore: 0.2, recencyScore: 0.1 },
  diagnose: { vectorScore: 0.2, lexicalScore: 0.2, entityScore: 0.4, recencyScore: 0.2 },
  plan:     { vectorScore: 0.3, lexicalScore: 0.3, entityScore: 0.2, recencyScore: 0.2 },
  update:   { vectorScore: 0.2, lexicalScore: 0.4, entityScore: 0.2, recencyScore: 0.2 },
  search:   { vectorScore: 0.3, lexicalScore: 0.4, entityScore: 0.1, recencyScore: 0.2 },
};

function generateId(): string {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

@Injectable()
export class HybridRetrieverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HybridRetrieverService.name);
  /**
   * Shared LanceDB connection/table/mutex owner. In production, RagModule
   * provides ONE LanceTableManager instance that is injected into both
   * VectorStore and HybridRetrieverService, so HybridRetriever reads the same
   * table the controller's single write path (VectorStore.indexDocument) wrote,
   * and all writes share one per-table mutex (H7). When not injected (direct
   * construction in tests), a private manager is created for this service.
   */
  private readonly lanceTable: LanceTableManager;
  private readonly graphifyEnabledCache = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly similarityHigh: number;
  private readonly similarityMedium: number;
  private readonly similarityLow: number;
  private readonly graphifyEnabledCacheTtlMs: number;

  constructor(
    @Inject(RAG_CFG) ragConfig: IRagConfig,
    private readonly embeddingService: EmbeddingService,
    private readonly entityStore: EntityStore,
    private readonly ragRepository: PrismaRagRepository,
    @Optional() lanceTableManager?: LanceTableManager,
  ) {
    this.lanceTable = lanceTableManager ?? new LanceTableManager(ragConfig, embeddingService);
    this.similarityHigh = ragConfig.similarityHigh;
    this.similarityMedium = ragConfig.similarityMedium;
    this.similarityLow = ragConfig.similarityLow;
    this.graphifyEnabledCacheTtlMs = ragConfig.graphifyEnabledCacheTtlSec * 1000;

    if (ragConfig.inMemoryOnly) {
      this.logger.log({ storyId: 'US-004', msg: 'HybridRetriever is running in in-memory mode' });
    }
  }

  onModuleInit(): void {
    this.lanceTable.ensureStorage();
  }

  async onModuleDestroy(): Promise<void> {
    this.graphifyEnabledCache.clear();
    await this.lanceTable.close();
  }

  /**
   * Indexes a document for a project.
   *
   * H7: the controller's addDocument no longer calls this — RagService
   * (VectorStore.indexDocument) is the single KB write path. This method is
   * kept for existing callers and goes through the same shared manager write
   * path (one connection, one per-table mutex, replace-by-source_id), so it
   * can no longer create a duplicate row or race VectorStore's writes.
   */
  async indexDocument(
    projectId: string,
    doc: { source: string; sourceId: string; content: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    const tableName = `project_${projectId}`;
    let vector: number[];
    try {
      vector = await this.embeddingService.embed(doc.content);
    } catch (err) {
      this.logger.warn({ storyId: 'US-004', msg: `Embedding failed: ${(err as Error).message}` });
      const dims = this.embeddingService.dimensions ?? 768;
      vector = Array(dims).fill(0) as number[];
    }

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

    const table = await this.lanceTable.getOrCreateTable(tableName);
    await this.lanceTable.addRecord(tableName, table, record);
  }

  private async getOrCreateTable(projectId: string): Promise<LanceTable> {
    return this.lanceTable.getOrCreateTable(`project_${projectId}`);
  }

  async search(query: HybridSearchQuery): Promise<HybridSearchResult> {
    const retrievedAt = new Date().toISOString();
    const projectId = query.projectId;
    const limit = Math.min(query.limit ?? 20, 50);

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
    if (this.lanceTable.available) {
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
    if (this.lanceTable.available) {
      try {
        const queryVector = await this.embeddingService.embed(query.query);
        vectorRows = await table
          .vectorSearch(queryVector)
          .distanceType('cosine')
          .limit(candidatePoolSize)
          .toArray();
      } catch (err) {
        this.logger.warn({ storyId: 'US-004', msg: `Vector search failed: ${(err as Error).message}` });
      }
    }

    if (vectorRows.length === 0) {
      try {
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
      } catch (err) {
        this.logger.warn({ storyId: 'US-004', msg: `Embedding failed during fallback search: ${(err as Error).message}` });
      }
    }

    const halfPool = Math.floor(candidatePoolSize / 2);

    const vectorTopIds = new Set<string>();
    for (let i = 0; i < Math.min(vectorRows.length, halfPool); i++) {
      vectorTopIds.add(vectorRows[i].id as string);
    }

    const lexicalTopIds = new Set<string>();
    for (let i = 0; i < Math.min(ftsRanked.length, halfPool); i++) {
      lexicalTopIds.add(ftsRanked[i].id);
    }

    const splitCandidates = [...new Set([...vectorTopIds, ...lexicalTopIds])];
    const candidates = splitCandidates.slice(0, candidatePoolSize);

    const recordMap = new Map<string, LanceRecord>();
    allRows.forEach((r) => recordMap.set(r.id as string, r));
    vectorRows.forEach((r) => recordMap.set(r.id as string, r));

    const simMap = new Map<string, number>();
    vectorRows.forEach((r) => {
      const dist = typeof r._distance === 'number' ? r._distance : 1;
      simMap.set(r.id as string, Math.max(0, 1 - dist));
    });

    const rawScoreMap: Map<string, { vector: number; lexical: number; entity: number; recency: number; hasVector: boolean; hasLexical: boolean }> = new Map();

    const matchedEntities = this.entityStore.searchEntities(projectId, query.query);

    for (const id of candidates) {
      const record = recordMap.get(id);
      if (!record) continue;

      if (record.source !== 'ticket' && record.source !== 'doc' && record.source !== 'manual' && record.source !== 'code') continue;

      if (!effectiveGraphifyEnabled && record.source === 'code') continue;

      if (query.timeWindow?.from) {
        const startTime = new Date(query.timeWindow.from).getTime();
        const docTime = new Date(record.created_at).getTime();
        if (docTime < startTime) continue;
      }
      if (query.timeWindow?.to) {
        const endTime = new Date(query.timeWindow.to).getTime();
        const docTime = new Date(record.created_at).getTime();
        if (docTime > endTime) continue;
      }

      const hasVector = simMap.has(id);
      const vectorScore = hasVector ? Math.max(0, 1 - (vectorRows.find((r) => r.id === id)?._distance ?? 1)) : 0;
      const hasLexical = ftsScoreMap.has(id);
      const lexicalScore = hasLexical ? ftsScoreMap.get(id) ?? 0 : 0;

      const docEntity = matchedEntities.find((e) => e.sourceId === (record.source_id as string));
      const entityScore = docEntity ? this.entityStore.computeEntityScore(query.query, docEntity.tags) : 0;

      const rawRecencyScore = this.calcRawRecencyScore(record.created_at);

      rawScoreMap.set(id, { vector: vectorScore, lexical: lexicalScore, entity: entityScore, recency: rawRecencyScore, hasVector, hasLexical });
    }

    const rawScores = Array.from(rawScoreMap.values());
    const rawScoreIds = Array.from(rawScoreMap.keys());
    const vectorScores = rawScores.map((s) => s.vector);
    const lexicalScores = rawScores.map((s) => s.lexical);
    const entityScores = rawScores.map((s) => s.entity);
    const recencyScores = rawScores.map((s) => s.recency);

    if (rawScores.length === 0) {
      return { results: [], scores: [], retrievedAt };
    }

    const normalizeMinMax = (scores: number[], hasPresence: boolean[]): number[] => {
      if (scores.length === 0) return [];
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const range = max - min;
      if (range < 1e-9) {
        return scores.map((s, i) => (s > 0 && hasPresence[i] ? 1 : 0));
      }
      const result: number[] = new Array(scores.length);
      for (let i = 0; i < scores.length; i++) {
        result[i] = hasPresence[i] ? (scores[i] - min) / range : 0;
      }
      return result;
    };

    const hasVectorArr = rawScores.map((s) => s.hasVector);
    const hasLexicalArr = rawScores.map((s) => s.hasLexical);

    const normVector = normalizeMinMax(vectorScores, hasVectorArr);
    const normLexical = normalizeMinMax(lexicalScores, hasLexicalArr);
    const normEntity = normalizeMinMax(entityScores, entityScores.map(() => true));
    const normRecency = normalizeMinMax(recencyScores, recencyScores.map(() => true));

    const scoredCandidates: { id: string; finalScore: number; normVector: number; normLexical: number; normEntity: number; normRecency: number; record: LanceRecord }[] = [];

    for (let i = 0; i < rawScoreIds.length; i++) {
      const id = rawScoreIds[i];
      const record = recordMap.get(id);
      if (!record) continue;
      const normVectorScore = normVector[i];
      const normLexicalScore = normLexical[i];
      const normEntityScore = normEntity[i];
      const normRecencyScore = normRecency[i];
      const finalScore =
        normVectorScore * weights.vectorScore +
        normLexicalScore * weights.lexicalScore +
        normEntityScore * weights.entityScore +
        normRecencyScore * weights.recencyScore;
      scoredCandidates.push({ id, finalScore, normVector: normVectorScore, normLexical: normLexicalScore, normEntity: normEntityScore, normRecency: normRecencyScore, record });
    }

    scoredCandidates.sort((a, b) => b.finalScore - a.finalScore);

    const finalCandidates = scoredCandidates.slice(0, limit);

    const results: HybridSearchResultItem[] = [];
    const scores: ScoreBreakdown[] = [];

    for (let rank = 0; rank < finalCandidates.length; rank++) {
      const { id, finalScore, normVector: vectorScore, normLexical: lexicalScore, normEntity: entityScore, normRecency: recencyScore, record } = finalCandidates[rank];

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
    if (cached) {
      this.graphifyEnabledCache.delete(cacheKey);
    }

    const project = await this.ragRepository.findProjectGraphifyEnabled(projectId);

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

  private getSimilarityTier(score: number): 'high' | 'medium' | 'low' | 'none' {
    if (score >= this.similarityHigh) return 'high';
    if (score >= this.similarityMedium) return 'medium';
    if (score >= this.similarityLow) return 'low';
    return 'none';
  }
}
