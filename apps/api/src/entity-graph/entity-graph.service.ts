import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import {
  EntityRecord,
  EntityPath,
  ImpactAnalysis,
  TicketEvent,
  GraphifyNodeDto,
  GraphifyLinkDto,
  IEntityStore,
  EntityNodeType,
  EntityLinkRelation,
} from './dto/entity-graph.types';
import { ENTITY_GRAPH_STORE } from './entity-graph.tokens';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class EntityGraphService {
  private readonly logger = new Logger(EntityGraphService.name);

  constructor(
    @Inject(ENTITY_GRAPH_STORE) private readonly entityStore: IEntityStore,
    @Optional() private readonly prisma?: PrismaService<PrismaClient>,
  ) {}

  async rebuildGraph(projectId: string): Promise<void> {
    this.logger.debug(`rebuildGraph called with projectId=${projectId}`);

    if (!this.prisma) {
      this.logger.warn('rebuildGraph requires PrismaService; skipping');
      return;
    }

    const tickets = await this.prisma.client.ticket.findMany({
      where: { projectId, deletedAt: null },
      include: { labels: { include: { label: true } }, links: true },
    });

    for (const ticket of tickets) {
      const labelNames = ticket.labels.map((tl) => tl.label.name);

      await this.entityStore.upsertNode(
        projectId,
        ticket.id,
        EntityNodeType.TICKET,
        ticket.title,
        {
          status: ticket.status,
          priority: ticket.priority,
          type: ticket.type,
          number: ticket.number,
          gitRefFile: ticket.gitRefFile ?? undefined,
          gitRefVersion: ticket.gitRefVersion ?? undefined,
          gitRefLine: ticket.gitRefLine ?? undefined,
          labels: labelNames,
        },
      );

      if (ticket.assignedToUserId) {
        const ownerEntityId = `owner:${ticket.assignedToUserId}`;
        await this.entityStore.upsertNode(
          projectId,
          ownerEntityId,
          EntityNodeType.OWNER,
          `User ${ticket.assignedToUserId}`,
          { userId: ticket.assignedToUserId },
        );
        await this.entityStore.upsertLink(
          projectId,
          ticket.id,
          ownerEntityId,
          EntityLinkRelation.TICKET_TO_OWNER,
          {},
        );
      }

      if (ticket.assignedToAgentId) {
        const ownerEntityId = `owner:${ticket.assignedToAgentId}`;
        await this.entityStore.upsertNode(
          projectId,
          ownerEntityId,
          EntityNodeType.OWNER,
          `Agent ${ticket.assignedToAgentId}`,
          { agentId: ticket.assignedToAgentId },
        );
        await this.entityStore.upsertLink(
          projectId,
          ticket.id,
          ownerEntityId,
          EntityLinkRelation.TICKET_TO_OWNER,
          {},
        );
      }
    }

    const graphNodes = await this.prisma.client.graphNode.findMany({
      where: { projectId, type: 'code_module' },
    });

    for (const gn of graphNodes) {
      const entityId = `service:${gn.nodeId}`;
      const existingNode = await this.entityStore.findNodeByEntityId(projectId, entityId);
      await this.entityStore.upsertNode(
        projectId,
        entityId,
        EntityNodeType.SERVICE,
        gn.label,
        {
          ...(existingNode?.metadata ?? {}),
          nodeId: gn.nodeId,
          type: gn.type,
          sourceFile: gn.sourceFile ?? undefined,
          community: gn.community ?? undefined,
        },
      );
    }

    const graphLinks = await this.prisma.client.graphLink.findMany({
      where: { projectId, relation: 'depends_on' },
    });

    for (const gl of graphLinks) {
      const sourceEntityId = `service:${gl.sourceId}`;
      const targetEntityId = `service:${gl.targetId}`;

      const sourceExists = await this.entityStore.findNodeByEntityId(projectId, sourceEntityId);
      const targetExists = await this.entityStore.findNodeByEntityId(projectId, targetEntityId);

      if (sourceExists && targetExists) {
        await this.entityStore.upsertLink(
          projectId,
          sourceEntityId,
          targetEntityId,
          EntityLinkRelation.SERVICE_TO_SERVICE,
          { relation: gl.relation },
        );
      }
    }

    for (const ticket of tickets) {
      if (ticket.priority === 'CRITICAL' || ticket.priority === 'HIGH') {
        const incidentEntityId = `incident:${ticket.id}`;
        await this.entityStore.upsertNode(
          projectId,
          incidentEntityId,
          EntityNodeType.INCIDENT,
          ticket.title,
          {
            ticketId: ticket.id,
            priority: ticket.priority,
            status: ticket.status,
          },
        );
        await this.entityStore.upsertLink(
          projectId,
          incidentEntityId,
          ticket.id,
          EntityLinkRelation.INCIDENT_TO_TICKET,
          {},
        );
      }
    }

    const serviceNodes = await this.entityStore.findNodesByType(projectId, EntityNodeType.SERVICE);

    for (const ticket of tickets) {
      const labelNames = ticket.labels.map((tl) => tl.label.name);

      for (const serviceNode of serviceNodes) {
        const serviceSourceFile = serviceNode.metadata?.sourceFile as string | undefined;
        const serviceTags = serviceNode.metadata?.tags as string[] | undefined;
        if (serviceSourceFile && ticket.gitRefFile && ticket.gitRefFile.includes(serviceSourceFile)) {
          await this.entityStore.upsertLink(
            projectId,
            ticket.id,
            serviceNode.entityId,
            EntityLinkRelation.TICKET_TO_SERVICE,
            { source: 'gitRefFile', refFile: ticket.gitRefFile },
          );
        }

        if (labelNames.length > 0 && serviceTags) {
          const hasMatchingTag = labelNames.some((l) =>
            serviceTags.some((t) => t.toLowerCase() === l.toLowerCase()),
          );
          if (hasMatchingTag) {
            await this.entityStore.upsertLink(
              projectId,
              ticket.id,
              serviceNode.entityId,
              EntityLinkRelation.TICKET_TO_SERVICE,
              { source: 'label_tag', labels: labelNames },
            );
          }
        }
      }
    }

    this.logger.log(`rebuildGraph completed for projectId=${projectId}: ${tickets.length} tickets, ${graphNodes.length} services, ${graphLinks.length} graph links`);
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

  async onGraphifyImport(projectId: string, nodes: GraphifyNodeDto[], links?: GraphifyLinkDto[]): Promise<void> {
    this.logger.debug(
      `onGraphifyImport called with projectId=${projectId}, nodeCount=${nodes.length}, linkCount=${links?.length ?? 0}`,
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

    if (links && links.length > 0) {
      for (const link of links) {
        if (link.relation !== 'depends_on') continue;

        const sourceEntityId = `service:${link.sourceId}`;
        const targetEntityId = `service:${link.targetId}`;

        await this.entityStore.upsertLink(
          projectId,
          sourceEntityId,
          targetEntityId,
          EntityLinkRelation.SERVICE_TO_SERVICE,
          { relation: link.relation },
        );
      }
    }

    if (!links || links.length === 0) {
      await this.inferServiceLinksFromDb(projectId);
    }
  }

  private async inferServiceLinksFromDb(projectId: string): Promise<void> {
    if (!this.prisma) return;

    const graphLinks = await this.prisma.client.graphLink.findMany({
      where: { projectId, relation: 'depends_on' },
    });

    for (const gl of graphLinks) {
      const sourceEntityId = `service:${gl.sourceId}`;
      const targetEntityId = `service:${gl.targetId}`;

      const sourceExists = await this.entityStore.findNodeByEntityId(projectId, sourceEntityId);
      const targetExists = await this.entityStore.findNodeByEntityId(projectId, targetEntityId);

      if (sourceExists && targetExists) {
        await this.entityStore.upsertLink(
          projectId,
          sourceEntityId,
          targetEntityId,
          EntityLinkRelation.SERVICE_TO_SERVICE,
          { relation: gl.relation },
        );
      }
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
    if (!incidentNode || incidentNode.entityType !== EntityNodeType.INCIDENT) {
      const prefixedNode = await this.entityStore.findNodeByEntityId(
        projectId,
        `incident:${incidentTicketId}`,
      );
      if (prefixedNode) {
        incidentNode = prefixedNode;
      }
    }
    if (!incidentNode || incidentNode.entityType !== EntityNodeType.INCIDENT) return result;

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
