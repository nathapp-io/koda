import { Injectable } from '@nestjs/common';
import { PrismaRagRepository } from './prisma-rag.repository';
import type { GraphifyNodeDto, GraphifyLinkDto } from './dto/import-graphify.dto';

export interface StoredGraph {
  nodeMap: Map<string, GraphifyNodeDto>;
  linkMap: Map<string, GraphifyLinkDto[]>;
}

@Injectable()
export class GraphStoreService {
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

  async applyDiff(
    projectId: string,
    diff: { removedNodeIds: string[]; nodes: GraphifyNodeDto[]; links: GraphifyLinkDto[] },
  ): Promise<void> {
    await this.ragRepository.applyGraphDiff(projectId, {
      removedNodeIds: diff.removedNodeIds,
      nodes: diff.nodes.map((n) => ({
        nodeId: n.id,
        label: n.label,
        type: n.type,
        sourceFile: n.source_file,
        community: n.community,
      })),
      links: diff.links.map((l) => ({ sourceId: l.source, targetId: l.target, relation: l.relation })),
    });
  }

  markVectorStale(projectId: string, nodeIds: string[]): Promise<void> {
    return this.ragRepository.markGraphNodesVectorStale(projectId, nodeIds);
  }

  findVectorStaleNodeIds(projectId: string): Promise<string[]> {
    return this.ragRepository.findVectorStaleNodeIds(projectId);
  }

  clearVectorStale(projectId: string, nodeId: string): Promise<void> {
    return this.ragRepository.clearGraphNodeVectorStale(projectId, nodeId);
  }
}
