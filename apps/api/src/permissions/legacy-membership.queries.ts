import { Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';
import { ActorRole } from '../common/enums';
import { ROLE_KEY_FOR_LEGACY_ROLE, legacyRoleForRoleKey, strongestProjectRole } from './legacy-project-roles';
import type { PrincipalRef, PrincipalType, ProjectMembership } from './permissions.types';

export type { ProjectMembership } from './permissions.types';

/**
 * Permissions P1b: the one place that answers "is this principal in this project, and with which
 * legacy role?" — from `RoleBinding` rows unioned with the legacy `ProjectMember` and `AgentProject`
 * rows that predate them.
 *
 * Every function takes the Prisma client as its first argument (like `lockProjectMembers` in
 * `common/utils/advisory-lock.ts`), so a caller inside `txManager.run` passes `this.prisma.client` and
 * the reads join that transaction. The file is persistence-mapping code (`.nax/rules/api-data.md`): it
 * may import the generated client type, and only repositories call it. `permissions-p1-cleanup`
 * deletes it together with the legacy rows it reads.
 *
 * Sources, per the feature spec:
 * - a **legacy row** of a principal in `P`: its `ProjectMember(P, userId)` row for a USER, or its
 *   `AgentProject(agentId, P)` row for an AGENT;
 * - a **project binding** of a principal in `P`: a `RoleBinding` with `projectId = P` whose role has
 *   scope `PROJECT`;
 * - a **global project binding**: the same with `projectId` null — it applies in every project;
 * - the **local sources** are the legacy row and the project bindings;
 * - the **access sources** are the local sources plus the global project bindings.
 *
 * A binding of a GLOBAL-scope role (`owner`, `admin`, `member`, `agent`, or a custom GLOBAL role) is
 * never a source. "Who belongs to this project" (the members and roster pages, the duplicate and
 * not-found checks, the last-admin count) reads **local** sources; "who may act in this project"
 * (route access, project lists, assignment, notifications, schedules, the domain writer) reads
 * **access** sources.
 *
 * Nothing is cached: every call reads the current rows, as the legacy reads did.
 */

/** Most rows one query of a listing reads (`.nax/rules/api-data.md`: every `findMany` takes `take`). */
export const MEMBERSHIP_READ_CAP = 5000;

const PROJECT_SCOPE = 'PROJECT';
/** A roster row carries no role: it grants project reach, which the legacy vocabulary calls `VIEWER`. */
const AGENT_ROSTER_ROLE = 'VIEWER';

const logger = new Logger('LegacyMembershipQueries');

/** A binding of the principal as the client returns it: the project, the dates and the role's key. */
interface BindingRow {
  projectId: string | null;
  createdAt: Date;
  grantedByType: string;
  grantedById: string;
  role: { key: string; scope: string };
}

/** One local source of a principal, before several of them are merged into a `ProjectMembership`. */
interface MembershipSource {
  principalId: string;
  role: string;
  since: Date;
  addedByUserId: string | null;
}

/**
 * `userProjectRole` over a user's access sources; `null` when it has none.
 *
 * A user with no `ProjectMember` row, no binding in this project and no global project binding has no
 * source here — as does a `projectId` that names no live project, which is why a global project
 * binding is checked against the project row before it counts.
 */
export async function userProjectRole(
  db: PrismaClient,
  userId: string,
  projectId: string,
): Promise<string | null> {
  return strongestProjectRole(await accessRoles(db, { type: 'USER', id: userId }, projectId, 'userProjectRole'));
}

/** `strongestProjectRole` over the principal's local sources in the project; `null` when it has none. */
export async function localProjectRole(
  db: PrismaClient,
  principal: PrincipalRef,
  projectId: string,
): Promise<string | null> {
  return strongestProjectRole(await localRoles(db, principal, projectId, 'localProjectRole'));
}

/** True when the agent has at least one access source in the project. */
export async function agentHasProjectAccess(
  db: PrismaClient,
  agentId: string,
  projectId: string,
): Promise<boolean> {
  const roles = await accessRoles(db, { type: 'AGENT', id: agentId }, projectId, 'agentHasProjectAccess');
  return roles.length > 0;
}

/**
 * The ids of the non-deleted projects the principal has an access source in, ascending. A principal
 * with a global project binding gets every non-deleted project.
 */
export async function accessibleProjectIds(db: PrismaClient, principal: PrincipalRef): Promise<string[]> {
  const context = principalContext(principal);
  const [legacyIds, bindings] = await Promise.all([
    legacyProjectIds(db, principal, 'accessibleProjectIds'),
    readBindings(db, principal, undefined, 'accessibleProjectIds', context),
  ]);
  const sources = bindings.filter((row) => row.role.scope === PROJECT_SCOPE);
  const candidateIds = new Set<string>(legacyIds);
  for (const source of sources) if (source.projectId !== null) candidateIds.add(source.projectId);
  const everywhere = sources.some((source) => source.projectId === null);

  const projects = cap(
    await db.project.findMany({
      where: everywhere ? { deletedAt: null } : { deletedAt: null, id: { in: [...candidateIds] } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: MEMBERSHIP_READ_CAP,
    }),
    'accessibleProjectIds',
    context,
  );
  return projects.map((project) => project.id);
}

/**
 * The ids of the principals of `type` with an access source in the project, ascending and distinct.
 * Disabled users are included: callers that exclude them filter on `disabled` themselves.
 */
export async function principalIdsWithAccess(
  db: PrismaClient,
  projectId: string,
  type: PrincipalType,
): Promise<string[]> {
  const [legacyIds, localIds, globalIds] = await Promise.all([
    legacyPrincipalIds(db, projectId, type, 'principalIdsWithAccess'),
    bindingPrincipalIds(db, type, projectId, 'principalIdsWithAccess', projectId),
    bindingPrincipalIds(db, type, null, 'principalIdsWithAccess', projectId),
  ]);

  const ids = new Set<string>([...legacyIds, ...localIds]);
  if (globalIds.length > 0 && (await projectIsLive(db, projectId))) {
    for (const id of globalIds) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * One entry per principal of `type` with a **local** source in the project, ordered by `since`
 * ascending and then `principalId` ascending. The role is the strongest of its sources, so a binding
 * that outranks the legacy row does not hide it.
 */
export async function listProjectMemberships(
  db: PrismaClient,
  projectId: string,
  type: PrincipalType,
): Promise<ProjectMembership[]> {
  const [legacy, bindings] = await Promise.all([
    legacyMembershipSources(db, projectId, type, 'listProjectMemberships'),
    projectBindingMembershipSources(db, projectId, type, 'listProjectMemberships'),
  ]);
  return mergeMemberships([...legacy, ...bindings]);
}

/**
 * The number of distinct non-disabled users whose **local** sources include role `ADMIN`: a legacy
 * `ADMIN` row or a `project-admin` binding in the project.
 */
export async function countActiveProjectAdmins(db: PrismaClient, projectId: string): Promise<number> {
  const [legacyRows, bindingRows] = await Promise.all([
    cap(
      await db.projectMember.findMany({
        where: { projectId, role: ActorRole.ADMIN },
        select: { userId: true },
        take: MEMBERSHIP_READ_CAP,
      }),
      'countActiveProjectAdmins',
      projectId,
    ),
    cap(
      await db.roleBinding.findMany({
        where: {
          principalType: 'USER',
          projectId,
          role: { key: ROLE_KEY_FOR_LEGACY_ROLE.ADMIN, scope: PROJECT_SCOPE },
        },
        select: { principalId: true },
        take: MEMBERSHIP_READ_CAP,
      }),
      'countActiveProjectAdmins',
      projectId,
    ),
  ]);

  const adminIds = new Set<string>([
    ...legacyRows.map((row) => row.userId),
    ...bindingRows.map((row) => row.principalId),
  ]);
  if (adminIds.size === 0) return 0;
  return db.user.count({ where: { id: { in: [...adminIds] }, disabled: false } });
}

/** The legacy role strings of the principal's **access** sources, in no particular order. */
async function accessRoles(
  db: PrismaClient,
  principal: PrincipalRef,
  projectId: string,
  fnName: string,
): Promise<string[]> {
  const context = projectId || principalContext(principal);
  const [legacyRole, bindings] = await Promise.all([
    legacyRowRole(db, principal, projectId),
    readBindings(db, principal, [projectId, null], fnName, context),
  ]);

  const roles: string[] = [];
  if (legacyRole !== null) roles.push(legacyRole);
  roles.push(...bindingRoles(bindings, projectId));

  const globalRoles = bindingRoles(bindings, null);
  if (globalRoles.length > 0 && (await projectIsLive(db, projectId))) roles.push(...globalRoles);
  return roles;
}

/** The legacy role strings of the principal's **local** sources. */
async function localRoles(
  db: PrismaClient,
  principal: PrincipalRef,
  projectId: string,
  fnName: string,
): Promise<string[]> {
  const [legacyRole, bindings] = await Promise.all([
    legacyRowRole(db, principal, projectId),
    readBindings(db, principal, [projectId], fnName, projectId),
  ]);
  return [...(legacyRole === null ? [] : [legacyRole]), ...bindingRoles(bindings, projectId)];
}

/** The legacy role a binding of `projectId` (`null` = the global project bindings) contributes. */
function bindingRoles(bindings: readonly BindingRow[], projectId: string | null): string[] {
  return bindings
    .filter((row) => row.role.scope === PROJECT_SCOPE && row.projectId === projectId)
    .map((row) => legacyRoleForRoleKey(row.role.key));
}

/** The principal's legacy row role in the project: `ProjectMember.role`, or `VIEWER` for a roster row. */
async function legacyRowRole(
  db: PrismaClient,
  principal: PrincipalRef,
  projectId: string,
): Promise<string | null> {
  if (principal.type === 'USER') {
    const row = await db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: principal.id } },
      select: { role: true },
    });
    return row?.role ?? null;
  }
  const row = await db.agentProject.findUnique({
    where: { agentId_projectId: { agentId: principal.id, projectId } },
    select: { agentId: true },
  });
  return row === null ? null : AGENT_ROSTER_ROLE;
}

/** The projectIds the principal's legacy rows name. */
async function legacyProjectIds(
  db: PrismaClient,
  principal: PrincipalRef,
  fnName: string,
): Promise<string[]> {
  const context = principalContext(principal);
  if (principal.type === 'USER') {
    const rows = cap(
      await db.projectMember.findMany({
        where: { userId: principal.id },
        select: { projectId: true },
        take: MEMBERSHIP_READ_CAP,
      }),
      fnName,
      context,
    );
    return rows.map((row) => row.projectId);
  }
  const rows = cap(
    await db.agentProject.findMany({
      where: { agentId: principal.id },
      select: { projectId: true },
      take: MEMBERSHIP_READ_CAP,
    }),
    fnName,
    context,
  );
  return rows.map((row) => row.projectId);
}

/** The ids of the principals whose legacy row puts them in the project. */
async function legacyPrincipalIds(
  db: PrismaClient,
  projectId: string,
  type: PrincipalType,
  fnName: string,
): Promise<string[]> {
  if (type === 'USER') {
    const rows = cap(
      await db.projectMember.findMany({
        where: { projectId },
        select: { userId: true },
        take: MEMBERSHIP_READ_CAP,
      }),
      fnName,
      projectId,
    );
    return rows.map((row) => row.userId);
  }
  const rows = cap(
    await db.agentProject.findMany({
      where: { projectId },
      select: { agentId: true },
      take: MEMBERSHIP_READ_CAP,
    }),
    fnName,
    projectId,
  );
  return rows.map((row) => row.agentId);
}

/** The principal ids of the PROJECT-scope bindings of `type` with that `projectId` (`null` = global). */
async function bindingPrincipalIds(
  db: PrismaClient,
  type: PrincipalType,
  projectId: string | null,
  fnName: string,
  context: string,
): Promise<string[]> {
  const rows = cap(
    await db.roleBinding.findMany({
      where: { principalType: type, projectId, role: { scope: PROJECT_SCOPE } },
      select: { principalId: true },
      take: MEMBERSHIP_READ_CAP,
    }),
    fnName,
    context,
  );
  return rows.map((row) => row.principalId);
}

/** The principal's local sources in the project, as `ProjectMembership` inputs. */
async function legacyMembershipSources(
  db: PrismaClient,
  projectId: string,
  type: PrincipalType,
  fnName: string,
): Promise<MembershipSource[]> {
  if (type === 'USER') {
    const rows = cap(
      await db.projectMember.findMany({
        where: { projectId },
        select: { userId: true, role: true, joinedAt: true },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        take: MEMBERSHIP_READ_CAP,
      }),
      fnName,
      projectId,
    );
    return rows.map((row) => ({
      principalId: row.userId,
      role: row.role,
      since: row.joinedAt,
      addedByUserId: null,
    }));
  }
  const rows = cap(
    await db.agentProject.findMany({
      where: { projectId },
      select: { agentId: true, addedById: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { agentId: 'asc' }],
      take: MEMBERSHIP_READ_CAP,
    }),
    fnName,
    projectId,
  );
  return rows.map((row) => ({
    principalId: row.agentId,
    role: AGENT_ROSTER_ROLE,
    since: row.createdAt,
    addedByUserId: row.addedById,
  }));
}

/** The project bindings in the project, as `ProjectMembership` inputs. */
async function projectBindingMembershipSources(
  db: PrismaClient,
  projectId: string,
  type: PrincipalType,
  fnName: string,
): Promise<MembershipSource[]> {
  const rows = cap(
    await db.roleBinding.findMany({
      where: { principalType: type, projectId, role: { scope: PROJECT_SCOPE } },
      select: {
        principalId: true,
        createdAt: true,
        grantedByType: true,
        grantedById: true,
        role: { select: { key: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MEMBERSHIP_READ_CAP,
    }),
    fnName,
    projectId,
  );
  return rows.map((row) => ({
    principalId: row.principalId,
    role: legacyRoleForRoleKey(row.role.key),
    since: row.createdAt,
    addedByUserId: row.grantedByType === 'USER' ? row.grantedById : null,
  }));
}

/**
 * The principal's bindings, optionally restricted to those whose `projectId` is one of `projectIds`
 * (`undefined` reads all of them). Bindings of GLOBAL-scope roles are read like the rest and dropped
 * by the caller, which is what keeps "a GLOBAL role is never a source" in one place.
 */
async function readBindings(
  db: PrismaClient,
  principal: PrincipalRef,
  projectIds: readonly (string | null)[] | undefined,
  fnName: string,
  context: string,
): Promise<BindingRow[]> {
  const rows = await db.roleBinding.findMany({
    where: {
      principalType: principal.type,
      principalId: principal.id,
      ...(projectIds === undefined ? {} : { OR: projectIds.map((projectId) => ({ projectId })) }),
    },
    select: {
      projectId: true,
      createdAt: true,
      grantedByType: true,
      grantedById: true,
      role: { select: { key: true, scope: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MEMBERSHIP_READ_CAP,
  });
  return cap(rows, fnName, context);
}

/**
 * A global project binding applies in every project — but only in a project that exists and is not
 * soft-deleted, as `accessibleProjectIds` answers them. A project id that names no live row therefore
 * contributes no source, like every other unknown id.
 */
async function projectIsLive(db: PrismaClient, projectId: string): Promise<boolean> {
  return (await db.project.count({ where: { id: projectId, deletedAt: null } })) > 0;
}

/**
 * One entry per principal: the strongest of its roles, and the date and granter of its earliest
 * source. Sources arrive legacy row first, then bindings by `createdAt`, and the earliest one wins
 * ties to that order.
 */
function mergeMemberships(sources: readonly MembershipSource[]): ProjectMembership[] {
  const byPrincipal = new Map<string, MembershipSource[]>();
  for (const source of sources) {
    const existing = byPrincipal.get(source.principalId);
    if (existing) existing.push(source);
    else byPrincipal.set(source.principalId, [source]);
  }

  const memberships: ProjectMembership[] = [];
  for (const [principalId, list] of byPrincipal) {
    let earliest = list[0] as MembershipSource;
    for (const source of list) if (source.since.getTime() < earliest.since.getTime()) earliest = source;
    const role = strongestProjectRole(list.map((source) => source.role));
    if (role !== null) {
      memberships.push({ principalId, role, since: earliest.since, addedByUserId: earliest.addedByUserId });
    }
  }
  return memberships.sort(
    (left, right) =>
      left.since.getTime() - right.since.getTime() ||
      (left.principalId < right.principalId ? -1 : left.principalId > right.principalId ? 1 : 0),
  );
}

/** The warning of a listing that read its cap: it says which function and which project or principal. */
function cap<T>(rows: T[], fnName: string, context: string): T[] {
  if (rows.length >= MEMBERSHIP_READ_CAP) {
    logger.warn(`${fnName} read its ${MEMBERSHIP_READ_CAP}-row cap for ${context} and answered the first page`);
  }
  return rows;
}

function principalContext(principal: PrincipalRef): string {
  return `${principal.type}:${principal.id}`;
}
