/**
 * EntityStore — Retrieval-time entity index for entity-aware ranking
 *
 * Phase 2: in-memory store; supports rebuilds from outbox fan-out.
 * Handles graphify_import events (code_module nodes) and ticket_event events (ticket entities).
 */
import { Injectable, Optional } from '@nestjs/common';
import { PrismaRagRepository } from './prisma-rag.repository';
import { KeyedMutex } from '../common/utils/keyed-mutex';

export interface Entity {
  id: string;
  label: string;
  tags: string[];
  source: string;
  sourceId: string;
}

export interface ScoredEntity extends Entity {
  score: number;
}

@Injectable()
export class EntityStore {
  private readonly entities = new Map<string, Map<string, Entity>>();
  private readonly moduleEntities = new Map<string, Map<string, Entity>>();
  private readonly refreshLock = new KeyedMutex();
  private readonly pendingRefreshes = new Map<string, symbol>();

  constructor(
    @Optional() private readonly ragRepository?: PrismaRagRepository,
  ) {}

  indexEntity(projectId: string, entity: Entity): void {
    const index = entity.source === 'code_module' ? this.moduleEntities : this.entities;
    let projectEntities = index.get(projectId);
    if (!projectEntities) {
      projectEntities = new Map();
      index.set(projectId, projectEntities);
    }
    projectEntities.set(entity.id, { ...entity });
  }

  removeEntity(projectId: string, id: string): void {
    this.entities.get(projectId)?.delete(id);
  }

  private *projectEntities(projectId: string): IterableIterator<Entity> {
    yield* this.entities.get(projectId)?.values() ?? [];
    yield* this.moduleEntities.get(projectId)?.values() ?? [];
  }

  searchEntities(projectId: string, query: string): ScoredEntity[] {
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    const results: ScoredEntity[] = [];

    for (const entity of this.projectEntities(projectId)) {
      const labelLower = entity.label.toLowerCase();
      const labelMatch = labelLower.includes(queryLower);
      const tagMatch = queryTerms.length > 0 && entity.tags.some(t =>
        queryTerms.some(term => t.toLowerCase().includes(term)),
      );

      if (labelMatch || tagMatch) {
        const score = this.computeEntityScore(query, entity.tags);
        results.push({ ...entity, score });
      }
    }

    return results;
  }

  getByTag(projectId: string, tag: string): ScoredEntity[] {
    const normalizedTag = tag.toLowerCase();

    return Array.from(this.projectEntities(projectId))
      .filter((entity) =>
        entity.tags.some((t) => t.toLowerCase() === normalizedTag),
      )
      .map((entity) => ({ ...entity, score: 1 }));
  }

  getAllEntities(projectId: string): ScoredEntity[] {
    return Array.from(this.projectEntities(projectId)).map((e) => ({ ...e, score: 0 }));
  }

  computeEntityScore(query: string, entityTags: string[]): number {
    if (!query || entityTags.length === 0) return 0;

    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (queryTerms.length === 0) return 0;

    const normalizedTags = entityTags.map((t) => t.toLowerCase());
    const intersectionSize = queryTerms.filter((term) =>
      normalizedTags.some((tag) => tag.includes(term)),
    ).length;

    return intersectionSize / entityTags.length;
  }

  clear(projectId: string): void {
    this.pendingRefreshes.delete(projectId);
    this.entities.delete(projectId);
    this.moduleEntities.delete(projectId);
  }

  async handleOutboxEvent(event: {
    eventType: string;
    payload: unknown;
  }): Promise<void> {
    if (event.eventType === 'rag_graph_refresh' || event.eventType === 'graphify_import') {
      const payload = event.payload as {
        projectId?: unknown;
        nodes?: Array<{ id: string; label: string; type: string }>;
      } | null;
      if (typeof payload?.projectId !== 'string' || !payload.projectId.trim()) {
        throw new Error(`${event.eventType} requires a projectId`);
      }
      if (this.ragRepository) {
        await this.indexGraphifyEntitiesForProject(payload.projectId);
      } else {
        // Standalone stores may be hydrated from a complete payload.
        if (!payload.nodes) return;
        const modules = new Map<string, Entity>();
        for (const node of payload.nodes) {
          if (node.type === 'code_module') modules.set(node.id, this.codeModule(node.id, node.label));
        }
        this.replaceCodeModules(payload.projectId, modules);
      }
    } else if (event.eventType === 'ticket_event') {
      const payload = event.payload as {
        action?: unknown;
        ticketId?: string;
        projectId?: string;
        actorId?: string;
        data?: Record<string, unknown>;
        ticket?: { id: string; ref: string; title: string; type: string };
      };
      if (
        payload.action === 'TICKET_DELETED' &&
        typeof payload.ticketId === 'string' &&
        typeof payload.projectId === 'string'
      ) {
        this.removeEntity(payload.projectId, payload.ticketId);
        return;
      }
      if (payload.ticket) {
        this.indexEntity(payload.projectId ?? '', {
          id: payload.ticket.id,
          label: payload.ticket.title,
          tags: this.extractTagsFromLabel(payload.ticket.title),
          source: 'ticket',
          sourceId: payload.ticket.id,
        });
      } else if (payload.ticketId && payload.projectId) {
        await this.indexTicketEntity(payload.ticketId, payload.projectId);
      }
    }
  }

  async indexGraphifyEntitiesForProject(projectId: string): Promise<void> {
    const repository = this.ragRepository;
    if (!repository) return;

    const refresh = Symbol();
    this.pendingRefreshes.set(projectId, refresh);
    // A clear or a newer refresh invalidates any pending snapshot for this project.
    await this.refreshLock.run(projectId, async () => {
      if (this.pendingRefreshes.get(projectId) !== refresh) return;
      try {
        const modules = new Map<string, Entity>();
        await repository.scanCodeModules(projectId, (page) => {
          for (const node of page) {
            modules.set(node.nodeId, this.codeModule(node.nodeId, node.label));
          }
        });
        if (this.pendingRefreshes.get(projectId) === refresh) this.replaceCodeModules(projectId, modules);
      } finally {
        if (this.pendingRefreshes.get(projectId) === refresh) this.pendingRefreshes.delete(projectId);
      }
    });
  }

  private codeModule(id: string, label: string): Entity {
    return { id, label, tags: this.extractTagsFromLabel(label), source: 'code_module', sourceId: id };
  }

  private replaceCodeModules(projectId: string, modules: Map<string, Entity>): void {
    if (modules.size === 0) this.moduleEntities.delete(projectId);
    else this.moduleEntities.set(projectId, modules);
  }

  private async indexTicketEntity(ticketId: string, projectId: string): Promise<void> {
    if (!this.ragRepository) return;

    const ticket = await this.ragRepository.findTicketById(ticketId);
    if (ticket) {
      this.indexEntity(projectId, {
        id: ticket.id,
        label: ticket.title,
        tags: this.extractTagsFromLabel(ticket.title),
        source: 'ticket',
        sourceId: ticket.id,
      });
    }
  }

  private extractTagsFromLabel(label: string): string[] {
    return label
      .split(/[\s_]+|(?=[A-Z])/)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length > 1);
  }
}
