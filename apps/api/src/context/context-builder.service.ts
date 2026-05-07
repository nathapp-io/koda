import { performance } from 'perf_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
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
  ) {}

  async getProjectContext(query: GetProjectContextQuery): Promise<GetProjectContextResponse> {
    const startTime = performance.now();

    await this.verifyProjectExists(query.projectId);

    const tokenBudget = query.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

    const [snapshot, semanticMemoryResult, documents] = await Promise.all([
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
    const provenance: ResponseProvenance = {
      sources: documents.results.map((r) => ({
        sourceType: r.source,
        sourceId: r.sourceId,
        score: r.score,
      })),
      retrievalStrategy: hasQuery ? 'hybrid' : 'canonical-only',
    };

    const tokensUsed = estimateTokenCount(JSON.stringify(retrievedContext));

    return {
      projectId: query.projectId,
      canonicalState: {
        tickets: snapshot.tickets,
        recentEvents,
        activeDecisions: snapshot.activeDecisions,
      },
      retrievedContext,
      provenance,
      meta: {
        intent: query.intent,
        tokensUsed,
        retrievedAt: new Date(),
        latencyMs: Math.ceil(performance.now() - startTime),
      },
    };
  }

  private async verifyProjectExists(projectId: string): Promise<void> {
    const project = await this.prisma.client.project.findUnique({
      where: { id: projectId },
      select: { id: true, deletedAt: true },
    });
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'projects');
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
}
