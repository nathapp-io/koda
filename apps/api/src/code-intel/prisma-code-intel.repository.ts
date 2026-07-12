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
import type { SymbolData } from './symbol-store';

export interface VcsConnectionRecord {
  provider: string;
  repoOwner: string;
  repoName: string;
  encryptedToken: string;
}

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

  // Symbol store methods

  async upsertSymbol(symbol: SymbolData): Promise<SymbolData> {
    const data = {
      ...symbol,
      callers: symbol.callers as unknown as string[],
      callees: symbol.callees as unknown as string[],
    };

    const result = await this.prisma.client.symbol.upsert({
      where: { id: symbol.id },
      create: data as Parameters<typeof this.prisma.client.symbol.upsert>[0]['create'],
      update: data as Parameters<typeof this.prisma.client.symbol.upsert>[0]['update'],
    });

    return {
      ...result,
      callers: (result.callers as unknown as string[]) || [],
      callees: (result.callees as unknown as string[]) || [],
    } as SymbolData;
  }

  async findSymbolByExactId(projectId: string, symbolId: string): Promise<SymbolRow | null> {
    return this.prisma.client.symbol.findUnique({
      where: { projectId_symbolId: { projectId, symbolId } },
    });
  }

  async findSymbolsByFallback(projectId: string, symbolId: string): Promise<SymbolRow[]> {
    return this.prisma.client.symbol.findMany({
      where: {
        projectId,
        OR: [
          { symbolId: { endsWith: `::${symbolId}` } },
          { name: symbolId },
        ],
      },
      take: 1,
    });
  }

  async findSymbolsByIds(projectId: string, symbolIds: string[]): Promise<SymbolRow[]> {
    return this.prisma.client.symbol.findMany({
      where: { projectId, symbolId: { in: symbolIds } },
    });
  }

  async findSymbolsByIdsOrNames(
    projectId: string,
    symbolIds: string[],
    names: string[],
  ): Promise<SymbolRow[]> {
    return this.prisma.client.symbol.findMany({
      where: {
        projectId,
        OR: [
          { symbolId: { in: symbolIds } },
          { name: { in: names } },
        ],
      },
    });
  }

  async deleteSymbolsByFile(projectId: string, repoId: string, file: string): Promise<void> {
    await this.prisma.client.symbol.deleteMany({
      where: { projectId, repoId, file },
    });
  }

  // VCS connection lookup (for outbox handler)

  async searchSymbols(
    projectId: string,
    opts: { q?: string; file?: string; page?: number; limit?: number },
  ): Promise<{ items: Pick<SymbolRow, 'id' | 'name' | 'kind' | 'file' | 'signature'>[]; total: number }> {
    const { q, file, page = 1, limit = 20 } = opts;
    const where: Record<string, unknown> = { projectId };
    if (q !== undefined) where.name = { contains: q };
    if (file !== undefined) where.file = { contains: file };

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.client.symbol.findMany({
        where,
        take: limit,
        skip,
        orderBy: { name: 'asc' },
        select: { id: true, name: true, kind: true, file: true, signature: true },
      }),
      this.prisma.client.symbol.count({ where }),
    ]);
    return { items, total };
  }

  async findVcsConnectionByProjectId(projectId: string): Promise<VcsConnectionRecord | null> {
    // Cast required because the stale generated Prisma client type does not reflect the
    // vcsConnection model that exists in the actual schema include shape at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = this.prisma.client as unknown as { vcsConnection: { findUnique: (opts: unknown) => Promise<unknown> } };
    const result = await client.vcsConnection.findUnique({ where: { projectId } });
    return result as VcsConnectionRecord | null;
  }
}
