export const CI_WEBHOOK_REPOSITORY = Symbol('CI_WEBHOOK_REPOSITORY');

export interface CiTicketDomain {
  id: string;
  projectId: string;
  number: number;
  type: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  gitRefVersion: string | null;
  gitRefFile: string | null;
  gitRefLine: number | null;
}

export interface CiProjectDomain {
  id: string;
  key: string;
  deletedAt: Date | null;
  ciWebhookToken: string | null;
}
