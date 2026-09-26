import { MemoryKind } from '../common/enums';

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
