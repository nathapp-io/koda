import { Injectable, Logger } from '@nestjs/common';
import type { LiveEvent } from './live-event';

export type LiveListener = (event: LiveEvent) => void;

interface Subscription {
  readonly listener: LiveListener;
}

/**
 * In-process fan-out of live events to open SSE streams, keyed by project.
 * Single API instance by design (spec constraint: no Redis). publish() never
 * throws: a failing listener is logged and skipped.
 */
@Injectable()
export class ProjectEventBus {
  private readonly logger = new Logger(ProjectEventBus.name);
  private subscriptions: ReadonlyMap<string, readonly Subscription[]> = new Map();

  subscribe(projectId: string, listener: LiveListener): () => void {
    const subscription: Subscription = { listener };
    this.subscriptions = new Map([...this.subscriptions, [projectId, [...this.forProject(projectId), subscription]]]);
    return () => this.remove(projectId, subscription);
  }

  publish(event: LiveEvent): void {
    for (const { listener } of this.forProject(event.projectId)) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error(`Live listener failed for project ${event.projectId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  listenerCount(projectId: string): number {
    return this.forProject(projectId).length;
  }

  private forProject(projectId: string): readonly Subscription[] {
    return this.subscriptions.get(projectId) ?? [];
  }

  private remove(projectId: string, subscription: Subscription): void {
    const remaining = this.forProject(projectId).filter((s) => s !== subscription);
    const next = new Map(this.subscriptions);
    if (remaining.length > 0) next.set(projectId, remaining);
    else next.delete(projectId);
    this.subscriptions = next;
  }
}
