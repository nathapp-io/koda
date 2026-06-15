export const LABEL_REPOSITORY = Symbol('LABEL_REPOSITORY');

export interface LabelDomain {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
}

export interface ProjectRow {
  id: string;
  deletedAt: Date | null;
}

export interface TicketRow {
  id: string;
  projectId: string;
  number: number;
  deletedAt: Date | null;
  labels: TicketLabelRow[];
}

export interface TicketLabelRow {
  label: LabelDomain;
}

export interface TicketWithFlatLabels extends Omit<TicketRow, 'labels'> {
  labels: LabelDomain[];
}

export interface ILabelRepository {
  findProjectBySlug(slug: string): Promise<ProjectRow | null>;
  createLabel(data: { projectId: string; name: string; color: string | null }): Promise<LabelDomain>;
  findLabelsByProject(projectId: string): Promise<LabelDomain[]>;
  findLabelById(id: string): Promise<LabelDomain | null>;
  deleteLabel(id: string): Promise<void>;
  updateLabel(id: string, data: { name?: string; color?: string | null }): Promise<LabelDomain>;
  findTicketByRef(projectId: string, ticketRef: string): Promise<TicketRow | null>;
  findTicketLabelAssignment(ticketId: string, labelId: string): Promise<{ ticketId: string; labelId: string } | null>;
  findTicketLabelWithLabel(ticketId: string, labelId: string): Promise<{ ticketId: string; labelId: string; label: LabelDomain } | null>;
  assignLabelToTicket(ticketId: string, labelId: string): Promise<void>;
  removeLabelFromTicket(ticketId: string, labelId: string): Promise<void>;
  createTicketActivity(data: {
    ticketId: string;
    action: string;
    field: string;
    newValue?: string | null;
    oldValue?: string | null;
    actorUserId?: string | null;
    actorAgentId?: string | null;
  }): Promise<void>;
  findTicketWithLabels(ticketId: string): Promise<TicketWithFlatLabels | null>;
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
}
