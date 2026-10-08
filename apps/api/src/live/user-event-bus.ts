import { Injectable, Logger } from '@nestjs/common';

/** Fleet S4a §4: content-free "you have a new notification" signal; the client refetches. */
export interface UserLiveEvent {
  readonly type: 'notification';
  readonly userId: string;
  readonly id: string;
  readonly at: string;
}

export type UserLiveListener = (event: UserLiveEvent) => void;

interface Subscription {
  readonly listener: UserLiveListener;
}

/**
 * In-process fan-out of user events to open `/me/events` streams, keyed by user id. Single API
 * instance by design (same constraint as ProjectEventBus). publish() never throws.
 */
@Injectable()
export class UserEventBus {
  private readonly logger = new Logger(UserEventBus.name);
  private subscriptions: ReadonlyMap<string, readonly Subscription[]> = new Map();

  subscribe(userId: string, listener: UserLiveListener): () => void {
    const subscription: Subscription = { listener };
    this.subscriptions = new Map([...this.subscriptions, [userId, [...this.forUser(userId), subscription]]]);
    return () => this.remove(userId, subscription);
  }

  publish(event: UserLiveEvent): void {
    for (const { listener } of this.forUser(event.userId)) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error(`User live listener failed for ${event.userId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  listenerCount(userId: string): number {
    return this.forUser(userId).length;
  }

  private forUser(userId: string): readonly Subscription[] {
    return this.subscriptions.get(userId) ?? [];
  }

  private remove(userId: string, subscription: Subscription): void {
    const remaining = this.forUser(userId).filter((s) => s !== subscription);
    const next = new Map(this.subscriptions);
    if (remaining.length > 0) next.set(userId, remaining);
    else next.delete(userId);
    this.subscriptions = next;
  }
}
