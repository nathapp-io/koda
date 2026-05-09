import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import type { GraphifyNodeDto, GraphifyLinkDto } from './dto/import-graphify.dto';

export interface StoredGraph {
  nodeMap: Map<string, GraphifyNodeDto>;
  linkMap: Map<string, GraphifyLinkDto[]>;
}

@Injectable()
export class GraphStoreService {
  private static readonly BATCH_SIZE = 500;

  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  async getStoredGraph(projectId: string): Promise<StoredGraph> {
    const [nodes, links] = await Promise.all([
      this.prisma.client.graphNode.findMany({ where: { projectId } }),
      this.prisma.client.graphLink.findMany({ where: { projectId } }),
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
    const operations: Prisma.PrismaPromise<unknown>[] = [];

    for (const node of nodes) {
      operations.push(this.prisma.client.graphNode.upsert({
        where: { projectId_nodeId: { projectId, nodeId: node.id } },
        create: {
          projectId,
          nodeId: node.id,
          label: node.label,
          type: node.type,
          sourceFile: node.source_file,
          community: node.community,
        },
        update: {
          label: node.label,
          type: node.type,
          sourceFile: node.source_file,
          community: node.community,
        },
      }));
    }

    if (nodeIds.length > 0) {
      operations.push(this.prisma.client.graphLink.deleteMany({
        where: { projectId, sourceId: { in: nodeIds } },
      }));
    }

    for (const link of links) {
      operations.push(this.prisma.client.graphLink.create({
        data: {
          projectId,
          sourceId: link.source,
          targetId: link.target,
          relation: link.relation,
        },
      }));
    }

    for (let i = 0; i < operations.length; i += GraphStoreService.BATCH_SIZE) {
      const batch = operations.slice(i, i + GraphStoreService.BATCH_SIZE);
      await this.prisma.client.$transaction(batch);
    }
  }

  async deleteNodes(projectId: string, nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;

    await this.prisma.client.graphLink.deleteMany({
      where: {
        projectId,
        OR: [
          { sourceId: { in: nodeIds } },
          { targetId: { in: nodeIds } },
        ],
      },
    });

    await this.prisma.client.graphNode.deleteMany({
      where: { projectId, nodeId: { in: nodeIds } },
    });
  }

  async deleteLinks(projectId: string, linkIds: string[]): Promise<void> {
    if (linkIds.length === 0) return;

    const conditions = linkIds.map((compositeId) => {
      const [sourceId, targetId] = compositeId.split('::');
      return { sourceId, targetId };
    });

    await this.prisma.client.graphLink.deleteMany({
      where: {
        projectId,
        OR: conditions,
      },
    });
  }
}
