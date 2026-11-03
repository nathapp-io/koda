import { MemoryKind, MemoryScope } from '../common/enums';

/** Permissions P1 US-008: the two tables `MemoryItem.ownerId` may name. */
export type MemoryOwnerType = 'USER' | 'AGENT';

export interface MemoryQuery {
  projectId: string;
  kind?: MemoryKind;
  subject?: string;
  predicate?: string;
  activeKey?: string;
  sourceType?: string;
  sourceId?: string;
  status?: string;
}

export interface ProjectMemoryQuery {
  projectId: string;
  kind?: MemoryKind;
  subject?: string;
  /** Case-insensitive substring of `subject`, `predicate` or `object` (S5b US-004). */
  text?: string;
  status?: string;
  orderBy?: 'confidence' | 'updatedAt' | 'createdAt';
}

export interface MemoryItemInput {
  /** US-004: null exactly for a user-scoped row, whose owner is the principal that wrote it. */
  projectId: string | null;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object?: string;
  /** US-001: the index line of a `NOTE`; a triple kind carries none. */
  description?: string;
  activeKey?: string | null;
  ownerId?: string;
  /**
   * Permissions P1 US-008: which table `ownerId` names. `null` (and absent) means a system writer or an
   * owner that is not a `User`/`Agent` row, and only an any-row `memory.update` may supersede it.
   */
  ownerType?: MemoryOwnerType | null;
  /**
   * US-004: whose memory the row is. Absent is `project` — a row of `projectId`, keyed on
   * `(projectId, activeKey)`. `user` is the caller's own note: stored with a null `projectId` and an
   * `ownerKey` the repository derives from `ownerType`/`ownerId`, keyed on `(ownerKey, activeKey)`.
   */
  scope?: MemoryScope;
  sourceType?: string;
  sourceId?: string;
  status?: string;
  confidence?: number;
  ttlAt?: Date | null;
  supersededBy?: string | null;
  deletedAt?: Date | null;
}

export interface MemoryItem {
  id: string;
  /** US-004: null exactly for a user-scoped item. */
  projectId: string | null;
  kind: string;
  subject: string;
  predicate: string;
  object?: string;
  /** US-001: the index line of a `NOTE`; absent on every triple kind. */
  description?: string;
  activeKey?: string;
  ownerId?: string;
  /** Permissions P1 US-008: which table `ownerId` names; null for a system item or an unknown owner. */
  ownerType?: MemoryOwnerType | null;
  /** US-004: `project` for a row of a project, `user` for a principal's own note. */
  scope: MemoryScope;
  /** US-004: `<ownerType>:<ownerId>` on a user row; absent on every project row. */
  ownerKey?: string;
  sourceType?: string;
  sourceId?: string;
  status: string;
  confidence: number;
  ttlAt?: Date;
  supersededBy?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}
