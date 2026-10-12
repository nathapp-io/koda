import { Injectable, Logger } from '@nestjs/common';

export type ThreadLiveEvent = { id: string; threadId: string; at: string } & (
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'message'; messageId: string }
  | { type: 'question'; requestId: string; text: string }
  | { type: 'thread' }
);

export type ThreadLiveListener = (event: ThreadLiveEvent) => void;

@Injectable()
export class ThreadEventBus {
  private readonly logger = new Logger(ThreadEventBus.name);
  private subscriptions: ReadonlyMap<string, readonly ThreadLiveListener[]> = new Map();

  subscribe(threadId: string, listener: ThreadLiveListener): () => void {
    this.subscriptions = new Map([...this.subscriptions, [threadId, [...(this.subscriptions.get(threadId) ?? []), listener]]]);
    return () => {
      const remaining = (this.subscriptions.get(threadId) ?? []).filter((candidate) => candidate !== listener);
      const next = new Map(this.subscriptions);
      if (remaining.length) next.set(threadId, remaining);
      else next.delete(threadId);
      this.subscriptions = next;
    };
  }

  publish(event: ThreadLiveEvent): void {
    for (const listener of this.subscriptions.get(event.threadId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(`Thread live listener failed for ${event.threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
