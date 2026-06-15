import type {
  CanonicalDecision,
  CanonicalEvent,
  CanonicalSnapshotQuery,
  CanonicalTicket,
} from '../canonical-state.service';

export const CANONICAL_STATE_REPOSITORY = Symbol('CANONICAL_STATE_REPOSITORY');

export interface ICanonicalStateRepository {
  findProject(projectId: string): Promise<{ id: string; deletedAt: Date | null } | null>;
  findTickets(query: CanonicalSnapshotQuery): Promise<CanonicalTicket[]>;
  findEvents(query: CanonicalSnapshotQuery): Promise<CanonicalEvent[]>;
  findActiveDecisions(projectId: string): Promise<CanonicalDecision[]>;
}
