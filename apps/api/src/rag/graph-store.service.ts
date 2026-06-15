import { Injectable } from '@nestjs/common';
import { PrismaRagRepository } from './prisma-rag.repository';
import type { GraphifyNodeDto, GraphifyLinkDto } from './dto/import-graphify.dto';

export interface StoredGraph {
  nodeMap: Map<string, GraphifyNodeDto>;
  linkMap: Map<string, GraphifyLinkDto[]>;
}

@Injectable()
export class GraphStoreService {
  private static readonly BATCH_SIZE = 500;

  constructor(
    private readonly ragRepository: PrismaRagRepository,
  ) {}

  async getStoredGraph(projectId: string): Promise<StoredGraph> {
    const [nodes, links] = await Promise.all([
      this.ragRepository.getStoredGraphNodes(projectId),
      this.ragRepository.getStoredGraphLinks(projectId),
    ]);

    const nodeMap = new Map<string, GraphifyNodeDto>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, {
        id: node.nodeId,
        label: node.label,
        type: node.type ?? undefined,
        source_file: node.sourceFile ?? undefined,
        community: node.community ?? undefined,
      });
    }

    const linkMap = new Map<string, GraphifyLinkDto[]>();
    for (const link of links) {
      const list = linkMap.get(link.sourceId);
      if (list) {
        list.push({ source: link.sourceId, target: link.targetId, relation: link.relation ?? undefined });
      } else {
        linkMap.set(link.sourceId, [{ source: link.sourceId, target: link.targetId, relation: link.relation ?? undefined }]);
      }
    }

    return { nodeMap, linkMap };
  }

  async upsertNodes(
    projectId: string,
    nodes: GraphifyNodeDto[],
    links: GraphifyLinkDto[],
  ): Promise<void> {
    const nodeIds = nodes.map((n) => n.id);

    await this.ragRepository.upsertNodesInBatches(
      projectId,
      nodes.map((n) => ({
        nodeId: n.id,
        label: n.label,
        type: n.type,
        sourceFile: n.source_file,
        community: n.community,
      })),
      links.map((l) => ({
        sourceId: l.source,
        targetId: l.target,
        relation: l.relation,
      })),
      nodeIds,
      GraphStoreService.BATCH_SIZE,
    );
  }

  async deleteNodes(projectId: string, nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    await this.ragRepository.deleteGraphLinksByNodeIds(projectId, nodeIds);
    await this.ragRepository.deleteGraphNodesByIds(projectId, nodeIds);
  }

  async deleteLinks(projectId: string, linkIds: string[]): Promise<void> {
    if (linkIds.length === 0) return;

    const conditions = linkIds.map((compositeId) => {
      const [sourceId, targetId] = compositeId.split('::');
      return { sourceId, targetId };
    });

    await this.ragRepository.deleteGraphNodeLinks(projectId, conditions);
  }
}
