export const WEBHOOK_REPOSITORY = Symbol('WEBHOOK_REPOSITORY');

export interface WebhookDomain {
  id: string;
  projectId: string;
  url: string;
  secret: string;
  events: string;
  active: boolean;
  createdAt: Date;
}

export interface WebhookListItem {
  id: string;
  projectId: string;
  url: string;
  events: string;
  createdAt: Date;
}

export interface WebhookProjectRef {
  id: string;
  deletedAt: Date | null;
}
