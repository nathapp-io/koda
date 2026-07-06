export interface OutboxEventDomain {
  id: string;
  projectId: string;
  eventType: string;
  eventId: string;
  payload: string;
  status: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutboxEventInput {
  projectId: string;
  eventType: string;
  eventId: string;
  payload: unknown;
}

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

// Exponential backoff applied to failed outbox events, keyed by attempt count: 1s, 4s, 16s.
export const OUTBOX_BACKOFF_MS = (attempt: number): number => Math.pow(2, attempt * 2) * 1000;
