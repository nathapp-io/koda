export const POLICY_REPOSITORY = Symbol('POLICY_REPOSITORY');

export interface TicketSnapshot {
  id: string;
  status: string;
  priority: string;
  title: string;
}
