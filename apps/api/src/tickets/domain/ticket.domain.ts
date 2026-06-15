import type { TicketStatus, TicketType, Priority } from '../../common/enums';

export const TICKET_REPOSITORY = Symbol('TICKET_REPOSITORY');

export interface TicketProject {
  id: string;
  slug: string;
  key: string;
  gitRemoteUrl: string | null;
  autoIndexOnClose: boolean;
  deletedAt: Date | null;
}

export interface TicketLabel {
  label: {
    id: string;
    name: string;
    color: string | null;
  };
}

export interface TicketLink {
  id: string;
  ticketId: string;
  url: string;
  provider: string | null;
  externalRef: string | null;
  linkType: string | null;
  prNumber: number | null;
  prState: string | null;
  prUpdatedAt: Date | null;
  createdAt: Date;
}

export interface TicketDomain {
  id: string;
  projectId: string;
  number: number;
  type: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignedToUserId: string | null;
  assignedToAgentId: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  gitRefVersion: string | null;
  gitRefFile: string | null;
  gitRefLine: number | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  labels?: TicketLabel[];
  links?: TicketLink[];
}

export interface FindTicketsFilters {
  projectId: string;
  status?: TicketStatus;
  type?: TicketType;
  priority?: Priority;
  assignedToUserId?: string;
  unassigned?: boolean;
  limit: number;
  page: number;
}

export interface CreateTicketData {
  projectId: string;
  number: number;
  type: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
}

export interface UpdateTicketData {
  title?: string;
  description?: string;
  priority?: string;
  status?: string;
}

export interface AssignTicketData {
  assignedToUserId: string | null;
  assignedToAgentId: string | null;
}

export interface ITicketRepository {
  findProjectBySlug(slug: string): Promise<TicketProject | null>;
  findLastTicketInProject(projectId: string): Promise<{ number: number } | null>;
  createTicket(data: CreateTicketData): Promise<TicketDomain>;
  findTicketsByProject(filters: FindTicketsFilters): Promise<TicketDomain[]>;
  countTicketsByProject(filters: Omit<FindTicketsFilters, 'limit' | 'page'>): Promise<number>;
  findTicketByProjectAndNumber(projectId: string, number: number): Promise<TicketDomain | null>;
  findTicketById(id: string): Promise<TicketDomain | null>;
  updateTicket(id: string, data: UpdateTicketData): Promise<TicketDomain>;
  assignTicket(id: string, data: AssignTicketData): Promise<TicketDomain>;
  softDeleteTicket(id: string): Promise<TicketDomain>;
  findTicketByRefRaw(projectSlug: string, ref: string): Promise<TicketDomain | null>;
}
