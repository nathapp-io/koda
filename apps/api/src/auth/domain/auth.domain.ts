export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');

export interface UserDomain {
  id: string;
  email: string;
  name: string;
  role: string;
  passwordHash: string;
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDomain {
  id: string;
  slug: string;
  status: string;
  apiKeyHash: string;
}
