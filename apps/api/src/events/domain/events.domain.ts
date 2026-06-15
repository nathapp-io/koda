export const EVENTS_REPOSITORY = Symbol('EVENTS_REPOSITORY');

export interface AgentEventDomain {
  id: string;
  projectId: string;
  agentId: string;
  action: string;
  actorId: string;
  source: string;
  data: string;
  timestamp: Date;
}

export interface DecisionEventDomain {
  id: string;
  projectId: string;
  agentId: string;
  action: string;
  decision: string;
  rationale: string | null;
  source: string;
  data: string;
  timestamp: Date;
}

export interface TicketEventDomain {
  id: string;
  ticketId: string | null;
  projectId: string;
  action: string;
  actorId: string;
  actorType: string;
  source: string;
  data: string;
  timestamp: Date;
}
