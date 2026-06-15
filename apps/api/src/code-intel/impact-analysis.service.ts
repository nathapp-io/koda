import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { SymbolStore, SymbolData } from './symbol-store';
import { EntityGraphService } from '../entity-graph/entity-graph.service';
import { GraphStoreService } from '../rag/graph-store.service';
import { EntityRecord, EntityNodeType } from '../entity-graph/dto/entity-graph.types';
import { CODE_INTEL_REPOSITORY, ICodeIntelRepository } from './domain/code-intel.domain';

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
    @Optional() @Inject(CODE_INTEL_REPOSITORY) private readonly codeIntelRepository?: ICodeIntelRepository,
  ) {}

  async getChangeImpact(query: ChangeImpactQuery): Promise<ChangeImpactResult> {
    const { projectId, repoId, commitHash, changedFiles, ticketId } = query;

    this.logger.debug(
      `getChangeImpact: projectId=${projectId}, repoId=${repoId}, commitHash=${commitHash}, changedFiles=${changedFiles.length}`,
    );

    const impactedSymbols = await this.getImpactedSymbols(projectId, changedFiles);
    const impactedServices = await this.getImpactedServices(projectId, impactedSymbols);
    const impactedTickets = await this.getImpactedTickets(projectId, impactedServices);

    const impactScore = await this.calculateImpactScore(
      projectId,
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
    if (!this.codeIntelRepository) return [];

    const symbols = await this.codeIntelRepository.findSymbolsByFiles(projectId, changedFiles);

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
    if (!this.codeIntelRepository) return [];

    const serviceSet = new Map<string, EntityRecord>();
    const changedFiles = [...new Set(symbols.map((s) => s.file))];

    const graphNodes = await this.codeIntelRepository.findGraphNodesByType(projectId, 'code_module');

    const matchedGraphNodes = graphNodes.filter((node) => {
      if (!node.sourceFile) return false;
      return changedFiles.some(
        (file) => file === node.sourceFile || file.includes(node.sourceFile!) || node.sourceFile!.includes(file),
      );
    });

    if (matchedGraphNodes.length > 0) {
      const serviceIds = matchedGraphNodes.map((node) => `service:${node.nodeId}`);
      const serviceRows = await this.codeIntelRepository.findEntityNodesByIds(projectId, serviceIds);
      const serviceRowsById = new Map(serviceRows.map((row) => [row.entityId, row]));

      for (const node of matchedGraphNodes) {
        const entityId = `service:${node.nodeId}`;
        const row = serviceRowsById.get(entityId);
        serviceSet.set(entityId, row
          ? {
              entityId: row.entityId,
              entityType: row.entityType as EntityNodeType,
              label: row.label,
              metadata: this.parseMetadata(row.metadata),
            }
          : {
              entityId,
              entityType: EntityNodeType.SERVICE,
              label: node.label,
              metadata: {
                nodeId: node.nodeId,
                sourceFile: node.sourceFile,
                community: node.community ?? undefined,
              },
            });
      }
    }

    const relatedServicesBySymbol = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          return await this.entityGraph.getRelatedEntities(projectId, symbol.id, 1);
        } catch (error) {
          this.logger.debug(`Error getting related entities for symbol ${symbol.id}:`, error);
          return [];
        }
      }),
    );

    for (const relatedEntities of relatedServicesBySymbol) {
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
    }

    return Array.from(serviceSet.values());
  }

  private async getImpactedTickets(
    projectId: string,
    services: EntityRecord[],
  ): Promise<EntityRecord[]> {
    if (services.length === 0) return [];
    if (!this.codeIntelRepository) return [];

    const ticketSet = new Map<string, EntityRecord>();
    const serviceIds = services.map((service) => service.entityId);

    const ticketLinks = await this.codeIntelRepository.findEntityLinksByTargetIds(
      projectId,
      serviceIds,
      'ticket_to_service',
    );

    if (ticketLinks.length > 0) {
      const ticketIds = [...new Set(ticketLinks.map((link) => link.sourceId))];
      const ticketRows = await this.codeIntelRepository.findEntityNodesByIdsAndType(
        projectId,
        ticketIds,
        EntityNodeType.TICKET,
      );
      for (const row of ticketRows) {
        ticketSet.set(row.entityId, {
          entityId: row.entityId,
          entityType: row.entityType as EntityNodeType,
          label: row.label,
          metadata: this.parseMetadata(row.metadata),
        });
      }
    }

    const relatedTicketsByService = await Promise.all(
      services.map(async (service) => {
        try {
          return await this.entityGraph.getRelatedEntities(
            projectId,
            service.entityId,
            2,
          );
        } catch (error) {
          this.logger.debug(
            `Error getting related entities for service ${service.entityId}:`,
            error,
          );
          return [];
        }
      }),
    );

    for (const relatedEntities of relatedTicketsByService) {
      for (const path of relatedEntities) {
        for (const entity of path.path) {
          if (entity.entityType === EntityNodeType.TICKET) {
            ticketSet.set(entity.entityId, entity);
          }
        }
      }
    }

    return Array.from(ticketSet.values());
  }

  private async calculateImpactScore(
    projectId: string,
    symbols: SymbolData[],
    services: EntityRecord[],
    tickets: EntityRecord[],
  ): Promise<number> {
    if (symbols.length === 0 && services.length === 0 && tickets.length === 0) {
      return 0;
    }

    let totalSymbols = 1;
    let totalServices = 1;
    let totalTickets = 1;

    if (this.codeIntelRepository) {
      const [symbolCount, serviceCount, ticketCount] = await Promise.all([
        this.codeIntelRepository.countSymbols(projectId),
        this.codeIntelRepository.countEntityNodesByTypes(projectId, [
          EntityNodeType.SERVICE,
          EntityNodeType.CODE_MODULE,
        ]),
        this.codeIntelRepository.countEntityNodesByType(projectId, EntityNodeType.TICKET),
      ]);
      totalSymbols = Math.max(1, symbolCount);
      totalServices = Math.max(1, serviceCount);
      totalTickets = Math.max(1, ticketCount);
    }

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

  private parseMetadata(metadata: string): Record<string, unknown> {
    try {
      return JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
