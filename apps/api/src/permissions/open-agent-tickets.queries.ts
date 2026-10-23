import type { PrismaClient } from '../generated/prisma/client';
import { TicketStatus } from '../common/enums';
import { KodaError } from '../common/koda-error';

/**
 * How many refs an open-ticket answer surfaces. The removal conflict names them, and the project's
 * agent roster lists them, so a ticket-picker is not flooded by an agent with hundreds of tickets.
 */
export const MAX_OPEN_TICKET_REFS = 10;

/**
 * The agent's open tickets in one project — `count` is the exact total, `refs` the oldest
 * {@link MAX_OPEN_TICKET_REFS} as `<Project.key>-<number>`. "Open" means not CLOSED/REJECTED and not
 * soft-deleted, the same rule the roster read uses.
 *
 * It lives in `permissions/` (and not in `agents/`) because the binding-removal guard reads it:
 * `permissions/` never imports from `agents/`. It takes the client first so a repository caller inside
 * `txManager.run` joins that transaction.
 *
 * The queries run one after another on purpose: the callers are inside a `txManager.run`, so `db` is a
 * single interactive transaction client, and issuing concurrent queries on one connection is not safe
 * on every driver (the pg adapter warns about exactly that). A project row that cannot be read is an
 * invariant failure — a ref without its project key would surface a malformed `<key>-<number>` to the
 * user, so refuse instead of degrading.
 */
export async function countOpenAgentTickets(
  db: PrismaClient,
  agentId: string,
  projectId: string,
): Promise<{ count: number; refs: string[] }> {
  const where = {
    projectId,
    assignedToAgentId: agentId,
    status: { notIn: [TicketStatus.CLOSED, TicketStatus.REJECTED] },
    deletedAt: null,
  };
  const count = await db.ticket.count({ where });
  const oldest = await db.ticket.findMany({
    where,
    select: { number: true },
    orderBy: [{ createdAt: 'asc' }, { number: 'asc' }],
    take: MAX_OPEN_TICKET_REFS,
  });
  if (oldest.length === 0) return { count, refs: [] };

  const project = await db.project.findUnique({ where: { id: projectId }, select: { key: true } });
  if (!project) {
    throw new KodaError(
      'PROJECT_NOT_FOUND',
      `project ${projectId} disappeared while counting open tickets for agent ${agentId}`,
    );
  }
  return { count, refs: oldest.map((ticket) => `${project.key}-${ticket.number}`) };
}
