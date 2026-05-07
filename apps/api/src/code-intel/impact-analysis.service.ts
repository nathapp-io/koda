import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { SymbolStore, SymbolData } from './symbol-store';
import { EntityGraphService } from '../entity-graph/entity-graph.service';
import { GraphStoreService } from '../rag/graph-store.service';
import { EntityRecord, EntityNodeType } from '../entity-graph/dto/entity-graph.types';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

export interface ChangeImpactQuery {
  projectId: string;
  repoId: string;
  commitHash: string;
  changedFiles: string[];
  ticketId?: string;
}

export interface Provenance {
  ticketId: string;
  sources: string[];
}

export interface ChangeImpactResult {
  commitHash: string;
  changedFiles: string[];
  impactedSymbols: SymbolData[];
  impactedServices: EntityRecord[];
  impactedTickets: EntityRecord[];
  impactScore: number;
  provenance?: Provenance;
}

@Injectable()
export class ImpactAnalysisService {
  private readonly logger = new Logger(ImpactAnalysisService.name);

  constructor(
    private readonly symbolStore: SymbolStore,
    private readonly entityGraph: EntityGraphService,
    private readonly graphStore: GraphStoreService,
    @Optional() private readonly prisma?: PrismaService<PrismaClient>,
  ) {}

  async getChangeImpact(query: ChangeImpactQuery): Promise<ChangeImpactResult> {
    const { projectId, repoId, commitHash, changedFiles, ticketId } = query;

    this.logger.debug(
      `getChangeImpact: projectId=${projectId}, repoId=${repoId}, commitHash=${commitHash}, changedFiles=${changedFiles.length}`,
    );

    const impactedSymbols = await this.getImpactedSymbols(projectId, changedFiles);
    const impactedServices = await this.getImpactedServices(projectId, impactedSymbols);
    const impactedTickets = await this.getImpactedTickets(projectId, impactedServices);

    const impactScore = this.calculateImpactScore(
      impactedSymbols,
      impactedServices,
      impactedTickets,
    );

    const result: ChangeImpactResult = {
      commitHash,
      changedFiles,
      impactedSymbols,
      impactedServices,
      impactedTickets,
      impactScore,
    };

    if (ticketId) {
      result.provenance = {
        ticketId,
        sources: this.buildSources(impactedSymbols, impactedServices, impactedTickets),
      };
    }

    return result;
  }

  private async getImpactedSymbols(projectId: string, changedFiles: string[]): Promise<SymbolData[]> {
    if (!this.prisma) return [];

    const symbols = await this.prisma.client.symbol.findMany({
      where: {
        projectId,
        file: { in: changedFiles },
      },
    });

    return symbols.map((s) => ({
      id: s.id,
      symbolId: s.symbolId,
      projectId: s.projectId,
      repoId: s.repoId,
      commitHash: s.commitHash,
      name: s.name,
      kind: s.kind as 'class' | 'method' | 'function' | 'interface' | 'enum',
      file: s.file,
      startLine: s.startLine,
      endLine: s.endLine,
      signature: s.signature ?? undefined,
      callers: (s.callers as unknown as string[]) || [],
      callees: (s.callees as unknown as string[]) || [],
      docComment: s.docComment ?? undefined,
    }));
  }

  private async getImpactedServices(
    projectId: string,
    symbols: SymbolData[],
  ): Promise<EntityRecord[]> {
    if (symbols.length === 0) return [];

    const serviceSet = new Map<string, EntityRecord>();

    for (const symbol of symbols) {
      try {
        const relatedEntities = await this.entityGraph.getRelatedEntities(projectId, symbol.id, 1);

        for (const path of relatedEntities) {
          for (const entity of path.path) {
            if (
              entity.entityType === EntityNodeType.SERVICE ||
              entity.entityType === EntityNodeType.CODE_MODULE
            ) {
              serviceSet.set(entity.entityId, entity);
            }
          }
        }
      } catch (error) {
        this.logger.debug(`Error getting related entities for symbol ${symbol.id}:`, error);
      }
    }

    return Array.from(serviceSet.values());
  }

  private async getImpactedTickets(
    projectId: string,
    services: EntityRecord[],
  ): Promise<EntityRecord[]> {
    if (services.length === 0) return [];

    const ticketSet = new Map<string, EntityRecord>();

    for (const service of services) {
      try {
        const relatedEntities = await this.entityGraph.getRelatedEntities(
          projectId,
          service.entityId,
          2,
        );

        for (const path of relatedEntities) {
          for (const entity of path.path) {
            if (entity.entityType === EntityNodeType.TICKET) {
              ticketSet.set(entity.entityId, entity);
            }
          }
        }
      } catch (error) {
        this.logger.debug(
          `Error getting related entities for service ${service.entityId}:`,
          error,
        );
      }
    }

    return Array.from(ticketSet.values());
  }

  private calculateImpactScore(
    symbols: SymbolData[],
    services: EntityRecord[],
    tickets: EntityRecord[],
  ): number {
    if (symbols.length === 0 && services.length === 0 && tickets.length === 0) {
      return 0;
    }

    const totalSymbols = Math.max(1, symbols.length);
    const totalServices = Math.max(1, services.length);
    const totalTickets = Math.max(1, tickets.length);

    const affectedSymbols = symbols.length > 0 ? symbols.length : 0;
    const affectedServices = services.length > 0 ? services.length : 0;
    const affectedTickets = tickets.length > 0 ? tickets.length : 0;

    const linkedIncidents = tickets.filter(
      (t) => t.metadata?.priority === 'HIGH' || t.metadata?.priority === 'CRITICAL',
    ).length;

    const symbolTerm = totalSymbols > 0 ? (affectedSymbols / totalSymbols) * 100 : 0;
    const serviceTerm = totalServices > 0 ? (affectedServices / totalServices) * 100 : 0;
    const ticketTerm = totalTickets > 0 ? (affectedTickets / totalTickets) * 100 : 0;
    const incidentTerm = linkedIncidents > 0 ? 100 : 0;

    const score =
      0.3 * symbolTerm + 0.3 * serviceTerm + 0.2 * ticketTerm + 0.2 * incidentTerm;

    return Math.min(100, Math.max(0, score));
  }

  private buildSources(
    symbols: SymbolData[],
    services: EntityRecord[],
    tickets: EntityRecord[],
  ): string[] {
    const sources = new Set<string>();

    symbols.forEach((s) => sources.add(s.name || s.id));
    services.forEach((s) => sources.add(s.label || s.entityId));
    tickets.forEach((t) => sources.add(t.label || t.entityId));

    return Array.from(sources);
  }
}
