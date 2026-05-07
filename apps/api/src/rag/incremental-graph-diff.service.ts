import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { GraphifyNodeDto, GraphifyLinkDto } from './dto/import-graphify.dto';
import { GraphStoreService, StoredGraph } from './graph-store.service';
import { RagService } from './rag.service';

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
    @Inject(forwardRef(() => RagService)) private readonly rag: RagService,
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

    const removed = removedNodeIds.length;
    const added = addedNodes.length;
    const updated = updatedNodes.length;
    const indexed = added + updated;

    // Apply Prisma writes in a transaction
    await this.txManager.run(async () => {
      if (removedNodeIds.length > 0) {
        await this.graphStore.deleteNodes(projectId, removedNodeIds);
      }

      const nodesToUpsert = [...addedNodes, ...updatedNodes];
      if (nodesToUpsert.length > 0) {
        const linksForUpsert = newLinks.filter((l) =>
          nodesToUpsert.some((n) => n.id === l.source),
        );
        await this.graphStore.upsertNodes(projectId, nodesToUpsert, linksForUpsert);
      }
    });

    // LanceDB operations (outside Prisma transaction)
    for (const nodeId of removedNodeIds) {
      await this.rag.deleteBySource(projectId, nodeId);
    }

    for (const node of updatedNodes) {
      await this.rag.deleteBySource(projectId, node.id);
    }

    const nodesToIndex = [...addedNodes, ...updatedNodes];
    for (const node of nodesToIndex) {
      const nodeLinks = incomingLinksBySource.get(node.id) ?? [];
      await this.indexNode(projectId, node, nodeLinks, incomingNodeMap);
    }

    const durationMs = Date.now() - startTime;

    return { added, updated, removed, indexed, durationMs };
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

    await this.rag.indexDocument(projectId, {
      source: 'code',
      sourceId: node.id,
      content,
      metadata,
    });
  }
}
