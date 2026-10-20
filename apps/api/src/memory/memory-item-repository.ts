import { MemoryKind } from '../common/enums';

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
  projectId: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object?: string;
  activeKey?: string | null;
  ownerId?: string;
  /**
   * Permissions P1 US-008: which table `ownerId` names. `null` (and absent) means a system writer or an
   * owner that is not a `User`/`Agent` row, and only an any-row `memory.update` may supersede it.
   */
  ownerType?: MemoryOwnerType | null;
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
  projectId: string;
  kind: string;
  subject: string;
  predicate: string;
  object?: string;
  activeKey?: string;
  ownerId?: string;
  /** Permissions P1 US-008: which table `ownerId` names; null for a system item or an unknown owner. */
  ownerType?: MemoryOwnerType | null;
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
