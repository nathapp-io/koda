import type { PrismaClient } from '../../generated/prisma/client';
import { isUniqueViolation } from '../../common/utils/prisma-errors';
import { SystemRoleSeeder } from '../system-role.seeder';
import { SYSTEM_ROLES } from '../system-roles';
import type { PrincipalRef, RoleDomain, RoleRepository, RoleScope } from '../permissions.types';

/** The client the helpers write through: a PrismaClient, or `PrismaService.client`. */
export type FixtureDb = PrismaClient;

const roleDomain = (row: Awaited<ReturnType<FixtureDb['role']['findUniqueOrThrow']>>): RoleDomain => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  scope: row.scope as RoleScope,
  system: row.system,
  locked: row.locked,
  permissions: Array.isArray(row.permissions) ? row.permissions.filter((value): value is string => typeof value === 'string') : [],
});

/** Seeds the eleven system roles exactly as an API boot does (idempotent). */
export async function ensureSystemRoles(db: FixtureDb): Promise<void> {
  const roles = {
    findOne: async ({ key }: Partial<RoleDomain>) => {
      if (key === undefined) return null;
      const row = await db.role.findUnique({ where: { key } });
      return row ? roleDomain(row) : null;
    },
    createRole: async (input: Omit<RoleDomain, 'id'>) => roleDomain(await db.role.create({ data: input })),
    update: async (id: string, patch: Partial<RoleDomain>) => roleDomain(await db.role.update({ where: { id }, data: patch })),
  } as unknown as RoleRepository;
  await new SystemRoleSeeder(SYSTEM_ROLES, roles).onApplicationBootstrap();
}

/** Bind a principal to a seeded role, returning an existing identical binding when present. */
export async function grantRole(
  db: FixtureDb,
  principal: PrincipalRef,
  roleKey: string,
  projectId?: string | null,
): Promise<{ id: string }> {
  const scopeId = projectId ?? null;
  let role = await db.role.findUnique({ where: { key: roleKey } });
  if (!role) {
    await ensureSystemRoles(db);
    role = await db.role.findUnique({ where: { key: roleKey } });
  }
  if (!role) throw new Error(`no role ${roleKey}`);

  const where = { principalType: principal.type, principalId: principal.id, roleId: role.id, projectId: scopeId };
  const mirrorsAdmin = principal.type === 'USER' && scopeId === null && (roleKey === 'owner' || roleKey === 'admin');
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.roleBinding.findFirst({ where, select: { id: true } });
      if (existing) {
        if (mirrorsAdmin) await tx.user.update({ where: { id: principal.id }, data: { role: 'ADMIN' } });
        return { id: existing.id };
      }

      const binding = await tx.roleBinding.create({
        data: {
          ...where,
          grantedByType: 'SYSTEM',
          grantedById: 'test',
        },
        select: { id: true },
      });
      if (mirrorsAdmin) await tx.user.update({ where: { id: principal.id }, data: { role: 'ADMIN' } });
      return binding;
    });
  } catch (error) {
    if (!isUniqueViolation(error, 'principalId')) throw error;
    // A concurrent transaction inserted the same binding after our lookup. Its transaction also
    // commits the admin mirror; re-read outside our failed transaction to return its binding.
    const existing = await db.roleBinding.findFirst({ where, select: { id: true } });
    if (!existing) throw error;
    return { id: existing.id };
  }
}

/** Grants the baseline role production writes when creating a principal. */
export async function grantBaseline(db: FixtureDb, principal: PrincipalRef): Promise<{ id: string }> {
  return grantRole(db, principal, principal.type === 'USER' ? 'member' : 'agent');
}

/** Deletes every binding of a principal in a project, returning the deleted row count. */
export async function revokeProjectRoles(db: FixtureDb, principal: PrincipalRef, projectId: string): Promise<number> {
  const result = await db.roleBinding.deleteMany({ where: { principalType: principal.type, principalId: principal.id, projectId } });
  return result.count;
}

export interface FixtureGrantReport {
  legacyMemberships: number;
  agentRoleEntries: number;
  hasGlobalBinding: boolean;
  globalProjectRoleBindings: number;
}

/** Reports legacy grants and whether bindings meet the fixture baseline invariants. */
export async function fixtureGrantReport(db: FixtureDb, principal: PrincipalRef): Promise<FixtureGrantReport> {
  const base: FixtureGrantReport = { legacyMemberships: 0, agentRoleEntries: 0, hasGlobalBinding: false, globalProjectRoleBindings: 0 };
  if (principal.type === 'USER') {
    const user = await db.user.findUnique({ where: { id: principal.id }, select: { role: true } });
    if (!user) return base;
    const [memberships, bindings, adminBinding] = await Promise.all([
      db.projectMember.count({ where: { userId: principal.id } }),
      db.roleBinding.findMany({ where: { principalType: 'USER', principalId: principal.id }, include: { role: { select: { scope: true } } } }),
      db.roleBinding.count({ where: { principalType: 'USER', principalId: principal.id, projectId: null, role: { key: { in: ['owner', 'admin'] } } } }),
    ]);
    return {
      legacyMemberships: memberships + (user.role === 'ADMIN' && adminBinding === 0 ? 1 : 0),
      agentRoleEntries: 0,
      hasGlobalBinding: bindings.some(({ projectId }) => projectId === null),
      globalProjectRoleBindings: bindings.filter(({ projectId, role }) => projectId === null && role.scope === 'PROJECT').length,
    };
  }
  const agent = await db.agent.findUnique({ where: { id: principal.id }, select: { id: true } });
  if (!agent) return base;
  const [memberships, agentRoleEntries, bindings] = await Promise.all([
    db.agentProject.count({ where: { agentId: principal.id } }),
    db.agentRoleEntry.count({ where: { agentId: principal.id } }),
    db.roleBinding.findMany({ where: { principalType: 'AGENT', principalId: principal.id }, include: { role: { select: { scope: true } } } }),
  ]);
  return {
    legacyMemberships: memberships,
    agentRoleEntries,
    hasGlobalBinding: bindings.some(({ projectId }) => projectId === null),
    globalProjectRoleBindings: bindings.filter(({ projectId, role }) => projectId === null && role.scope === 'PROJECT').length,
  };
}

export interface FixtureExemptions {
  noBaseline?: readonly PrincipalRef[];
  globalProjectRoles?: readonly PrincipalRef[];
  agentRoleEntries?: readonly PrincipalRef[];
}

/** Ensures every fixture principal is binding-only, except for explicitly pinned invariants. */
export async function expectBindingOnlyFixtures(
  db: FixtureDb,
  principals: readonly PrincipalRef[],
  exempt: FixtureExemptions = {},
): Promise<void> {
  const samePrincipal = (left: PrincipalRef, right: PrincipalRef) => left.type === right.type && left.id === right.id;
  const failures: string[] = [];
  for (const principal of principals) {
    const report = await fixtureGrantReport(db, principal);
    const exemptFor = (list: readonly PrincipalRef[] | undefined) => list?.some((item) => samePrincipal(item, principal)) ?? false;
    const fields: string[] = [];
    if (report.legacyMemberships !== 0) fields.push('legacyMemberships');
    if (report.agentRoleEntries !== 0 && !exemptFor(exempt.agentRoleEntries)) fields.push('agentRoleEntries');
    if (!report.hasGlobalBinding && !exemptFor(exempt.noBaseline)) fields.push('hasGlobalBinding');
    if (report.globalProjectRoleBindings !== 0 && !exemptFor(exempt.globalProjectRoles)) fields.push('globalProjectRoleBindings');
    if (fields.length) failures.push(`${principal.id}: ${fields.join(', ')}`);
  }
  if (failures.length) throw new Error(`Binding-only fixture check failed: ${failures.join('; ')}`);
}

