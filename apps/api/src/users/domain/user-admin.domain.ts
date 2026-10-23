export interface UserAdminRecord {
  id: string;
  email: string;
  name: string | null;
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserListFilters {
  email?: string;
}

export interface UserAdminWrite {
  disabled?: boolean;
  /** Revoke outstanding tokens in the same UPDATE. */
  bumpTokenVersion: boolean;
}
