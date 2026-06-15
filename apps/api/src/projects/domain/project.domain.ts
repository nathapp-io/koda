export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

export interface ProjectDomain {
  id: string;
  name: string;
  slug: string;
  key: string;
  description: string | null;
  gitRemoteUrl: string | null;
  autoIndexOnClose: boolean;
  autoAssign: string;
  graphifyEnabled: boolean;
  graphifyLastImportedAt: Date | null;
  ciWebhookToken: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectData {
  name: string;
  slug: string;
  key: string;
  description?: string | null;
  gitRemoteUrl?: string | null;
  autoIndexOnClose?: boolean;
  autoAssign?: string;
}
