export interface OutboxEventDomain {
  id: string;
  projectId: string;
  eventType: string;
  eventId: string;
  payload: string;
  status: string;
  attempts: number;
  lastError: string | null;
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
