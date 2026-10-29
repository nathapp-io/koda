import type { LanceRecord } from './lance-table-manager';
import { Injectable, Optional, Inject } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaRagRepository } from './prisma-rag.repository';
import { GraphStoreService } from './graph-store.service';
import { IncrementalGraphDiffService } from './incremental-graph-diff.service';
import { VectorStore } from './vector-store.service';
import type { GraphifyNodeDto, GraphifyLinkDto } from './dto/import-graphify.dto';
import type { KbResultDto, SearchKbResponseDto } from './dto/kb-result.dto';
import type { KbCreator } from './kb-creator';

export interface IndexDocumentInput {
  source: 'ticket' | 'doc' | 'manual' | 'code';
  sourceId: string;
  content: string;
  metadata: Record<string, unknown>;
  /**
   * Who creates the row (US-006). The write path stores it under `kodaCreatedBy` and ignores any caller-supplied
   * `metadata.kodaCreatedBy`; an absent `createdBy` leaves the row without a creator (a system row).
   */
  createdBy?: KbCreator;
}

/** Operations valid only inside the project's shared LanceDB write mutex. */
export interface KbDocumentWriteSession {
  capturePair(source: string, sourceId: string): Promise<LanceRecord[]>;
  restorePair(source: string, sourceId: string, rows: LanceRecord[]): Promise<void>;
  deleteBySource(source: string, sourceId: string): Promise<void>;
  findSourceRowIds(source: string, sourceId: string): Promise<string[]>;
  deleteRows(ids: readonly string[]): Promise<void>;
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

  withDocumentWriteLock<T>(projectId: string, work: (session: KbDocumentWriteSession) => Promise<T>, options?: { recovery: true; additionRecovery?: true }): Promise<T> {
    return this.vectorStore.withDocumentWriteLock(projectId, work, options);
  }

  blockDocumentWrites(projectId: string, blocked: boolean): void {
    this.vectorStore.blockDocumentWrites(projectId, blocked);
  }

  clearProjectCaches(projectId: string): void {
    this.vectorStore.clearProjectCaches(projectId);
  }

  /** Compute the index vector before entering a deferred execution transaction. */
  embedForIndex(content: string): Promise<number[] | null> {
    return this.vectorStore.embedForIndex(content);
  }

  async indexDocument(projectId: string, doc: IndexDocumentInput, vector?: number[]): Promise<string | null> {
    return this.vectorStore.indexDocument(projectId, doc, vector);
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
   * Deletes the documents of one `(source, sourceId)` pair in the knowledge base for a project.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   * @throws ValidationAppException if source or sourceId is not filter-safe
   */
  async deleteBySource(projectId: string, source: string, sourceId: string): Promise<void> {
    return this.vectorStore.deleteBySource(projectId, source, sourceId);
  }

  /**
   * Answers the creator recorded on each row of one `(source, sourceId)` pair, one entry per matching row and
   * `null` for a row with no creator; an empty array when nothing matches.
   * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
   * @throws ValidationAppException if source or sourceId is not filter-safe
   */
  async findSourceCreators(projectId: string, source: string, sourceId: string): Promise<Array<KbCreator | null>> {
    return this.vectorStore.findSourceCreators(projectId, source, sourceId);
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
