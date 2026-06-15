import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import {
  CANONICAL_STATE_REPOSITORY,
  type ICanonicalStateRepository,
} from './domain/canonical-state.domain';

export interface CanonicalSnapshotQuery {
  projectId: string;
  ticketIds?: string[];
  actorId?: string;
  timeWindow?: { from?: Date; to?: Date };
}

export interface CanonicalTicket {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignedToUserId: string | null;
  assignedToAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CanonicalEvent {
  id: string;
  eventType: string;
  actorId: string;
  action: string;
  payload: Record<string, unknown>;
  rationale: string | null;
  createdAt: Date;
}

export interface CanonicalDecision {
  id: string;
  topic: string;
  decision: string;
  rationale: string | null;
  createdAt: Date;
}

export interface CanonicalSnapshot {
  tickets: CanonicalTicket[];
  recentEvents: CanonicalEvent[];
  activeDecisions: CanonicalDecision[];
  retrievedAt: Date;
}

@Injectable()
export class CanonicalStateService {
  constructor(
    @Inject(CANONICAL_STATE_REPOSITORY)
    private readonly repo: ICanonicalStateRepository,
  ) {}

  async getSnapshot(query: CanonicalSnapshotQuery): Promise<CanonicalSnapshot> {
    const retrievedAt = new Date();

    const project = await this.repo.findProject(query.projectId);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'memory');
    }

    const [tickets, recentEvents, activeDecisions] = await Promise.all([
      this.repo.findTickets(query),
      this.repo.findEvents(query),
      this.repo.findActiveDecisions(query.projectId),
    ]);

    return {
      tickets,
      recentEvents,
      activeDecisions,
      retrievedAt,
    };
  }
}
