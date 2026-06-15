import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import type { IRagRepository } from './domain/rag.domain';

@Injectable()
export class PrismaRagRepository implements IRagRepository {
  private static readonly BATCH_SIZE = 500;

  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async findProjectGraphifyEnabled(
    projectId: string,
  ): Promise<{ graphifyEnabled: boolean } | null> {
    return this.prisma.client.project.findUnique({
      where: { id: projectId },
      select: { graphifyEnabled: true },
    });
  }

  async findProjectById(
    projectId: string,
  ): Promise<{ id: string; deletedAt: Date | null } | null> {
    return this.prisma.client.project.findUnique({
      where: { id: projectId },
      select: { id: true, deletedAt: true },
    });
  }

  async findAllActiveProjectIds(): Promise<{ id: string }[]> {
    return this.prisma.client.project.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
  }

  async getStoredGraphNodes(projectId: string): Promise<
    { nodeId: string; label: string; type: string | null; sourceFile: string | null; community: number | null }[]
  > {
    return this.prisma.client.graphNode.findMany({ where: { projectId } });
  }

  async getStoredGraphLinks(projectId: string): Promise<
    { sourceId: string; targetId: string; relation: string | null }[]
  > {
    return this.prisma.client.graphLink.findMany({ where: { projectId } });
  }

  async upsertNodesInBatches(
    projectId: string,
    nodes: Array<{
      nodeId: string;
      label: string;
      type?: string;
      sourceFile?: string;
      community?: number;
    }>,
    links: Array<{ sourceId: string; targetId: string; relation?: string }>,
    nodeIds: string[],
    batchSize: number,
  ): Promise<void> {
    const operations: Prisma.PrismaPromise<unknown>[] = [];

    for (const node of nodes) {
      operations.push(
        this.prisma.client.graphNode.upsert({
          where: { projectId_nodeId: { projectId, nodeId: node.nodeId } },
          create: {
            projectId,
            nodeId: node.nodeId,
            label: node.label,
            type: node.type,
            sourceFile: node.sourceFile,
            community: node.community,
          },
          update: {
            label: node.label,
            type: node.type,
            sourceFile: node.sourceFile,
            community: node.community,
          },
        }),
      );
    }

    if (nodeIds.length > 0) {
      operations.push(
        this.prisma.client.graphLink.deleteMany({
          where: { projectId, sourceId: { in: nodeIds } },
        }),
      );
    }

    for (const link of links) {
      operations.push(
        this.prisma.client.graphLink.create({
          data: {
            projectId,
            sourceId: link.sourceId,
            targetId: link.targetId,
            relation: link.relation,
          },
        }),
      );
    }

    for (let i = 0; i < operations.length; i += batchSize) {
      const batch = operations.slice(i, i + batchSize);
      await this.prisma.client.$transaction(batch);
    }
  }

  async deleteGraphNodeLinks(
    projectId: string,
    conditions: { sourceId: string; targetId: string }[],
  ): Promise<void> {
    if (conditions.length === 0) return;
    await this.prisma.client.graphLink.deleteMany({
      where: {
        projectId,
        OR: conditions,
      },
    });
  }

  async deleteGraphNodesByIds(projectId: string, nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    await this.prisma.client.graphNode.deleteMany({
      where: { projectId, nodeId: { in: nodeIds } },
    });
  }

  async deleteGraphLinksByNodeIds(projectId: string, nodeIds: string[]): Promise<void> {
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
  }
}
