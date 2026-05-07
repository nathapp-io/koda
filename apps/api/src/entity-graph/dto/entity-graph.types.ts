export const EntityNodeType = {
  TICKET: 'ticket',
  SERVICE: 'service',
  OWNER: 'owner',
  INCIDENT: 'incident',
  CODE_MODULE: 'code_module',
} as const;
export type EntityNodeType = (typeof EntityNodeType)[keyof typeof EntityNodeType];

export const EntityLinkRelation = {
  TICKET_TO_SERVICE: 'ticket_to_service',
  TICKET_TO_OWNER: 'ticket_to_owner',
  SERVICE_TO_SERVICE: 'service_to_service',
  INCIDENT_TO_TICKET: 'incident_to_ticket',
} as const;
export type EntityLinkRelation = (typeof EntityLinkRelation)[keyof typeof EntityLinkRelation];

export interface EntityRecord {
  entityId: string;
  entityType: EntityNodeType;
  label: string;
  metadata: Record<string, unknown>;
}

export interface EntityPath {
  path: EntityRecord[];
  relation: string;
  depth: number;
}

export interface ImpactAnalysis {
  incidentTicketId: string;
  affectedServices: EntityRecord[];
  affectedTickets: EntityRecord[];
  affectedCodeModules: EntityRecord[];
  rootCause?: string;
}

export interface TicketEvent {
  type: 'ticket_event';
  id: string;
  ticketId?: string;
  projectId: string;
  actorId: string;
  action: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

export interface GraphifyNodeDto {
  nodeId: string;
  type: string;
  label: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface GraphifyLinkDto {
  sourceId: string;
  targetId: string;
  relation: string;
}

export interface IEntityStore {
  findNodeByEntityId(projectId: string, entityId: string): Promise<EntityRecord | null>;
  findNodesByType(projectId: string, entityType: EntityNodeType): Promise<EntityRecord[]>;
  findLinksBySource(projectId: string, sourceId: string): Promise<Array<{ targetId: string; relation: string; metadata: Record<string, unknown> }>>;
  upsertNode(projectId: string, entityId: string, entityType: EntityNodeType, label: string, metadata?: Record<string, unknown>): Promise<EntityRecord>;
  upsertLink(projectId: string, sourceId: string, targetId: string, relation: string, metadata?: Record<string, unknown>): Promise<void>;
  deleteLinksBySource(projectId: string, sourceId: string): Promise<void>;
  findLinksByTarget(projectId: string, targetId: string): Promise<Array<{ sourceId: string; relation: string; metadata: Record<string, unknown> }>>;
}