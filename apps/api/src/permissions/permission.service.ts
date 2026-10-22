import { Inject, Injectable, Logger } from '@nestjs/common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { findCatalogEntry } from './catalog';
import { expandEntries } from './entry-matcher';
import { PermissionCache } from './permission-cache';
import { ROLE_BINDING_REPOSITORY, ROLE_REPOSITORY } from './permissions.tokens';
import type {
  BindingWithRole,
  PermissionDecision,
  PrincipalRef,
  PrincipalType,
  RoleDomain,
} from './permissions.types';
import type { PrismaRoleBindingRepository } from './prisma-role-binding.repository';
import type { PrismaRoleRepository } from './prisma-role.repository';

const OWN_SUFFIX = '.own';
const APPROVAL_DECIDE = 'approval.decide';
const APPROVAL_DECIDE_NARROWED_PREFIX = 'approval.decide@';
const GLOBAL_ADMIN_ROLE_KEYS: readonly string[] = ['owner', 'admin'];
export type PermissionScope = { projectId: string } | 'global';

export interface PermissionContext {
  projectId?: string;
  resource?: { createdBy: PrincipalRef | null };
}

const allow = (reason: PermissionDecision['reason']): PermissionDecision => ({ allowed: true, reason });
const deny = (reason: PermissionDecision['reason']): PermissionDecision => ({ allowed: false, reason });

/**
 * Permissions P1a: the one place that decides whether a principal holds a permission key.
 *
 * Effective keys are the principal's bindings alone. The result is cached per principal and
 * scope under the `permissions` tag; binding writes invalidate it through `MembershipService`.
 * Global Owner and Admin bindings also hold every project key in every project.
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: PrismaRoleRepository,
    @Inject(ROLE_BINDING_REPOSITORY) private readonly bindings: PrismaRoleBindingRepository,
    private readonly cache: PermissionCache,
  ) {}

  async can(principal: KodaPrincipal, key: string, ctx: PermissionContext = {}): Promise<PermissionDecision> {
    if (principal.actorType === 'runner') return deny('non-role-key');

    const entry = findCatalogEntry(key);
    if (entry === undefined) return deny('unknown-key');
    if (entry.access === 'public') return allow('public');
    if (entry.access === 'implicit') return allow('implicit');
    if (entry.access !== 'role') return deny('non-role-key');
    if (!entry.principals.includes(principal.actorType)) return deny('principal-type');
    if (entry.scope === 'project' && !ctx.projectId) return deny('no-project');

    const ref: PrincipalRef = { type: principal.actorType === 'user' ? 'USER' : 'AGENT', id: principal.id };
    const scope: PermissionScope = ctx.projectId ? { projectId: ctx.projectId } : 'global';
    const held = await this.effectiveKeys(ref, scope);

    if (held.has(key) || (key === APPROVAL_DECIDE && holdsNarrowedDecide(held))) return allow('granted');
    if (held.has(`${key}${OWN_SUFFIX}`)) {
      const createdBy = ctx.resource?.createdBy;
      return createdBy && createdBy.type === ref.type && createdBy.id === ref.id
        ? allow('granted')
        : deny('not-owner');
    }
    return deny('not-granted');
  }

  async effectiveKeys(principal: PrincipalRef, scope: PermissionScope): Promise<ReadonlySet<string>> {
    const projectId = scope === 'global' ? null : scope.projectId;
    const parts = [principal.type, principal.id, projectId ?? 'global'];
    const keys = await this.cache.remember<string[]>(parts, async () => [
      ...(await this.computeKeys(principal, projectId)),
    ]);
    return new Set(keys);
  }

  /**
   * `{ all: true }` when the principal holds `key` globally; otherwise the accessible projects where
   * it holds `key`, ascending.
   *
   * The filtered listings (`GET /fleet/activity`, `GET /fleet/approval-counts`) use this to scope the
   * rows they return. A runner principal holds nothing. The candidates are the principal's role
   * bindings' project scopes, not every project.
   */
  async projectIdsWithKey(
    principal: KodaPrincipal,
    key: string,
  ): Promise<{ all: true } | { all: false; projectIds: string[] }> {
    if (principal.actorType === 'runner') return { all: false, projectIds: [] };

    const ref: PrincipalRef = { type: principal.actorType === 'user' ? 'USER' : 'AGENT', id: principal.id };
    if ((await this.effectiveKeys(ref, 'global')).has(key)) return { all: true };

    const candidates = await this.bindings.findAccessibleProjectIds(ref);
    const held = await Promise.all(
      candidates.map(async (projectId) => ((await this.effectiveKeys(ref, { projectId })).has(key) ? projectId : null)),
    );
    return { all: false, projectIds: held.filter((projectId): projectId is string => projectId !== null) };
  }

  /**
   * Ascending, distinct ids of principals holding `key` in the project. Candidates have an
   * applicable PROJECT binding or a null-project GLOBAL binding that can grant the key.
   * Every candidate is checked through effectiveKeys; read failures propagate without a partial list.
   */
  async principalIdsWithKey(type: PrincipalType, projectId: string, key: string): Promise<string[]> {
    const roles = await this.roles.findRolesByScope('GLOBAL');
    const globalRoleIds = roles.filter((role) => {
      if (GLOBAL_ADMIN_ROLE_KEYS.includes(role.key)) return true;
      try {
        return expandEntries(role.permissions, 'GLOBAL').has(key);
      } catch {
        // A hand-edited invalid role grants nothing; computeKeys owns its warning on evaluation.
        return false;
      }
    }).map((role) => role.id);
    const candidates = await this.bindings.findCandidatePrincipalIds(type, projectId, globalRoleIds);
    const held = await Promise.all(candidates.map(async (id) =>
      (await this.effectiveKeys({ type, id }, { projectId })).has(key) ? id : null,
    ));
    return held.filter((id): id is string => id !== null);
  }

  private async computeKeys(principal: PrincipalRef, projectId: string | null): Promise<Set<string>> {
    const rows = await this.bindings.findEffectiveBindings(principal, projectId);
    const keys = new Set<string>();
    let globalAdmin = false;

    for (const row of rows) {
      if (!appliesIn(row, projectId)) continue;
      this.addEntries(keys, row.roleKey, row.roleScope, row.rolePermissions);
      if (isGlobalAdminBinding(row)) globalAdmin = true;
    }

    // A global Owner or Admin can do everything inside any project.
    if (globalAdmin) for (const key of expandEntries(['*'], 'PROJECT')) keys.add(key);
    return keys;
  }

  /** A role row that no longer expands (hand-edited) grants nothing instead of failing every check. */
  private addEntries(target: Set<string>, roleKey: string, scope: RoleDomain['scope'], entries: string[]): void {
    try {
      for (const key of expandEntries(entries, scope)) target.add(key);
    } catch (error) {
      this.logger.warn(`role ${roleKey} has an invalid permission entry and grants nothing: ${String(error)}`);
    }
  }
}

function holdsNarrowedDecide(held: ReadonlySet<string>): boolean {
  for (const key of held) if (key.startsWith(APPROVAL_DECIDE_NARROWED_PREFIX)) return true;
  return false;
}

/** A GLOBAL role counts for its `projectId`-null bindings; a PROJECT role in its project or everywhere. */
function appliesIn(row: BindingWithRole, projectId: string | null): boolean {
  if (row.roleScope === 'GLOBAL') return row.binding.projectId === null;
  if (projectId === null) return false;
  return row.binding.projectId === null || row.binding.projectId === projectId;
}

function isGlobalAdminBinding(row: BindingWithRole): boolean {
  return row.binding.projectId === null && GLOBAL_ADMIN_ROLE_KEYS.includes(row.roleKey);
}
