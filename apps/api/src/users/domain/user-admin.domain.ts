export const GLOBAL_ROLES = ['MEMBER', 'ADMIN'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export interface UserAdminRecord {
  id: string;
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserListFilters {
  email?: string;
}

export interface UserAdminWrite {
  role?: GlobalRole;
  disabled?: boolean;
  /** Revoke outstanding tokens in the same UPDATE. */
  bumpTokenVersion: boolean;
}
