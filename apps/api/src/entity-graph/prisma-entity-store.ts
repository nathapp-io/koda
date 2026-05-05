import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import {
  EntityRecord,
  IEntityStore,
  EntityNodeType,
} from './dto/entity-graph.types';

@Injectable()
export class PrismaEntityStore implements IEntityStore {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async findNodeByEntityId(projectId: string, entityId: string): Promise<EntityRecord | null> {
    const row = await this.prisma.client.entityNode.findUnique({
      where: { projectId_entityId: { projectId, entityId } },
    });
    if (!row) return null;
    return this.toEntityRecord(row);
  }

  async findNodesByType(projectId: string, entityType: EntityNodeType): Promise<EntityRecord[]> {
    const rows = await this.prisma.client.entityNode.findMany({
      where: { projectId, entityType },
    });
    return rows.map((r) => this.toEntityRecord(r));
  }

  async findLinksBySource(projectId: string, sourceId: string): Promise<Array<{ targetId: string; relation: string; metadata: Record<string, unknown> }>> {
    const rows = await this.prisma.client.entityLink.findMany({
      where: { projectId, sourceId },
    });
    return rows.map((r) => ({
      targetId: r.targetId,
      relation: r.relation,
      metadata: this.parseMetadata(r.metadata),
    }));
  }

  async findLinksByTarget(projectId: string, targetId: string): Promise<Array<{ sourceId: string; relation: string; metadata: Record<string, unknown> }>> {
    const rows = await this.prisma.client.entityLink.findMany({
      where: { projectId, targetId },
    });
    return rows.map((r) => ({
      sourceId: r.sourceId,
      relation: r.relation,
      metadata: this.parseMetadata(r.metadata),
    }));
  }

  async upsertNode(
    projectId: string,
    entityId: string,
    entityType: EntityNodeType,
    label: string,
    metadata?: Record<string, unknown>,
  ): Promise<EntityRecord> {
    const metadataJson = JSON.stringify(metadata ?? {});
    const row = await this.prisma.client.entityNode.upsert({
      where: { projectId_entityId: { projectId, entityId } },
      create: { projectId, entityId, entityType, label, metadata: metadataJson },
      update: { entityType, label, metadata: metadataJson },
    });
    return this.toEntityRecord(row);
  }

  async upsertLink(
    projectId: string,
    sourceId: string,
    targetId: string,
    relation: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const metadataJson = JSON.stringify(metadata ?? {});
    await this.prisma.client.entityLink.upsert({
      where: { projectId_sourceId_targetId_relation: { projectId, sourceId, targetId, relation } },
      create: { projectId, sourceId, targetId, relation, metadata: metadataJson },
      update: { metadata: metadataJson },
    });
  }

  async deleteLinksBySource(projectId: string, sourceId: string): Promise<void> {
    await this.prisma.client.entityLink.deleteMany({
      where: { projectId, sourceId },
    });
  }

  private toEntityRecord(row: {
    projectId: string;
    entityId: string;
    entityType: string;
    label: string;
    metadata: string;
  }): EntityRecord {
    return {
      entityId: row.entityId,
      entityType: row.entityType as EntityNodeType,
      label: row.label,
      metadata: this.parseMetadata(row.metadata),
    };
  }

  private parseMetadata(metadata: string): Record<string, unknown> {
    try {
      return JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
