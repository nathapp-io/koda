/**
 * EntityStore — Retrieval-time entity index for entity-aware ranking
 *
 * Phase 2: in-memory store; must support rebuilds from outbox fan-out.
 *
 * STUB — real implementation to follow.
 */
import { Injectable } from '@nestjs/common';

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
  private entities = new Map<string, Map<string, Entity>>();

  indexEntity(projectId: string, entity: Entity): void {
    let projectEntities = this.entities.get(projectId);
    if (!projectEntities) {
      projectEntities = new Map();
      this.entities.set(projectId, projectEntities);
    }
    projectEntities.set(entity.id, { ...entity });
  }

  searchEntities(projectId: string, query: string): ScoredEntity[] {
    const projectEntities = this.entities.get(projectId);
    if (!projectEntities) return [];

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    const results: ScoredEntity[] = [];

    for (const entity of projectEntities.values()) {
      const labelLower = entity.label.toLowerCase();
      const labelMatch = labelLower.includes(queryLower);

      if (labelMatch || queryTerms.length > 0) {
        const score = this.computeEntityScore(query, entity.tags);
        results.push({ ...entity, score });
      }
    }

    return results;
  }

  getByTag(projectId: string, tag: string): ScoredEntity[] {
    const projectEntities = this.entities.get(projectId);
    if (!projectEntities) return [];

    const normalizedTag = tag.toLowerCase();

    return Array.from(projectEntities.values())
      .filter((entity) =>
        entity.tags.some((t) => t.toLowerCase() === normalizedTag),
      )
      .map((entity) => ({ ...entity, score: 1 }));
  }

  getAllEntities(projectId: string): ScoredEntity[] {
    const projectEntities = this.entities.get(projectId);
    if (!projectEntities) return [];
    return Array.from(projectEntities.values()).map((e) => ({ ...e, score: 0 }));
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
    this.entities.delete(projectId);
  }

  async handleOutboxEvent(event: {
    eventType: string;
    payload: unknown;
  }): Promise<void> {
    if (event.eventType === 'graphify_import') {
      const payload = event.payload as {
        projectId: string;
        nodes: Array<{
          id: string;
          label: string;
          type: string;
          source_file?: string;
        }>;
        links: unknown[];
      };

      for (const node of payload.nodes) {
        if (node.type === 'code_module') {
          this.indexEntity(payload.projectId, {
            id: node.id,
            label: node.label,
            tags: this.extractTagsFromLabel(node.label),
            source: 'code_module',
            sourceId: node.id,
          });
        }
      }
    } else if (event.eventType === 'ticket_event') {
      const payload = event.payload as {
        projectId: string;
        ticket: {
          id: string;
          ref: string;
          title: string;
          type: string;
        };
      };

      this.indexEntity(payload.projectId, {
        id: payload.ticket.id,
        label: payload.ticket.title,
        tags: this.extractTagsFromLabel(payload.ticket.title),
        source: 'ticket',
        sourceId: payload.ticket.id,
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