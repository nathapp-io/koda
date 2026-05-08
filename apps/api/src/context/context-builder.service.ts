import { performance } from 'perf_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { AppException, NotFoundAppException, InternalAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { CanonicalStateService, CanonicalTicket, CanonicalEvent, CanonicalDecision } from '../memory/canonical-state.service';
import { PrismaMemoryItemRepository } from '../memory/prisma-memory-item.repository';
import { MemoryItem } from '../memory/memory-item-repository';
import { HybridRetrieverService } from '../rag/hybrid-retriever.service';
import { HybridSearchResult } from '../rag/dto/hybrid-search.dto';
import { EntityGraphService } from '../entity-graph/entity-graph.service';
import { EntityPath } from '../entity-graph/dto/entity-graph.types';
import { ImpactAnalysisService, ChangeImpactResult } from '../code-intel/impact-analysis.service';
import { estimateTokenCount } from './token-estimator';
import { SloDashboardService } from '../monitoring/slo-dashboard.service';

export class ProjectNotFoundError extends NotFoundAppException {
  constructor() {
    super({}, 'projects');
    this.name = 'ProjectNotFoundError';
  }
}
// Override the numeric code getter inherited from AppException with the string 'PROJECT_NOT_FOUND'.
// The getter on AppException.prototype is configurable so this is safe.
Object.defineProperty(ProjectNotFoundError.prototype, 'code', {
  get() { return 'PROJECT_NOT_FOUND'; },
  configurable: true,
  enumerable: false,
});

export type ContextIntent = 'answer' | 'diagnose' | 'plan' | 'update' | 'search';

export interface GetProjectContextQuery {
  projectId: string;
  actorId: string;
  intent: ContextIntent;
  query?: string;
  ticketIds?: string[];
  repoRefs?: string[];
  timeWindow?: { from?: Date; to?: Date };
  includeCodeIntel?: boolean;
  includeGraph?: boolean;
  tokenBudget?: number;
}

export interface ResponseProvenance {
  sources: Array<{ sourceType: string; sourceId: string; score?: number }>;
  retrievalStrategy: string;
}

export interface GetProjectContextResponse {
  projectId: string;
  canonicalState: {
    tickets?: CanonicalTicket[];
    recentEvents?: CanonicalEvent[];
    activeDecisions?: CanonicalDecision[];
  };
  retrievedContext: {
    documents: HybridSearchResult;
    semanticMemory: MemoryItem[];
    graphPaths?: EntityPath[];
    codeIntel?: ChangeImpactResult[];
  };
  provenance: ResponseProvenance;
  meta: {
    intent: string;
    tokensUsed: number;
    retrievedAt: Date;
    latencyMs: number;
  };
}

const DEFAULT_TOKEN_BUDGET = 4000;
const MAX_RECENT_EVENTS = 20;
const MAX_SEMANTIC_MEMORY = 10;

@Injectable()
export class ContextBuilderService {
  private readonly logger = new Logger(ContextBuilderService.name);

  constructor(
    private readonly canonicalStateService: CanonicalStateService,
    private readonly memoryItemRepository: PrismaMemoryItemRepository,
    private readonly hybridRetrieverService: HybridRetrieverService,
    private readonly entityGraphService: EntityGraphService,
    private readonly impactAnalysisService: ImpactAnalysisService,
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly sloDashboardService: SloDashboardService,
  ) {}

  async getProjectContext(query: GetProjectContextQuery): Promise<GetProjectContextResponse> {
    const startTime = performance.now();

    await this.verifyProjectExists(query.projectId);

    const tokenBudget = query.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

    let snapshot: Awaited<ReturnType<typeof this.canonicalStateService.getSnapshot>>;
    let semanticMemoryResult: Awaited<ReturnType<typeof this.memoryItemRepository.findByProjectMemory>>;
    let documents: HybridSearchResult;
    try {
      [snapshot, semanticMemoryResult, documents] = await Promise.all([
        this.canonicalStateService.getSnapshot({
          projectId: query.projectId,
          ticketIds: query.ticketIds,
          actorId: query.actorId,
          timeWindow: query.timeWindow ?? { from: new Date(0) },
        }),
        this.memoryItemRepository.findByProjectMemory({
          projectId: query.projectId,
          orderBy: 'confidence',
          limit: MAX_SEMANTIC_MEMORY,
        }),
        this.fetchDocuments(query),
      ]);
    } catch (err) {
      if (err instanceof AppException) {
        throw err;
      }
      throw new InternalAppException({}, 'context');
    }

    const recentEvents = this.buildRecentEvents(query.intent, snapshot.recentEvents);

    const semanticMemory = [...semanticMemoryResult.items]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_SEMANTIC_MEMORY);

    let graphPaths: EntityPath[] | undefined;
    if (query.includeGraph && query.ticketIds && query.ticketIds.length > 0) {
      graphPaths = await this.fetchGraphPaths(query.projectId, query.ticketIds);
    }

    let codeIntel: ChangeImpactResult[] | undefined;
    if (query.includeCodeIntel && query.repoRefs && query.repoRefs.length > 0) {
      codeIntel = await this.fetchCodeIntel(query.projectId, query.repoRefs);
    }

    const retrievedContext = this.enforceTokenBudget(
      { documents, semanticMemory, graphPaths, codeIntel },
      tokenBudget,
    );

    const hasQuery = query.query && query.query.trim().length > 0;

    const canonicalState = {
      tickets: snapshot.tickets,
      recentEvents,
      activeDecisions: snapshot.activeDecisions,
    };

    const tokensUsed =
      estimateTokenCount(JSON.stringify(canonicalState)) +
      estimateTokenCount(JSON.stringify(retrievedContext));

    const latencyMs = Math.ceil(performance.now() - startTime);
    const staleHitCount = this.countStaleHits(documents);
    const provenanceSources = documents.results.map((r) => ({
      sourceType: r.source,
      sourceId: r.sourceId,
      score: r.score,
    }));

    void this.recordQueryMetricFireAndForget({
      projectId: query.projectId,
      intent: query.intent,
      latencyMs,
      tokensUsed,
      hadProvenance: documents.results.length > 0,
      staleHitCount,
      resultCount: documents.results.length,
    });

    return {
      projectId: query.projectId,
      canonicalState,
      retrievedContext,
      provenance: {
        sources: provenanceSources,
        retrievalStrategy: hasQuery ? 'hybrid' : 'canonical-only',
      },
      meta: {
        intent: query.intent,
        tokensUsed,
        retrievedAt: new Date(),
        latencyMs,
      },
    };
  }

  private async verifyProjectExists(projectId: string): Promise<void> {
    const project = await this.prisma.client.project.findUnique({
      where: { id: projectId },
      select: { id: true, deletedAt: true },
    });
    if (!project || project.deletedAt) {
      throw new ProjectNotFoundError();
    }
  }

  private buildRecentEvents(
    intent: ContextIntent,
    events: CanonicalEvent[],
  ): CanonicalEvent[] | undefined {
    if (intent === 'plan') {
      return undefined;
    }
    return [...events]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, MAX_RECENT_EVENTS);
  }

  private async fetchDocuments(query: GetProjectContextQuery): Promise<HybridSearchResult> {
    const effectiveQuery = query.query?.trim() ?? '';
    if (!effectiveQuery) {
      return { results: [], scores: [], retrievedAt: new Date().toISOString() };
    }

    try {
      return await this.hybridRetrieverService.search({
        projectId: query.projectId,
        query: effectiveQuery,
        intent: query.intent,
        timeWindow: query.timeWindow
          ? {
              from: query.timeWindow.from?.toISOString(),
              to: query.timeWindow.to?.toISOString(),
            }
          : undefined,
      });
    } catch (err) {
      this.logger.warn(`Hybrid search failed: ${(err as Error).message}`);
      return { results: [], scores: [], retrievedAt: new Date().toISOString() };
    }
  }

  private async fetchGraphPaths(projectId: string, ticketIds: string[]): Promise<EntityPath[]> {
    try {
      const paths: EntityPath[] = [];
      for (const ticketId of ticketIds) {
        const related = await this.entityGraphService.getRelatedEntities(projectId, ticketId, 2);
        paths.push(...related);
      }
      return paths;
    } catch (err) {
      this.logger.warn(`Graph path fetch failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchCodeIntel(projectId: string, repoRefs: string[]): Promise<ChangeImpactResult[]> {
    try {
      const results: ChangeImpactResult[] = [];
      for (const repoRef of repoRefs) {
        const impact = await this.impactAnalysisService.getChangeImpact({
          projectId,
          repoId: repoRef,
          commitHash: repoRef,
          changedFiles: [],
        });
        results.push(impact);
      }
      return results;
    } catch (err) {
      this.logger.warn(`Code intel fetch failed: ${(err as Error).message}`);
      return [];
    }
  }

  private enforceTokenBudget(
    ctx: {
      documents: HybridSearchResult;
      semanticMemory: MemoryItem[];
      graphPaths?: EntityPath[];
      codeIntel?: ChangeImpactResult[];
    },
    budget: number,
  ): GetProjectContextResponse['retrievedContext'] {
    const semanticTokens = estimateTokenCount(JSON.stringify(ctx.semanticMemory));
    const docTokens = estimateTokenCount(JSON.stringify(ctx.documents));
    const graphTokens = ctx.graphPaths ? estimateTokenCount(JSON.stringify(ctx.graphPaths)) : 0;
    const codeIntelTokens = ctx.codeIntel ? estimateTokenCount(JSON.stringify(ctx.codeIntel)) : 0;

    // canonicalState blocks are never removed; only retrievedContext is subject to truncation.
    // Priority (lowest removed first): codeIntel → graphPaths → documents → semanticMemory

    let codeIntel: ChangeImpactResult[] | undefined = ctx.codeIntel;
    let graphPaths: EntityPath[] | undefined = ctx.graphPaths;
    let documents = ctx.documents;
    let semanticMemory = ctx.semanticMemory;

    let used = semanticTokens + docTokens + graphTokens + codeIntelTokens;

    if (used > budget && codeIntel !== undefined) {
      codeIntel = undefined;
      used -= codeIntelTokens;
    }

    if (used > budget && graphPaths !== undefined) {
      graphPaths = undefined;
      used -= graphTokens;
    }

    if (used > budget) {
      documents = { results: [], scores: [], retrievedAt: ctx.documents.retrievedAt };
      used -= docTokens;
    }

    if (used > budget) {
      semanticMemory = [];
    }

    return { documents, semanticMemory, graphPaths, codeIntel };
  }

  private countStaleHits(documents: HybridSearchResult): number {
    const thresholdMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let count = 0;
    for (const result of documents.results) {
      const indexedAt = result.provenance?.indexedAt ?? result.createdAt;
      const ageMs = now - new Date(indexedAt).getTime();
      if (ageMs > thresholdMs) {
        count++;
      }
    }
    return count;
  }

  private recordQueryMetricFireAndForget(metric: {
    projectId: string;
    intent: string;
    latencyMs: number;
    tokensUsed: number;
    hadProvenance: boolean;
    staleHitCount: number;
    resultCount: number;
  }): void {
    this.sloDashboardService
      .recordQueryMetric({
        ...metric,
        leakageIncidentCount: 0,
      })
      .catch((err: Error) => {
        this.logger.warn(`Failed to record query metric: ${err.message}`);
      });
  }
}
