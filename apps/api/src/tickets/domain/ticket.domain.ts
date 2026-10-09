import type { TicketStatus, TicketType, Priority } from '../../common/enums';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';

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
  source?: string;
  jobId?: string | null;
  prNumber: number | null;
  prState: string | null;
  prUpdatedAt: Date | null;
  createdAt: Date;
}

export interface TicketAssignee {
  kind: 'user' | 'agent';
  id: string;
  name: string;
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
  /** M26: resolved name-only assignee; null when unassigned; undefined when not loaded. */
  assignee?: TicketAssignee | null;
}

export interface TicketListFilters {
  projectId: string;
  status?: TicketStatus;
  type?: TicketType;
  priority?: Priority;
  assignedToUserId?: string;
  assignedToAgentId?: string;
  unassigned?: boolean;
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
  findTicketPage(filters: TicketListFilters, page: IPageOption): Promise<IPageResult<TicketDomain>>;
  findTicketByProjectAndNumber(projectId: string, number: number): Promise<TicketDomain | null>;
  findTicketById(id: string): Promise<TicketDomain | null>;
  updateTicket(id: string, data: UpdateTicketData): Promise<TicketDomain>;
  assignTicket(id: string, data: AssignTicketData): Promise<TicketDomain>;
  softDeleteTicket(id: string): Promise<TicketDomain>;
  findTicketByRefRaw(projectSlug: string, ref: string): Promise<TicketDomain | null>;
  /**
   * H5: resolve a ticket ref (KEY-N or CUID) strictly within one project.
   * KEY-N prefix must equal projectKey; CUIDs are looked up with a projectId
   * constraint; soft-deleted tickets are excluded unless includeDeleted.
   */
  findTicketScoped(
    projectId: string,
    projectKey: string,
    ref: string,
    opts?: { includeDeleted?: boolean },
  ): Promise<TicketDomain | null>;
  /**
   * M3: conditional status write. Updates the ticket to `to` only when its
   * current status is still `from`; returns the fresh row, or null when no
   * row matched (stale read — another writer transitioned the ticket).
   */
  updateTicketStatusIf(id: string, from: string, to: string): Promise<TicketDomain | null>;
  /**
   * S4c US-004: the assignee's account state, not just its existence — a
   * disabled account can never be assigned a ticket.
   */
  findUserById(id: string): Promise<{ id: string; role: string; disabled: boolean } | null>;
  /**
   * S4c US-004: the agent's id plus its lifecycle status; an OFFLINE agent
   * cannot be assigned a ticket.
   */
  findAgentById(id: string): Promise<{ id: string; status: string } | null>;
  /**
   * S4c US-004: whether the agent holds an `AgentProject` roster row for the
   * project. Assignment requires the roster in both scoping modes.
   */
  isAgentOnProjectRoster(projectId: string, agentId: string): Promise<boolean>;
  /**
   * S4c US-004: serializes ticket assignment against roster removal for one
   * project — `AgentsService.removeFromProject` takes the same lock. Call only
   * inside `txManager.run`: the advisory lock is released at COMMIT/ROLLBACK.
   */
  lockProjectAgents(projectId: string): Promise<void>;
  findProjectMemberRole(projectId: string, userId: string): Promise<string | null>;
  /**
   * Fleet C9 follow-up (#231): true when the ticket is already owned by fleet
   * work — a fleet-sourced `pr` link exists, or a non-terminal FleetJobTicket is
   * linked. The classic VERIFIED auto-PR yields to fleet so one ticket never
   * ends up with two open PRs.
   */
  hasFleetOwnership(ticketId: string): Promise<boolean>;
}
