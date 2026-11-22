import type { PrismaClient } from '../../generated/prisma/client';

export type EventLabelClient = Pick<PrismaClient, 'user' | 'agent' | 'ticket'>;

export interface TicketLabel {
  ref: string;
  title: string;
}

/** Display names by principal id: a user's trimmed name, else the email local part; an agent's name. Never an email. */
export async function readPrincipalNames(
  client: EventLabelClient,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(ids.filter((id) => id.length > 0))];
  const names = new Map<string, string>();
  if (uniqueIds.length === 0) return names;

  const [users, agents] = await Promise.all([
    client.user.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, name: true, email: true },
    }),
    client.agent.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, name: true },
    }),
  ]);

  for (const user of users) {
    names.set(user.id, user.name?.trim() || user.email.split('@')[0]);
  }
  for (const agent of agents) {
    names.set(agent.id, agent.name);
  }

  return names;
}

/** `KEY-N` ref and title by ticket id. Soft-deleted tickets are included: an event about a deleted ticket still names it. */
export async function readTicketLabels(
  client: EventLabelClient,
  ids: readonly string[],
): Promise<Map<string, TicketLabel>> {
  const uniqueIds = [...new Set(ids.filter((id) => id.length > 0))];
  const labels = new Map<string, TicketLabel>();
  if (uniqueIds.length === 0) return labels;

  const tickets = await client.ticket.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, number: true, title: true, project: { select: { key: true } } },
  });

  for (const ticket of tickets) {
    labels.set(ticket.id, { ref: `${ticket.project.key}-${ticket.number}`, title: ticket.title });
  }

  return labels;
}
