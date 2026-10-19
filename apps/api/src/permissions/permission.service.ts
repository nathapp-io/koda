import { Inject, Injectable, Logger } from '@nestjs/common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { findCatalogEntry } from './catalog';
import { expandEntries } from './entry-matcher';
import { PermissionCache } from './permission-cache';
import { ROLE_BINDING_REPOSITORY, ROLE_REPOSITORY } from './permissions.tokens';
import type {
  BindingWithRole,
  PermissionDecision,
  PrincipalRef,
  RoleDomain,
} from './permissions.types';
import type { PrismaRoleBindingRepository } from './prisma-role-binding.repository';
import type { PrismaRoleRepository } from './prisma-role.repository';

const OWN_SUFFIX = '.own';
const APPROVAL_DECIDE = 'approval.decide';
const APPROVAL_DECIDE_NARROWED_PREFIX = 'approval.decide@';
const GLOBAL_ADMIN_ROLE_KEYS: readonly string[] = ['owner', 'admin'];
/** The baseline role of a principal that has no GLOBAL binding: every principal starts with it. */
const BASELINE_ROLE_KEYS: Readonly<Record<PrincipalRef['type'], string>> = { USER: 'member', AGENT: 'agent' };

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
 * Effective keys are the union of three sources: the principal's `RoleBinding` rows, the legacy rows
 * that stand in for bindings (`ProjectMember`, `AgentProject`, `AgentRoleEntry`), and — for a
 * principal with no global-scope binding — its baseline `member`/`agent` role. The result is cached
 * per principal and scope under the `permissions` tag; every binding write and every legacy role
 * change invalidates it (`MembershipService`). Global Owners and Admins, and legacy
 * `User.role = 'ADMIN'` users, also hold every project key in every project.
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: PrismaRoleRepository,
    @Inject(ROLE_BINDING_REPOSITORY) private readonly bindings: PrismaRoleBindingRepository,
    private readonly cache: PermissionCache,
    @Inject(AUTH_CFG) private readonly authConfig: IAuthConfig,
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

  private async computeKeys(principal: PrincipalRef, projectId: string | null): Promise<Set<string>> {
    const rows = await this.bindings.findEffectiveBindings(principal, projectId);
    const keys = new Set<string>();
    let globalAdmin = false;
    let hasGlobalRoleBinding = false;

    for (const row of rows) {
      if (!appliesIn(row, projectId)) continue;
      this.addEntries(keys, row.roleKey, row.roleScope, row.rolePermissions);
      if (isGlobalAdminBinding(row)) globalAdmin = true;
      if (row.binding.projectId === null && row.roleScope === 'GLOBAL') hasGlobalRoleBinding = true;
    }

    // The legacy rows are virtual bindings: a `ProjectMember`/`AgentProject`/`AgentRoleEntry` row
    // grants exactly what the system role it maps to grants, so a principal that predates the
    // bindings keeps the permissions it had. A key with no role row (an unseeded role) adds nothing.
    const legacyKeys = await this.bindings.findLegacyRoleKeys(
      principal,
      projectId,
      this.authConfig.agentProjectScoping !== false,
    );
    await this.addRoleKeys(keys, legacyKeys);

    // The baseline: a principal with no global-scope binding starts with the `member`/`agent` role.
    // Principals created before the bindings existed have no baseline binding, and test fixtures
    // write users and agents directly, so the role is added rather than read from a binding.
    if (!hasGlobalRoleBinding) await this.addRoleKeys(keys, [BASELINE_ROLE_KEYS[principal.type]]);

    if (principal.type === 'USER' && (await this.isLegacyAdmin(principal.id))) {
      globalAdmin = true;
      const admin = await this.roles.findOne({ key: 'admin' });
      if (admin) this.addEntries(keys, admin.key, admin.scope, admin.permissions);
    }

    // A global Owner or Admin can do everything inside any project.
    if (globalAdmin) for (const key of expandEntries(['*'], 'PROJECT')) keys.add(key);
    return keys;
  }

  /** Adds the entries of each role key that has a role row; an unknown key adds nothing. */
  private async addRoleKeys(target: Set<string>, roleKeys: readonly string[]): Promise<void> {
    if (roleKeys.length === 0) return;
    const roles = await Promise.all(roleKeys.map((key) => this.roles.findOne({ key })));
    for (const role of roles) {
      if (role) this.addEntries(target, role.key, role.scope, role.permissions);
    }
  }

  private async isLegacyAdmin(userId: string): Promise<boolean> {
    return (await this.bindings.findUserState(userId))?.role === 'ADMIN';
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
