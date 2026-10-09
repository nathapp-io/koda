export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

export interface IProjectRepository {
  findBySlug(slug: string): Promise<ProjectDomain | null>;
  findByKey(key: string): Promise<ProjectDomain | null>;
  findAll(): Promise<ProjectDomain[]>;
  createProject(data: CreateProjectData): Promise<ProjectDomain>;
  updateBySlug(slug: string, data: Partial<Omit<ProjectDomain, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ProjectDomain>;
  findAllIds(): Promise<{ id: string }[]>;
  findMembershipRole(projectId: string, userId: string): Promise<string | null>;
  /** S4c US-001: whether the agent holds an AgentProject roster row for the project. */
  isAgentOnRoster(projectId: string, agentId: string): Promise<boolean>;
  /** S4c US-001: every non-deleted project on the agent's roster, in findAll order. */
  findAllForAgent(agentId: string): Promise<ProjectDomain[]>;
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
