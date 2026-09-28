import { Injectable, Inject } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { GraphifyNodeDto, GraphifyLinkDto } from './dto/import-graphify.dto';
import { GraphStoreService, StoredGraph } from './graph-store.service';
import { VectorStore } from './vector-store.service';

export interface DiffResult {
  added: number;
  updated: number;
  removed: number;
  indexed: number;
  durationMs: number;
}

@Injectable()
export class IncrementalGraphDiffService {
  constructor(
    private readonly graphStore: GraphStoreService,
    private readonly vectorStore: VectorStore,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async getStoredGraph(projectId: string): Promise<StoredGraph> {
    return this.graphStore.getStoredGraph(projectId);
  }

  async diffAndApply(
    projectId: string,
    newNodes: GraphifyNodeDto[],
    newLinks: GraphifyLinkDto[],
  ): Promise<DiffResult> {
    const startTime = Date.now();

    const storedGraph = await this.graphStore.getStoredGraph(projectId);

    // Step 0 (M19): heal nodes a previous run left without a current vector.
    await this.reindexStaleNodes(projectId, storedGraph);

    const incomingNodeMap = new Map(newNodes.map((n) => [n.id, n]));
    const incomingLinksBySource = this.groupLinksBySource(newLinks);

    const addedNodes: GraphifyNodeDto[] = [];
    const updatedNodes: GraphifyNodeDto[] = [];
    const removedNodeIds: string[] = [];

    for (const [nodeId] of storedGraph.nodeMap) {
      if (!incomingNodeMap.has(nodeId)) {
        removedNodeIds.push(nodeId);
      }
    }

    for (const newNode of newNodes) {
      const storedNode = storedGraph.nodeMap.get(newNode.id);
      if (!storedNode) {
        addedNodes.push(newNode);
      } else {
        const storedLinks = storedGraph.linkMap.get(newNode.id) ?? [];
        const incomingLinks = incomingLinksBySource.get(newNode.id) ?? [];
        if (this.nodeContentChanged(storedNode, newNode, storedLinks, incomingLinks)) {
          updatedNodes.push(newNode);
        }
      }
    }

    // Step 1: pre-mark, then drop the vectors of removed and updated nodes. If the
    // graph write below fails, these nodes stay in the graph marked stale, so the
    // next run re-indexes them even when it sends unchanged content.
    const updatedIds = updatedNodes.map((n) => n.id);
    await this.graphStore.markVectorStale(projectId, [...removedNodeIds, ...updatedIds]);
    for (const nodeId of [...removedNodeIds, ...updatedIds]) {
      await this.vectorStore.deleteBySource(projectId, nodeId);
    }

    // Step 2: one Prisma transaction for the graph write.
    const nodesToUpsert = [...addedNodes, ...updatedNodes];
    if (removedNodeIds.length > 0 || nodesToUpsert.length > 0) {
      const upsertIds = new Set(nodesToUpsert.map((n) => n.id));
      await this.graphStore.applyDiff(projectId, {
        removedNodeIds,
        nodes: nodesToUpsert,
        links: newLinks.filter((l) => upsertIds.has(l.source)),
      });
    }

    // Step 3: index the changed nodes, clearing each flag after its vector lands.
    for (const node of nodesToUpsert) {
      const nodeLinks = incomingLinksBySource.get(node.id) ?? [];
      await this.indexNode(projectId, node, nodeLinks, incomingNodeMap);
      await this.graphStore.clearVectorStale(projectId, node.id);
    }

    return {
      added: addedNodes.length,
      updated: updatedNodes.length,
      removed: removedNodeIds.length,
      indexed: nodesToUpsert.length,
      durationMs: Date.now() - startTime,
    };
  }

  /** Re-indexes every vectorStale node from the stored graph, clearing each flag after its write. */
  private async reindexStaleNodes(projectId: string, storedGraph: StoredGraph): Promise<void> {
    const staleIds = await this.graphStore.findVectorStaleNodeIds(projectId);
    for (const nodeId of staleIds) {
      const node = storedGraph.nodeMap.get(nodeId);
      if (!node) continue;
      await this.indexNode(projectId, node, storedGraph.linkMap.get(nodeId) ?? [], storedGraph.nodeMap);
      await this.graphStore.clearVectorStale(projectId, nodeId);
    }
  }

  private groupLinksBySource(
    links: GraphifyLinkDto[],
  ): Map<string, GraphifyLinkDto[]> {
    const map = new Map<string, GraphifyLinkDto[]>();
    for (const link of links) {
      const list = map.get(link.source);
      if (list) {
        list.push(link);
      } else {
        map.set(link.source, [link]);
      }
    }
    return map;
  }

  private nodeContentChanged(
    storedNode: GraphifyNodeDto,
    newNode: GraphifyNodeDto,
    storedLinks: GraphifyLinkDto[],
    incomingLinks: GraphifyLinkDto[],
  ): boolean {
    if (storedNode.label !== newNode.label) return true;
    if (storedNode.type !== newNode.type) return true;
    if (storedNode.source_file !== newNode.source_file) return true;

    if (storedLinks.length !== incomingLinks.length) return true;

    const storedLinkSet = new Set(
      storedLinks.map((l) => `${l.target}::${l.relation ?? ''}`),
    );
    for (const link of incomingLinks) {
      if (!storedLinkSet.has(`${link.target}::${link.relation ?? ''}`)) {
        return true;
      }
    }

    return false;
  }

  private async indexNode(
    projectId: string,
    node: GraphifyNodeDto,
    nodeLinks: GraphifyLinkDto[],
    nodeMap: Map<string, GraphifyNodeDto>,
  ): Promise<void> {
    const type = node.type ?? 'node';
    const label = node.label;
    const sourceFile = node.source_file;
    const community = node.community;

    let content = `${type} ${label}`;
    if (sourceFile) {
      content += ` in ${sourceFile}`;
    }

    if (nodeLinks.length > 0) {
      const linkStrings = nodeLinks
        .map((link) => {
          const targetNode = nodeMap.get(link.target);
          const relation = link.relation ?? '';
          const neighborLabel = targetNode?.label ?? '';
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

    await this.vectorStore.indexDocument(projectId, {
      source: 'code',
      sourceId: node.id,
      content,
      metadata,
    });
  }
}
