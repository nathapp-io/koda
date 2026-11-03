import { MemoryKind, MemoryScope } from '../common/enums';

/** Permissions P1 US-008: the two tables `MemoryItem.ownerId` may name. */
export type MemoryOwnerType = 'USER' | 'AGENT';

/**
 * US-005: the principal whose user-scoped notes a read includes, next to the project's own rows.
 *
 * The caller's identity, never a request field: the REST route builds it from `@Principal()` and the
 * assistant tools from `ctx.actor`. Without it a read answers project rows only.
 */
export interface MemoryItemOwner {
  ownerType: MemoryOwnerType;
  ownerId: string;
}

/**
 * US-005: which rows a project memory read answers.
 *
 * `all` (the default when an owner is passed) is the authorized union — the project's rows plus the owner's
 * user notes; `project` and `user` narrow it to one side. A read with no owner has no union to offer and is
 * answered `project` whatever is asked, so a user row is never reachable without an owner.
 */
export const MEMORY_READ_SCOPES = ['project', 'user', 'all'] as const;
export type MemoryReadScope = (typeof MEMORY_READ_SCOPES)[number];

/** US-005: the `ownerKey` a principal's user-scoped rows are stored with (`<ownerType>:<ownerId>`). */
export function memoryOwnerKey(owner: MemoryItemOwner): string {
  return `${owner.ownerType}:${owner.ownerId}`;
}

/**
 * memory-notes US-006: whose rows the incremental export answers.
 *
 * The authorized union the list route reads: every row of `projectId` plus the user rows keyed on the
 * caller's `ownerKey`. Every status, kind, TTL and soft-deleted row is included — the export exists so a
 * mirror can see a row leave, and a row that stopped being eligible is exactly the change a mirror must
 * replay.
 */
export interface MemoryExportScope {
  projectId: string;
  ownerKey: string;
}

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
  /**
   * US-005: the caller whose user-scoped notes the page includes. Absent keeps the read project-only, whatever
   * `scope` asks, so no user row is ever reachable without a caller to own it.
   */
  owner?: MemoryItemOwner;
  /** US-005: which rows to answer. Defaults to `all`, the authorized union, whenever an owner is passed. */
  scope?: MemoryReadScope;
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
