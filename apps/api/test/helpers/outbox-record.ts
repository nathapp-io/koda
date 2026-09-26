import { OutboxRecord, OutboxStatus } from '@nathapp/nestjs-outbox';
import type { PrismaOutboxRepository } from '../../src/outbox/prisma-outbox.repository';

/** A claimed outbox record, as the relay hands it to the publisher. */
export function outboxRecord(
  type: string,
  payload: unknown,
  overrides: Partial<OutboxRecord> = {},
): OutboxRecord {
  const now = new Date();
  return {
    id: 'outbox-test-record',
    type,
    payload,
    status: OutboxStatus.PROCESSING,
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
    ...overrides,
  };
}

/** FanOutPublisher dependency for tests that do not assert lastError writes. */
export const noopLastErrors: Pick<PrismaOutboxRepository, 'recordLastError'> = {
  recordLastError: async (): Promise<void> => undefined,
};
