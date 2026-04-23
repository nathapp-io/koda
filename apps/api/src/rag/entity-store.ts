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
  indexEntity(projectId: string, entity: Entity): void {
    throw new Error('Not implemented');
  }

  searchEntities(projectId: string, query: string): ScoredEntity[] {
    throw new Error('Not implemented');
  }

  getByTag(projectId: string, tag: string): ScoredEntity[] {
    throw new Error('Not implemented');
  }

  getAllEntities(projectId: string): ScoredEntity[] {
    throw new Error('Not implemented');
  }

  computeEntityScore(query: string, entityTags: string[]): number {
    throw new Error('Not implemented');
  }

  clear(projectId: string): void {
    throw new Error('Not implemented');
  }

  async handleOutboxEvent(event: { eventType: string; payload: unknown }): Promise<void> {
    throw new Error('Not implemented');
  }
}