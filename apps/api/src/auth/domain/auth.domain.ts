export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');

export interface UserDomain {
  id: string;
  email: string;
  name: string;
  role: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}
