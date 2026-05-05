import { Injectable, Logger } from '@nestjs/common';
import {
  EntityRecord,
  EntityPath,
  ImpactAnalysis,
  TicketEvent,
  GraphifyNodeDto,
  IEntityStore,
  EntityNodeType,
  EntityLinkRelation,
} from './dto/entity-graph.types';

@Injectable()
export class EntityGraphService {
  private readonly logger = new Logger(EntityGraphService.name);

  constructor(private readonly entityStore: IEntityStore) {}

  async rebuildGraph(projectId: string): Promise<void> {
    this.logger.debug(`rebuildGraph called with projectId=${projectId}`);
  }

  async onTicketEvent(event: TicketEvent): Promise<void> {
    this.logger.debug(`onTicketEvent called with event.action=${event.action}`);

    switch (event.action) {
      case 'status_changed': {
        const ticketId = event.ticketId;
        if (!ticketId) break;

        const ticketNode = await this.entityStore.findNodeByEntityId(
          event.projectId,
          ticketId,
        );
        if (ticketNode) {
          const newStatus = event.data?.newStatus as string | undefined;
          await this.entityStore.upsertNode(
            event.projectId,
            ticketId,
            EntityNodeType.TICKET,
            ticketNode.label,
            {
              ...ticketNode.metadata,
              status: newStatus,
              lastEventId: event.id,
            },
          );
        }
        break;
      }

      case 'assigned': {
        const ticketId = event.ticketId;
        if (!ticketId) break;

        const assignedToUserId = event.data?.assignedToUserId as string | undefined;
        const assignedToAgentId = event.data?.assignedToAgentId as string | undefined;

        if (assignedToUserId) {
          const ownerEntityId = `owner:${assignedToUserId}`;
          await this.entityStore.upsertNode(
            event.projectId,
            ownerEntityId,
            EntityNodeType.OWNER,
            `User ${assignedToUserId}`,
            { userId: assignedToUserId },
          );
          await this.entityStore.upsertLink(
            event.projectId,
            ticketId,
            ownerEntityId,
            EntityLinkRelation.TICKET_TO_OWNER,
            {},
          );
        }

        if (assignedToAgentId) {
          const ownerEntityId = `owner:${assignedToAgentId}`;
          await this.entityStore.upsertNode(
            event.projectId,
            ownerEntityId,
            EntityNodeType.OWNER,
            `Agent ${assignedToAgentId}`,
            { agentId: assignedToAgentId },
          );
          await this.entityStore.upsertLink(
            event.projectId,
            ticketId,
            ownerEntityId,
            EntityLinkRelation.TICKET_TO_OWNER,
            {},
          );
        }
        break;
      }

      default:
        this.logger.debug(`Unhandled ticket event action: ${event.action}`);
        break;
    }
  }

  async onGraphifyImport(projectId: string, nodes: GraphifyNodeDto[]): Promise<void> {
    this.logger.debug(
      `onGraphifyImport called with projectId=${projectId}, nodeCount=${nodes.length}`,
    );

    for (const node of nodes) {
      if (node.type !== 'code_module') continue;

      const entityId = `service:${node.nodeId}`;
      const metadata: Record<string, unknown> = {};

      if (node.tags && node.tags.length > 0) {
        metadata.tags = node.tags;
      }

      if (node.metadata) {
        Object.assign(metadata, node.metadata);
      }

      await this.entityStore.upsertNode(
        projectId,
        entityId,
        EntityNodeType.SERVICE,
        node.label,
        metadata,
      );
    }
  }

  async getRelatedEntities(projectId: string, entityId: string, depth = 2): Promise<EntityPath[]> {
    this.logger.debug(
      `getRelatedEntities called with projectId=${projectId}, entityId=${entityId}, depth=${depth}`,
    );

    const startNode = await this.entityStore.findNodeByEntityId(projectId, entityId);
    if (!startNode) return [];

    const paths: EntityPath[] = [];
    const visited = new Set<string>();
    visited.add(entityId);

    const queue: Array<{
      entityId: string;
      path: EntityRecord[];
      currentDepth: number;
    }> = [{ entityId, path: [startNode], currentDepth: 0 }];

    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry || entry.currentDepth >= depth) continue;

      const links = await this.entityStore.findLinksBySource(projectId, entry.entityId);

      for (const link of links) {
        const targetNode = await this.entityStore.findNodeByEntityId(
          projectId,
          link.targetId,
        );
        if (!targetNode) continue;

        const newPath = [...entry.path, targetNode];
        const newDepth = entry.currentDepth + 1;

        paths.push({
          path: newPath,
          relation: link.relation,
          depth: newDepth,
        });

        if (!visited.has(link.targetId)) {
          visited.add(link.targetId);
          queue.push({
            entityId: link.targetId,
            path: newPath,
            currentDepth: newDepth,
          });
        }
      }
    }

    return paths;
  }

  async getIncidentImpact(projectId: string, incidentTicketId: string): Promise<ImpactAnalysis> {
    this.logger.debug(
      `getIncidentImpact called with projectId=${projectId}, incidentTicketId=${incidentTicketId}`,
    );

    const result: ImpactAnalysis = {
      incidentTicketId,
      affectedServices: [],
      affectedTickets: [],
      affectedCodeModules: [],
    };

    let incidentNode = await this.entityStore.findNodeByEntityId(
      projectId,
      incidentTicketId,
    );
    if (!incidentNode) {
      incidentNode = await this.entityStore.findNodeByEntityId(
        projectId,
        `incident:${incidentTicketId}`,
      );
    }
    if (!incidentNode) return result;

    const visited = new Set<string>();
    visited.add(incidentNode.entityId);
    const queue: string[] = [incidentNode.entityId];

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId) continue;

      const links = await this.entityStore.findLinksBySource(projectId, currentId);

      for (const link of links) {
        if (visited.has(link.targetId)) continue;
        visited.add(link.targetId);

        const targetNode = await this.entityStore.findNodeByEntityId(
          projectId,
          link.targetId,
        );
        if (!targetNode) continue;

        switch (targetNode.entityType) {
          case EntityNodeType.TICKET:
            result.affectedTickets.push(targetNode);
            break;
          case EntityNodeType.SERVICE:
            result.affectedServices.push(targetNode);
            break;
          case EntityNodeType.CODE_MODULE:
            result.affectedCodeModules.push(targetNode);
            break;
        }

        queue.push(link.targetId);
      }
    }

    return result;
  }
}
