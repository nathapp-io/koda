import { Logger } from '@nestjs/common';
import { InternalAppException } from '@nathapp/nestjs-common';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { localProjectRole } from '../../permissions/membership.queries';
import type { MemberBinding, MemberPrincipalType, ProjectMemberRecord } from './domain/project-member.domain';

/**
 * Reads a project member's role chips and record from project RoleBinding rows alone.
 * Repository callers pass their transaction-aware Prisma client as the first argument.
 * Chips contain the principal's bindings in this project, oldest first; all-projects bindings
 * are not local membership and are not listed.
 */

/** Most rows one page of a read takes (`.nax/rules/api-data.md`: every `findMany` takes `take`). */
const BINDING_READ_PAGE = 500;

/**
 * The safety bound of a read that pages until it is exhausted (`.nax/rules/api-data.md`: an unbounded loop
 * needs a hard iteration cap). Five hundred thousand bindings for one page of principals is a defect, not a
 * size, so reaching the bound fails instead of answering a partial set of chips: a member's roles must not
 * silently depend on how many rows were read.
 */
const MAX_BINDING_READ_PAGES = 1000;

const logger = new Logger('ProjectMemberQueries');

/** One `RoleBinding` row of a page's principals, with the role name a chip renders. */
interface BindingRow {
  id: string;
  principalType: string;
  principalId: string;
  createdAt: Date;
  role: { key: string; name: string };
}

/** The principals one read asks about, split by type. */
export interface BindingOwners {
  userIds?: readonly string[];
  agentIds?: readonly string[];
}

/** The key `readMemberBindings` answers a principal under. */
export function memberKey(type: MemberPrincipalType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Every `RoleBinding` row `where` selects, ordered by `(createdAt, id)`, in `BINDING_READ_PAGE`-sized keyset
 * pages. The pair is a total order (`id` is unique), so a page that ends on a timestamp boundary loses and
 * repeats nothing.
 *
 * Reaching `MAX_BINDING_READ_PAGES` is a defect: the read logs which project/principal set it was answering
 * and throws, because a partial chip list misrepresents what a member may do (`InternalAppException`, the
 * same refusal `readAccessibleProjectIds` uses for an unbounded project list).
 */
async function readBindingRows(
  db: PrismaClient,
  where: Prisma.RoleBindingWhereInput,
  context: string,
): Promise<BindingRow[]> {
  const rows: BindingRow[] = [];
  let cursor: { createdAt: Date; id: string } | undefined;

  for (let page = 1; page <= MAX_BINDING_READ_PAGES; page += 1) {
    const pageRows = await db.roleBinding.findMany({
      where: cursor === undefined
        ? where
        : {
          AND: [
            where,
            {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            },
          ],
        },
      select: {
        id: true,
        principalType: true,
        principalId: true,
        createdAt: true,
        role: { select: { key: true, name: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: BINDING_READ_PAGE,
    });
    rows.push(...pageRows);
    if (pageRows.length < BINDING_READ_PAGE) return rows;

    const last = pageRows[pageRows.length - 1] as BindingRow;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (page === MAX_BINDING_READ_PAGES) {
      logger.error(
        `readMemberBindings reached its ${MAX_BINDING_READ_PAGES}-page bound for ${context} after ${rows.length} bindings; refusing to answer a partial chip list`,
      );
      throw new InternalAppException({ count: rows.length }, 'permissions');
    }
  }
  return rows;
}

/**
 * The bindings of the named principals in `projectId`, keyed by `memberKey`, oldest first. A principal
 * with no binding maps to an empty list, so a caller never has to test for absence.
 *
 * The page's bindings are read to exhaustion, not up to one cap: a `size=100` page of 50 users and 50
 * agents holding a few dozen roles each is several thousand rows, and truncating them would change which
 * roles a member appears to hold depending on the page size. The read pages by `(createdAt, id)` — a total
 * order — and fails loudly if it ever reaches its safety bound instead of answering a partial page.
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

  const bindingRows = await readBindingRows(
    db,
    {
      projectId,
      OR: [
        ...(userIds.length > 0 ? [{ principalType: 'USER', principalId: { in: [...userIds] } }] : []),
        ...(agentIds.length > 0 ? [{ principalType: 'AGENT', principalId: { in: [...agentIds] } }] : []),
      ],
    },
    `${projectId}:${bindings.size}`,
  );

  for (const row of bindingRows) {
    const key = memberKey(row.principalType as MemberPrincipalType, row.principalId);
    const list = bindings.get(key);
    if (list) list.push({ id: row.id, roleKey: row.role.key, roleName: row.role.name });
  }

  return bindings;
}

/**
 * One member's record — the single-record shape `POST /members`, `PATCH /members/:userId` and an
 * invite's `ADDED` member return. Null when the principal has no project binding.
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
  const [account, bindingSince, bindings] = await Promise.all([
    principal.type === 'USER'
      ? db.user.findUnique({
        where: { id: principal.id },
        select: { id: true, email: true, name: true, disabled: true },
      })
      : db.agent.findUnique({ where: { id: principal.id }, select: { id: true, name: true, slug: true } }),
    db.roleBinding.aggregate({
      where: { principalType: principal.type, principalId: principal.id, projectId, role: { scope: 'PROJECT' } },
      _min: { createdAt: true },
    }),
    readMemberBindings(db, projectId, owners),
  ]);
  if (!account) return null;

  const since = bindingSince._min.createdAt;
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
