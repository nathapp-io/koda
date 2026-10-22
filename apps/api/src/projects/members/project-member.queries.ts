import type { PrismaClient } from '../../generated/prisma/client';
import { localProjectRole } from '../../permissions/legacy-membership.queries';
import { ROLE_KEY_FOR_LEGACY_ROLE } from '../../permissions/legacy-project-roles';
import type { MemberBinding, MemberPrincipalType, ProjectMemberRecord } from './domain/project-member.domain';

/**
 * Permissions P1 web US-003: the one place that reads a project member's role chips and its record,
 * from the project's `RoleBinding` rows unioned with the legacy `ProjectMember` / `AgentProject` rows.
 *
 * Every function takes the Prisma client as its first argument (like `legacy-membership.queries.ts`),
 * so a caller inside `txManager.run` passes `this.prisma.client` and the reads join that transaction.
 * This is persistence-mapping code (`.nax/rules/api-data.md`): it may import the generated client type,
 * and only repositories call it. `permissions-p1-cleanup` deletes the legacy half with the rows it
 * reads.
 *
 * Chips are: the principal's bindings **in this project** (`projectId` equal — an all-projects binding
 * is not listed), oldest first; then one entry with a null `id` when the principal's legacy row stands
 * for a role key it holds no binding of. A legacy row for a key it does bind adds nothing: the binding
 * is the real, editable source.
 */

/** Most rows one read takes (`.nax/rules/api-data.md`: every `findMany` takes `take`). */
const BINDING_READ_CAP = 5000;

/**
 * The system role key a stored `ProjectMember.role` is read as. A `Map`, not a record: the stored role
 * is database content, and `ROLE_KEY_FOR_LEGACY_ROLE['constructor']` would answer a function. Every
 * other stored role (`AGENT`, `MEMBER`, a hand-edited value) is read as the viewer role.
 */
const ROLE_KEY_BY_LEGACY_ROLE: ReadonlyMap<string, string> = new Map<string, string>(
  Object.entries(ROLE_KEY_FOR_LEGACY_ROLE),
);
const VIEWER_ROLE_KEY = ROLE_KEY_FOR_LEGACY_ROLE.VIEWER;

/** The principals one read asks about, split by type because the legacy rows live in two tables. */
export interface BindingOwners {
  userIds?: readonly string[];
  agentIds?: readonly string[];
}

/** The key `readMemberBindings` answers a principal under. */
export function memberKey(type: MemberPrincipalType, id: string): string {
  return `${type}:${id}`;
}

/**
 * The bindings of the named principals in `projectId`, keyed by `memberKey`, oldest first. A principal
 * with no binding and no legacy row maps to an empty list, so a caller never has to test for absence.
 */
export async function readMemberBindings(
  db: PrismaClient,
  projectId: string,
  owners: BindingOwners,
): Promise<Map<string, MemberBinding[]>> {
  const userIds = owners.userIds ?? [];
  const agentIds = owners.agentIds ?? [];
  const bindings = new Map<string, MemberBinding[]>();
  for (const id of userIds) bindings.set(memberKey('USER', id), []);
  for (const id of agentIds) bindings.set(memberKey('AGENT', id), []);
  if (userIds.length === 0 && agentIds.length === 0) return bindings;

  const [bindingRows, legacyUserRows, legacyAgentRows] = await Promise.all([
    db.roleBinding.findMany({
      where: {
        projectId,
        OR: [
          ...(userIds.length > 0 ? [{ principalType: 'USER', principalId: { in: [...userIds] } }] : []),
          ...(agentIds.length > 0 ? [{ principalType: 'AGENT', principalId: { in: [...agentIds] } }] : []),
        ],
      },
      select: {
        id: true,
        principalType: true,
        principalId: true,
        role: { select: { key: true, name: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: BINDING_READ_CAP,
    }),
    userIds.length === 0
      ? []
      : db.projectMember.findMany({
        where: { projectId, userId: { in: [...userIds] } },
        select: { userId: true, role: true },
        take: userIds.length,
      }),
    agentIds.length === 0
      ? []
      : db.agentProject.findMany({
        where: { projectId, agentId: { in: [...agentIds] } },
        select: { agentId: true },
        take: agentIds.length,
      }),
  ]);

  for (const row of bindingRows) {
    const key = memberKey(row.principalType as MemberPrincipalType, row.principalId);
    const list = bindings.get(key);
    if (list) list.push({ id: row.id, roleKey: row.role.key, roleName: row.role.name });
  }

  // The legacy entries, in one read: the role name of each key a legacy row stands for.
  const legacyEntries: Array<{ key: string; roleKey: string }> = [
    ...legacyUserRows.map((row) => ({
      key: memberKey('USER', row.userId),
      roleKey: ROLE_KEY_BY_LEGACY_ROLE.get(row.role) ?? VIEWER_ROLE_KEY,
    })),
    // A roster row carries no role column: it grants project reach, which the legacy vocabulary calls VIEWER.
    ...legacyAgentRows.map((row) => ({ key: memberKey('AGENT', row.agentId), roleKey: VIEWER_ROLE_KEY })),
  ];
  if (legacyEntries.length === 0) return bindings;

  const names = await readRoleNames(db, legacyEntries.map((entry) => entry.roleKey));
  for (const entry of legacyEntries) {
    const list = bindings.get(entry.key);
    if (!list) continue;
    if (list.some((binding) => binding.roleKey === entry.roleKey)) continue;
    list.push({ id: null, roleKey: entry.roleKey, roleName: names.get(entry.roleKey) ?? entry.roleKey });
  }
  return bindings;
}

/**
 * The name of each named role key. A key with no `Role` row (an unseeded or deleted role) is absent
 * from the map: the caller falls back to the key, so a chip is never blank.
 */
async function readRoleNames(db: PrismaClient, roleKeys: readonly string[]): Promise<Map<string, string>> {
  const rows = await db.role.findMany({
    where: { key: { in: [...new Set(roleKeys)] } },
    select: { key: true, name: true },
    take: roleKeys.length,
  });
  return new Map(rows.map((row) => [row.key, row.name]));
}

/**
 * One member's record — the single-record shape `POST /members`, `PATCH /members/:userId` and an
 * invite's `ADDED` member return. Null when the principal has no source in the project at all (a
 * `ProjectMember`/`AgentProject` row or a binding there).
 *
 * Not built on `listProjectMemberships`: that listing is capped and project-wide, and a single-record
 * read after a write must not depend on it.
 */
export async function readMemberRecord(
  db: PrismaClient,
  projectId: string,
  principal: { type: MemberPrincipalType; id: string },
): Promise<ProjectMemberRecord | null> {
  const role = await localProjectRole(db, principal, projectId);
  if (role === null) return null;

  const owners: BindingOwners = principal.type === 'USER' ? { userIds: [principal.id] } : { agentIds: [principal.id] };
  const [account, legacySince, bindingSince, bindings] = await Promise.all([
    principal.type === 'USER'
      ? db.user.findUnique({
        where: { id: principal.id },
        select: { id: true, email: true, name: true, disabled: true },
      })
      : db.agent.findUnique({ where: { id: principal.id }, select: { id: true, name: true, slug: true } }),
    principal.type === 'USER'
      ? db.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: principal.id } },
        select: { joinedAt: true },
      })
      : db.agentProject.findUnique({
        where: { agentId_projectId: { agentId: principal.id, projectId } },
        select: { createdAt: true },
      }),
    db.roleBinding.aggregate({
      where: { principalType: principal.type, principalId: principal.id, projectId, role: { scope: 'PROJECT' } },
      _min: { createdAt: true },
    }),
    readMemberBindings(db, projectId, owners),
  ]);
  if (!account) return null;

  const legacyAt = principal.type === 'USER'
    ? (legacySince as { joinedAt: Date } | null)?.joinedAt
    : (legacySince as { createdAt: Date } | null)?.createdAt;
  const bindingAt = bindingSince._min.createdAt;
  const since = legacyAt && bindingAt
    ? new Date(Math.min(legacyAt.getTime(), bindingAt.getTime()))
    : legacyAt ?? bindingAt;
  if (!since) return null;

  const chips = bindings.get(memberKey(principal.type, principal.id)) ?? [];
  if (principal.type === 'USER') {
    const user = account as { id: string; email: string; name: string | null; disabled: boolean };
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      role,
      disabled: user.disabled,
      joinedAt: since,
      principalType: 'USER',
      principalId: user.id,
      agentSlug: null,
      bindings: chips,
    };
  }
  const agent = account as { id: string; name: string; slug: string };
  return {
    userId: null,
    email: null,
    name: agent.name,
    role,
    disabled: false,
    joinedAt: since,
    principalType: 'AGENT',
    principalId: agent.id,
    agentSlug: agent.slug,
    bindings: chips,
  };
}
