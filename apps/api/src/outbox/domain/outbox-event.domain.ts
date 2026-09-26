export interface OutboxEventDomain {
  id: string;
  projectId: string;
  type: string;
  eventId: string;
  payload: string;
  headers: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  owner: string | null;
  lastError: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
