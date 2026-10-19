export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

export interface IProjectRepository {
  findBySlug(slug: string): Promise<ProjectDomain | null>;
  findByKey(key: string): Promise<ProjectDomain | null>;
  findAll(): Promise<ProjectDomain[]>;
  createProject(data: CreateProjectData): Promise<ProjectDomain>;
  updateBySlug(slug: string, data: Partial<Omit<ProjectDomain, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ProjectDomain>;
  findAllIds(): Promise<{ id: string }[]>;
  findMembershipRole(projectId: string, userId: string): Promise<string | null>;
  /** US-002: whether the agent has an access source in the project (roster row or binding). */
  isAgentOnRoster(projectId: string, agentId: string): Promise<boolean>;
  /** US-002: every non-deleted project the agent has an access source in, ascending by id. */
  findAllForAgent(agentId: string): Promise<ProjectDomain[]>;
}

export interface ProjectDomain {
  id: string;
  name: string;
  slug: string;
  key: string;
  description: string | null;
  /** S5b US-001: optional so existing project literals in tests stay valid. */
  brief?: string | null;
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
