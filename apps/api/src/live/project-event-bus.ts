import { Injectable, Logger } from '@nestjs/common';
import type { LiveEvent } from './live-event';

export type LiveListener = (event: LiveEvent) => void;

interface Subscription {
  readonly listener: LiveListener;
  readonly delivered: Set<string>;
}

/** Consumer-side protection for partial fan-out / failed marker commits; durable producers own long-term dedup. */
export const MAX_RETRYABLE_FRAMES_PER_SUBSCRIPTION = 1024;

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
    const subscription: Subscription = { listener, delivered: new Set() };
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

  /** Outbox-backed producers: successful listeners see a frame once, failed listeners can retry independently. */
  publishRetryable(event: LiveEvent): void {
    const failures: unknown[] = [];
    for (const subscription of this.forProject(event.projectId)) {
      if (subscription.delivered.has(event.id)) continue;
      try {
        subscription.listener(event);
        subscription.delivered.add(event.id);
        if (subscription.delivered.size > MAX_RETRYABLE_FRAMES_PER_SUBSCRIPTION) {
          const oldest = subscription.delivered.values().next().value;
          if (oldest !== undefined) subscription.delivered.delete(oldest);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, failures.map((e) => e instanceof Error ? e.message : String(e)).join('; '));
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
