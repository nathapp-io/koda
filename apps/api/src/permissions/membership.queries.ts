import { Logger } from '@nestjs/common';
import { InternalAppException } from '@nathapp/nestjs-common';
import type { PrismaClient } from '../generated/prisma/client';
import { ROLE_KEY_FOR_LEGACY_ROLE, legacyRoleForRoleKey, strongestProjectRole } from './legacy-project-roles';
import type { PrincipalRef, PrincipalType, ProjectMembership } from './permissions.types';

export type { ProjectMembership } from './permissions.types';

/**
 * Binding-only project membership reads. Every function takes the transaction-aware Prisma client
 * first so repository callers inside `txManager.run` join that transaction.
 *
 * Local sources are project bindings of PROJECT-scope roles. Access sources also include projectId-null
 * PROJECT-scope bindings, but only in live projects. GLOBAL-scope roles are never membership sources.
 * Display roles retain the ADMIN / DEVELOPER / VIEWER vocabulary; authorization uses permission keys.
 */

/** Most rows one query of a listing reads (`.nax/rules/api-data.md`: every `findMany` takes `take`). */
export const MEMBERSHIP_READ_CAP = 5000;

/**
 * The safety bound of a read that pages until it is exhausted (`.nax/rules/api-data.md`: an unbounded
 * loop needs a hard iteration cap). Reaching it is a defect, not a size: the read fails loudly rather
 * than answering a partial list, so "every non-deleted project" is never quietly wrong (US-002 AC-11).
 */
const MAX_READ_PAGES = 10_000;

const PROJECT_SCOPE = 'PROJECT';
const logger = new Logger('MembershipQueries');

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
 * A user with no binding in this project and no global project binding has no
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
 *
 * "Every" is exhaustive: the projects are read in `MEMBERSHIP_READ_CAP`-sized keyset pages instead of
 * one capped `findMany`, so an installation with more projects than the cap does not silently lose
 * the ones past it in this answer, in the project lists or in the home list (US-002 AC-11).
 */
export async function accessibleProjectIds(db: PrismaClient, principal: PrincipalRef): Promise<string[]> {
  const context = principalContext(principal);
  const bindings = await readBindings(db, principal, undefined, 'accessibleProjectIds', context);
  const sources = bindings.filter((row) => row.role.scope === PROJECT_SCOPE);
  const candidateIds = new Set<string>();
  for (const source of sources) if (source.projectId !== null) candidateIds.add(source.projectId);
  const everywhere = sources.some((source) => source.projectId === null);

  return readAccessibleProjectIds(db, everywhere ? undefined : [...candidateIds], context, MAX_READ_PAGES);
}

/**
 * Every non-deleted project the id filter names (`undefined` = all of them), ascending.
 *
 * A single capped read would answer the first `MEMBERSHIP_READ_CAP` rows and stop; a principal with a
 * global project binding is entitled to all of them, so the read continues from the last id it saw
 * until a page comes back short. `maxPages` is the caller's bound on that loop, and reaching it while
 * pages are still full is a defect: the read fails instead of answering a partial list, because an
 * incomplete answer to "every non-deleted project" is silently wrong (US-002 AC-11).
 *
 * Exported as the paging seam US-002's unit spec drives: the production bound cannot be reached with
 * real rows (ten thousand full pages), so the spec passes it a small `maxPages` and a stub that
 * always answers a full page. `accessibleProjectIds` is the contract; production always passes
 * `MAX_READ_PAGES`.
 */
export async function readAccessibleProjectIds(
  db: PrismaClient,
  candidateIds: string[] | undefined,
  context: string,
  maxPages: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const rows = await db.project.findMany({
      where: { deletedAt: null, id: projectIdPageFilter(candidateIds, ids[ids.length - 1]) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: MEMBERSHIP_READ_CAP,
    });
    ids.push(...rows.map((row) => row.id));
    if (rows.length < MEMBERSHIP_READ_CAP) return ids;
    if (page === maxPages) {
      logger.error(
        `accessibleProjectIds reached its ${maxPages}-page bound for ${context} after ${ids.length} projects; refusing to answer a partial project list`,
      );
      throw new InternalAppException({ count: ids.length }, 'permissions');
    }
  }
  return ids;
}

/**
 * The `where.id` filter of one page: the candidate set (`undefined` = every project), after the last
 * id the previous page read. `{ in, gt }` is one filter — the set, narrowed to the ones past the
 * cursor — which is what makes the paging above a keyset scan rather than a re-read of page one.
 */
function projectIdPageFilter(
  candidateIds: string[] | undefined,
  cursor: string | undefined,
): { in?: string[]; gt?: string } {
  const afterCursor = cursor === undefined ? {} : { gt: cursor };
  return candidateIds === undefined ? afterCursor : { in: candidateIds, ...afterCursor };
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
  const [localIds, globalIds] = await Promise.all([
    bindingPrincipalIds(db, type, projectId, 'principalIdsWithAccess', projectId),
    bindingPrincipalIds(db, type, null, 'principalIdsWithAccess', projectId),
  ]);

  const ids = new Set<string>(localIds);
  if (globalIds.length > 0 && (await projectIsLive(db, projectId))) {
    for (const id of globalIds) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * One entry per principal of `type` with a **local** source in the project, ordered by `since`
 * ascending and then `principalId` ascending. The role is the strongest of its sources, so a binding
 * is mapped to the display role vocabulary.
 */
export async function listProjectMemberships(
  db: PrismaClient,
  projectId: string,
  type: PrincipalType,
): Promise<ProjectMembership[]> {
  const bindings = await projectBindingMembershipSources(db, projectId, type, 'listProjectMemberships');
  return mergeMemberships(bindings);
}

/**
 * The number of distinct non-disabled users with a `project-admin` binding in the project.
 */
export async function countActiveProjectAdmins(db: PrismaClient, projectId: string): Promise<number> {
  const bindingRows = cap(
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
  );
  const adminIds = new Set(bindingRows.map((row) => row.principalId));
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
  const bindings = await readBindings(db, principal, [projectId, null], fnName, context);
  const roles = bindingRoles(bindings, projectId);

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
  const bindings = await readBindings(db, principal, [projectId], fnName, projectId);
  return bindingRoles(bindings, projectId);
}

/** The legacy role a binding of `projectId` (`null` = the global project bindings) contributes. */
function bindingRoles(bindings: readonly BindingRow[], projectId: string | null): string[] {
  return bindings
    .filter((row) => row.role.scope === PROJECT_SCOPE && row.projectId === projectId)
    .map((row) => legacyRoleForRoleKey(row.role.key));
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
 * binding. Bindings arrive by `(createdAt, id)`, so ties retain that stable order.
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
