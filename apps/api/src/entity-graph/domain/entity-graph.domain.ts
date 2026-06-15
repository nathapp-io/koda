export const ENTITY_GRAPH_REPOSITORY = Symbol('ENTITY_GRAPH_REPOSITORY');

export interface TicketWithLabelsAndLinks {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  number: number;
  gitRefFile: string | null;
  gitRefVersion: string | null;
  gitRefLine: number | null;
  assignedToUserId: string | null;
  assignedToAgentId: string | null;
  labels: Array<{ label: { name: string } }>;
  links: Array<Record<string, unknown>>;
}

export interface GraphNodeRecord {
  nodeId: string;
  label: string;
  type: string;
  sourceFile: string | null;
  community: number | null;
}

export interface GraphLinkRecord {
  sourceId: string;
  targetId: string;
  relation: string;
}

export interface IEntityGraphRepository {
  findTicketsWithLabelsAndLinks(projectId: string): Promise<TicketWithLabelsAndLinks[]>;
  findGraphNodesByType(projectId: string, type: string): Promise<GraphNodeRecord[]>;
  findGraphLinksByRelation(projectId: string, relation: string): Promise<GraphLinkRecord[]>;
}
