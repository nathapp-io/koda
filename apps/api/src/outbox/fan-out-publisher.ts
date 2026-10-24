import { runAsSystem } from '../action-context/action-context';
import { SystemWriter } from '../permissions/system-writer.decorator';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { IOutboxPublisher, OutboxRecord } from '@nathapp/nestjs-outbox';
import { PrismaOutboxRepository } from './prisma-outbox.repository';

export type OutboxHandlerFn = (payload: unknown) => void | Promise<void>;

export const OUTBOX_LAST_ERROR_MAX_LENGTH = 2000;

export class OutboxFanOutError extends Error {
  constructor(
    readonly type: string,
    readonly failures: readonly string[],
  ) {
    super(`${failures.length} fan-out handler(s) failed for ${type}: ${failures.join('; ')}`);
    this.name = 'OutboxFanOutError';
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The outbox publisher for @nathapp/nestjs-outbox. Consumers register
 * per-type handlers in onModuleInit. publish() runs every handler for the
 * record's type; if any fail it records lastError and throws one aggregate
 * error, so the relay retries the event (all handlers run again: consumers
 * must be idempotent).
 *
 * Permissions P2 US-006: every handler runs inside `runAsSystem('outbox')`, so the writes it makes
 * are attributed to the outbox (the writer's own key, not the registrant's — see the design note in
 * `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` §5). Failure collection
 * is unchanged: a throw inside that context is collected like any other.
 */
@Injectable()
@SystemWriter('system.outbox.dispatch')
export class FanOutPublisher implements IOutboxPublisher, OnApplicationBootstrap {
  private readonly logger = new Logger(FanOutPublisher.name);
  private handlers: ReadonlyMap<string, readonly OutboxHandlerFn[]> = new Map();

  constructor(
    @Inject(PrismaOutboxRepository)
    private readonly lastErrors: Pick<PrismaOutboxRepository, 'recordLastError'>,
  ) {}

  // Runs after every module's onModuleInit, so consumer subscribers have
  // already registered their handlers by the time this count is logged.
  onApplicationBootstrap(): void {
    const total = [...this.handlers.values()].reduce((count, list) => count + list.length, 0);
    this.logger.log(`Registered ${total} handlers`);
  }

  register(type: string, handler: OutboxHandlerFn): void {
    const existing = this.getHandlers(type);
    if (existing.includes(handler)) return;
    this.handlers = new Map([...this.handlers, [type, [...existing, handler]]]);
  }

  unregister(type: string, handler: OutboxHandlerFn): void {
    const remaining = this.getHandlers(type).filter((h) => h !== handler);
    const next = new Map(this.handlers);
    if (remaining.length > 0) next.set(type, remaining);
    else next.delete(type);
    this.handlers = next;
  }

  getHandlers(type: string): readonly OutboxHandlerFn[] {
    return this.handlers.get(type) ?? [];
  }

  async publish(record: OutboxRecord): Promise<void> {
    const failures: string[] = [];
    for (const handler of this.getHandlers(record.type)) {
      try {
        await runAsSystem('outbox', () => handler(record.payload));
      } catch (err) {
        const message = errorMessage(err);
        this.logger.error(`Handler for ${record.type} failed on outbox event ${record.id}: ${message}`);
        failures.push(message);
      }
    }
    if (failures.length === 0) return;

    const error = new OutboxFanOutError(record.type, failures);
    try {
      await this.lastErrors.recordLastError(record.id, error.message.slice(0, OUTBOX_LAST_ERROR_MAX_LENGTH));
    } catch (err) {
      this.logger.warn(`Could not record lastError for outbox event ${record.id}: ${errorMessage(err)}`);
    }
    throw error;
  }
}
