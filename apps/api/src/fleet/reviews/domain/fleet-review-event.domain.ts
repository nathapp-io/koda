export const FLEET_REVIEW_EVENT_REPOSITORY = Symbol('FLEET_REVIEW_EVENT_REPOSITORY');

export interface FleetReviewEventRecord {
  id: string;
  jobId: string;
  leaseEpoch: number;
  projectId: string;
  repoId: string;
  prNumber: number;
  findingKey: string;
  threadId: string;
  file: string | null;
  line: number | null;
  finding: string;
  reason: string;
  disagreedBy: string[];
  trusted: boolean;
  status: string;
  skipReason: string | null;
  approverLogin: string | null;
  memoryItemId: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewFleetReviewEvent = Omit<FleetReviewEventRecord, 'id' | 'attempts' | 'createdAt' | 'updatedAt' | 'approverLogin' | 'memoryItemId'>;
export interface IFleetReviewEventRepository {
  insertMany(rows: NewFleetReviewEvent[]): Promise<number>;
  claimPending(limit: number): Promise<FleetReviewEventRecord[]>;
  markMinted(id: string, result: { memoryItemId: string; approverLogin: string }): Promise<void>;
  markSkipped(id: string, reason: string): Promise<void>;
  bumpAttempt(id: string): Promise<number>;
}
