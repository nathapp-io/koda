export const FLEET_PR_RULING_REPOSITORY = Symbol('FLEET_PR_RULING_REPOSITORY');
export type RulingDisposition = 'fixed' | 'waived' | 'overridden' | 'confirmed' | 'verified';
export type RulingState = 'pending' | 'applied' | 'skipped' | 'replaced';

export interface FleetPrRuling {
  id: string;
  projectId: string;
  repoId: string;
  prNumber: number;
  jobId: string;
  itemId: string;
  itemKind: string;
  text: string;
  disposition: RulingDisposition;
  actorType: 'USER' | 'AGENT';
  actorId: string;
  state: RulingState;
  skipReason: string | null;
  appliedJobId: string | null;
  commentId: string | null;
  approvalRequestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface CreateRulingInput { itemId: string; text: string }
export type NewFleetPrRuling = Omit<FleetPrRuling, 'id' | 'createdAt' | 'updatedAt'>;
export interface RulingJobTarget {
  projectId: string;
  repoId: string;
  prNumber: number | null;
  openItems: { id: string; kind: string }[];
}
export interface IFleetPrRulingRepository {
  /** Lock repo (fences job inserts), existing repo jobs and target rulings before revalidation.
   * Must be called inside the write transaction; locks last through replacement, insertion and audit. */
  lockTarget(slug: string, jobId: string): Promise<RulingJobTarget | null>;
  findTarget(projectId: string, jobId: string): Promise<(RulingJobTarget & { command: string; outcome: string | null }) | null>;
  latestRunForPr(repoId: string, prNumber: number): Promise<string | null>;
  latestRuling(jobId: string, itemId: string): Promise<FleetPrRuling | null>;
  list(jobId: string): Promise<FleetPrRuling[]>;
  replacePending(jobId: string, itemId: string): Promise<void>;
  insert(data: NewFleetPrRuling): Promise<FleetPrRuling>;
}
