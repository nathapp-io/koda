export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

export interface IProjectRepository {
  findBySlug(slug: string): Promise<ProjectDomain | null>;
  findByKey(key: string): Promise<ProjectDomain | null>;
  findAll(): Promise<ProjectDomain[]>;
  createProject(data: CreateProjectData): Promise<ProjectDomain>;
  updateBySlug(slug: string, data: Partial<Omit<ProjectDomain, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ProjectDomain>;
  findAllIds(): Promise<{ id: string }[]>;
  findMembershipRole(projectId: string, userId: string): Promise<string | null>;
}

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
