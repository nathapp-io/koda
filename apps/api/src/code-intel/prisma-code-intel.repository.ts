import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import {
  ICodeIntelRepository,
  SymbolRow,
  GraphNodeRow,
  EntityNodeRow,
  EntityLinkRow,
} from './domain/code-intel.domain';

@Injectable()
export class PrismaCodeIntelRepository implements ICodeIntelRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async findSymbolsByFiles(projectId: string, files: string[]): Promise<SymbolRow[]> {
    return this.prisma.client.symbol.findMany({
      where: { projectId, file: { in: files } },
    });
  }

  async findGraphNodesByType(projectId: string, type: string): Promise<GraphNodeRow[]> {
    return this.prisma.client.graphNode.findMany({
      where: { projectId, type },
      select: { nodeId: true, label: true, sourceFile: true, community: true },
    });
  }

  async findEntityNodesByIds(projectId: string, entityIds: string[]): Promise<EntityNodeRow[]> {
    return this.prisma.client.entityNode.findMany({
      where: { projectId, entityId: { in: entityIds } },
      select: { entityId: true, entityType: true, label: true, metadata: true },
    });
  }

  async findEntityLinksByTargetIds(
    projectId: string,
    targetIds: string[],
    relation: string,
  ): Promise<EntityLinkRow[]> {
    return this.prisma.client.entityLink.findMany({
      where: { projectId, targetId: { in: targetIds }, relation },
      select: { sourceId: true, targetId: true, relation: true },
    });
  }

  async findEntityNodesByIdsAndType(
    projectId: string,
    entityIds: string[],
    entityType: string,
  ): Promise<EntityNodeRow[]> {
    return this.prisma.client.entityNode.findMany({
      where: { projectId, entityId: { in: entityIds }, entityType },
      select: { entityId: true, entityType: true, label: true, metadata: true },
    });
  }

  async countSymbols(projectId: string): Promise<number> {
    return this.prisma.client.symbol.count({ where: { projectId } });
  }

  async countEntityNodesByTypes(projectId: string, entityTypes: string[]): Promise<number> {
    return this.prisma.client.entityNode.count({
      where: { projectId, entityType: { in: entityTypes } },
    });
  }

  async countEntityNodesByType(projectId: string, entityType: string): Promise<number> {
    return this.prisma.client.entityNode.count({
      where: { projectId, entityType },
    });
  }
}
