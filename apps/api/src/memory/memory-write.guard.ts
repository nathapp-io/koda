import { Injectable } from '@nestjs/common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { PermissionService } from '../permissions/permission.service';
import type { PrincipalRef } from '../permissions/permissions.types';
import type { MemoryItem } from './memory-item-repository';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';

/** `memory.update`: holding it (not only `memory.update.own`) is what lets a principal replace any row. */
const REPLACE_KEY = 'memory.update';

/**
 * Permissions P1 US-008: a memory write would supersede an active item the principal may not replace.
 * `itemId` is the item that stays, which is what the refusal names; REST answers it as 403 `permissions`,
 * a tool as a `forbidden` refusal.
 */
export class MemoryReplaceRefusedError extends Error {
  constructor(readonly itemId: string) {
    super(`memory:${itemId}`);
    this.name = 'MemoryReplaceRefusedError';
  }
}

/** The key of one memory item, as the active-key lookup takes it. */
export interface MemoryItemKey {
  kind: string;
  subject: string;
  predicate: string;
}

/**
 * The one place that decides whether a principal may supersede an active memory item.
 *
 * Superseding is a write on a row someone else may own, so the decision is `memory.update` *with that row
 * as the resource*: a Developer holds `memory.update.own` and replaces only its own items, a Project Admin
 * holds `memory.update` through `*` and replaces any, and a system item (no owner) is replaceable only by
 * an any-row holder. Every principal-driven write passes the check here: the two REST write routes, the
 * extract route (as a pre-check over every item before any is written) and both memory tools.
 *
 * `replaceCheck` is the form `PrismaMemoryItemRepository.upsert` runs as `beforeSupersede`, inside its own
 * serializable transaction, so a refusal rolls back instead of racing a concurrent write.
 */
@Injectable()
export class MemoryWriteGuard {
  constructor(
    private readonly permissions: PermissionService,
    private readonly memory: PrismaMemoryItemRepository,
  ) {}

  /** Whether the principal may supersede this active item: `memory.update` with the item's owner as the resource. */
  async mayReplace(principal: KodaPrincipal, projectId: string, existing: MemoryItem): Promise<boolean> {
    const decision = await this.permissions.can(principal, REPLACE_KEY, {
      projectId,
      resource: { createdBy: ownerRef(existing) },
    });
    return decision.allowed;
  }

  /** The check `upsert` runs inside its transaction: throws `MemoryReplaceRefusedError(existing.id)` when `mayReplace` answers false. */
  replaceCheck(principal: KodaPrincipal, projectId: string): (existing: MemoryItem) => Promise<void> {
    return async (existing: MemoryItem) => {
      if (!(await this.mayReplace(principal, projectId, existing))) {
        throw new MemoryReplaceRefusedError(existing.id);
      }
    };
  }

  /** For previews and pre-checks: reads `findActive` and throws when an active item exists that the principal may not replace. */
  async assertMayReplace(
    principal: KodaPrincipal,
    projectId: string,
    key: MemoryItemKey,
  ): Promise<void> {
    const active = await this.memory.findActive(projectId, key.kind, key.subject, key.predicate);
    if (active && !(await this.mayReplace(principal, projectId, active))) {
      throw new MemoryReplaceRefusedError(active.id);
    }
  }
}

/**
 * The item's owner as a permission resource: an owner only counts when both the kind and the id are set,
 * so a system item (`ownerType` null) and a half-known owner both answer null — which no `.own` grant can
 * match, so only an any-row holder may replace them.
 */
function ownerRef(existing: MemoryItem): PrincipalRef | null {
  const type = existing.ownerType;
  const id = existing.ownerId;
  return type && id ? { type, id } : null;
}

/** The owner kind a principal's own writes are stored with. A runner never reaches a memory write. */
export function ownerTypeFor(principal: KodaPrincipal): 'USER' | 'AGENT' {
  return principal.actorType === 'agent' ? 'AGENT' : 'USER';
}
