import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../generated/prisma/client';
import type { IRagRepository } from './domain/rag.domain';

export interface RagProjectSlugRecord {
  id: string;
  graphifyEnabled: boolean;
  deletedAt: Date | null;
}

export interface RagCodeDocumentRow {
  id: string;
  label: string;
  type: string;
  source_file?: string;
}

export interface RagTicketRecord {
  id: string;
  title: string;
}

export interface GraphDiffWrite {
  removedNodeIds: string[];
  nodes: Array<{ nodeId: string; label: string; type?: string; sourceFile?: string; community?: number }>;
  links: Array<{ sourceId: string; targetId: string; relation?: string }>;
}

/** Large graphify imports run hundreds of statements in one interactive transaction. */
const GRAPH_DIFF_TX_TIMEOUT_MS = 120_000;

/**
 * In-memory dedup before createMany: Postgres treats NULLs as distinct in the
 * (projectId, sourceId, targetId, relation) unique index, so skipDuplicates
 * alone would keep duplicate relation-less links.
 */
function dedupeLinks(links: GraphDiffWrite['links']): GraphDiffWrite['links'] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.sourceId}\u0000${link.targetId}\u0000${link.relation ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

@Injectable()
export class PrismaRagRepository implements IRagRepository {
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

  /**
   * M19: one transaction for the whole graph write. Removed nodes and every link
   * touching them go; changed nodes are upserted with vectorStale = true; their
   * outgoing links are replaced by the deduped incoming set.
   */
  async applyGraphDiff(projectId: string, diff: GraphDiffWrite): Promise<void> {
    const changedIds = diff.nodes.map((n) => n.nodeId);
    await this.prisma.client.$transaction(
      async (client) => {
        const db = client as unknown as PrismaClient;
        if (diff.removedNodeIds.length > 0) {
          await db.graphLink.deleteMany({
            where: {
              projectId,
              OR: [{ sourceId: { in: diff.removedNodeIds } }, { targetId: { in: diff.removedNodeIds } }],
            },
          });
          await db.graphNode.deleteMany({ where: { projectId, nodeId: { in: diff.removedNodeIds } } });
        }
        for (const node of diff.nodes) {
          const fields = { label: node.label, type: node.type, sourceFile: node.sourceFile, community: node.community, vectorStale: true };
          await db.graphNode.upsert({
            where: { projectId_nodeId: { projectId, nodeId: node.nodeId } },
            create: { projectId, nodeId: node.nodeId, ...fields },
            update: fields,
          });
        }
        if (changedIds.length > 0) {
          await db.graphLink.deleteMany({ where: { projectId, sourceId: { in: changedIds } } });
          const links = dedupeLinks(diff.links);
          if (links.length > 0) {
            await db.graphLink.createMany({
              data: links.map((l) => ({ projectId, sourceId: l.sourceId, targetId: l.targetId, relation: l.relation })),
              skipDuplicates: true,
            });
          }
        }
      },
      { timeout: GRAPH_DIFF_TX_TIMEOUT_MS },
    );
  }

  async markGraphNodesVectorStale(projectId: string, nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    await this.prisma.client.graphNode.updateMany({
      where: { projectId, nodeId: { in: nodeIds } },
      data: { vectorStale: true },
    });
  }

  async findVectorStaleNodeIds(projectId: string): Promise<string[]> {
    const rows = await this.prisma.client.graphNode.findMany({
      where: { projectId, vectorStale: true },
      select: { nodeId: true },
      orderBy: { nodeId: 'asc' },
    });
    return rows.map((r) => r.nodeId);
  }

  async clearGraphNodeVectorStale(projectId: string, nodeId: string): Promise<void> {
    await this.prisma.client.graphNode.updateMany({
      where: { projectId, nodeId },
      data: { vectorStale: false },
    });
  }

  async findProjectBySlug(slug: string): Promise<RagProjectSlugRecord | null> {
    return this.prisma.client.project.findUnique({
      where: { slug },
      select: { id: true, graphifyEnabled: true, deletedAt: true },
    });
  }

  async updateGraphifyLastImportedAt(projectId: string): Promise<void> {
    await this.prisma.client.project.update({
      where: { id: projectId },
      data: { graphifyLastImportedAt: new Date() },
    });
  }

  async getProjectCodeDocuments(projectId: string): Promise<RagCodeDocumentRow[]> {
    // M14: graphify nodes live in GraphNode; the code_document table never existed.
    const nodes = await this.prisma.client.graphNode.findMany({
      where: { projectId },
      select: { nodeId: true, label: true, type: true, sourceFile: true },
      orderBy: { nodeId: 'asc' },
    });
    return nodes.map((node) => ({
      id: node.nodeId,
      label: node.label,
      type: node.type ?? '',
      source_file: node.sourceFile ?? undefined,
    }));
  }

  async findTicketById(ticketId: string): Promise<RagTicketRecord | null> {
    return this.prisma.client.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, title: true },
    });
  }

}
