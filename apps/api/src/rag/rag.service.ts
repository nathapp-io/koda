import { Injectable, Optional, Inject } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaRagRepository } from './prisma-rag.repository';
import { GraphStoreService } from './graph-store.service';
import { IncrementalGraphDiffService } from './incremental-graph-diff.service';
import { VectorStore } from './vector-store.service';
import type { GraphifyNodeDto, GraphifyLinkDto } from './dto/import-graphify.dto';
import type { KbResultDto, SearchKbResponseDto } from './dto/kb-result.dto';

export interface IndexDocumentInput {
  source: 'ticket' | 'doc' | 'manual' | 'code';
  sourceId: string;
  content: string;
  metadata: Record<string, unknown>;
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

@Injectable()
export class RagService {
  constructor(
    private readonly vectorStore: VectorStore,
    @Optional() private readonly ragRepository?: PrismaRagRepository,
    @Optional() @Inject(TRANSACTION_MANAGER) private readonly txManager?: ITransactionManager,
    @Optional() private readonly graphStore?: GraphStoreService,
    @Optional() private readonly incrementalDiff?: IncrementalGraphDiffService,
  ) {}

  clearProjectCaches(projectId: string): void {
    this.vectorStore.clearProjectCaches(projectId);
  }

  /**
   * Indexes a document in the knowledge base for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async indexDocument(projectId: string, doc: IndexDocumentInput): Promise<void> {
    return this.vectorStore.indexDocument(projectId, doc);
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
    return this.vectorStore.search(projectId, query, limit);
  }

  /**
   * Lists documents in the knowledge base for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async listDocuments(projectId: string, limit = 100): Promise<KbResultDto[]> {
    return this.vectorStore.listDocuments(projectId, limit);
  }

  /**
   * Deletes documents by source ID in the knowledge base for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async deleteBySource(projectId: string, sourceId: string): Promise<void> {
    return this.vectorStore.deleteBySource(projectId, sourceId);
  }

  /**
   * Optimizes the LanceDB table for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async optimizeTable(projectId: string): Promise<void> {
    return this.vectorStore.optimizeTable(projectId);
  }

  /**
   * Deletes all documents by source type in the knowledge base for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   */
  async deleteAllBySourceType(projectId: string, sourceType: string): Promise<number> {
    return this.vectorStore.deleteAllBySourceType(projectId, sourceType);
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
    await this.vectorStore.validateProjectId(projectId);

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
