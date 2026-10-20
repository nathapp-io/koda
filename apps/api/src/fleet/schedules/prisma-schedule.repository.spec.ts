import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { PrismaScheduleRepository } from './prisma-schedule.repository';
import { mayDispatch } from './schedule-access';

/**
 * Permissions P1d US-005 — `findOwnerAccess` answers the schedule owner's **existence** only, from the
 * owner's own table: a USER exists when its `User` row does and is disabled when `User.disabled`; an
 * AGENT exists when its `Agent` row does and is never disabled (a PAUSED agent keeps its schedules —
 * status is liveness, not access). The dispatch permission is the owner's effective keys, which this
 * read no longer computes: `mayDispatch(access, keys)` combines the two.
 *
 * The DB-backed form of the same behaviour lives in
 * `test/integration/permissions/enforce-fleet-schedules.integration.spec.ts` (the ticker's fire and an
 * enable over real rows). This spec pins the read path without a database: the stub answers one table
 * each, so a read that goes back to the legacy membership queries cannot pass.
 */

interface UserRow {
  id: string;
  disabled: boolean;
}

interface AgentRow {
  id: string;
  status: string;
}

/** The subset of the generated client `findOwnerAccess` reads, backed by plain rows. */
function stubClient(rows: { users: UserRow[]; agents: AgentRow[] }) {
  const userFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const user = rows.users.find((row) => row.id === args.where.id);
    return user ? { disabled: user.disabled, role: 'MEMBER' } : null;
  });
  const agentFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const agent = rows.agents.find((row) => row.id === args.where.id);
    return agent ? { id: agent.id, status: agent.status } : null;
  });

  return { user: { findUnique: userFindUnique }, agent: { findUnique: agentFindUnique } };
}

function repositoryFor(rows: { users?: UserRow[]; agents?: AgentRow[] }) {
  const client = stubClient({ users: rows.users ?? [], agents: rows.agents ?? [] });
  const prisma = { client: client as unknown as PrismaClient };
  return {
    repository: new PrismaScheduleRepository(prisma as unknown as PrismaService<PrismaClient>),
    client,
  };
}

/** A developer binding's keys, from the seeded `developer` role. */
const DEVELOPER_KEYS: ReadonlySet<string> = new Set(['fleet.schedule.read', 'fleet.schedule.update.own', 'fleet.job.dispatch']);
/** A viewer binding's keys: reads only, `fleet.job.dispatch` is not among them. */
const VIEWER_KEYS: ReadonlySet<string> = new Set(['fleet.schedule.read', 'fleet.job.read']);

describe('PrismaScheduleRepository — findOwnerAccess (US-005)', () => {
  it('answers a live USER owner as existing and enabled, reading the user table', async () => {
    const { repository, client } = repositoryFor({ users: [{ id: 'u1', disabled: false }] });

    await expect(repository.findOwnerAccess('p1', { type: 'USER', id: 'u1' })).resolves.toEqual({ exists: true, disabled: false });
    expect(client.user.findUnique).toHaveBeenCalled();
    expect(client.agent.findUnique).not.toHaveBeenCalled();
  });

  it('answers a disabled USER owner as existing and disabled', async () => {
    const { repository } = repositoryFor({ users: [{ id: 'u1', disabled: true }] });

    await expect(repository.findOwnerAccess('p1', { type: 'USER', id: 'u1' })).resolves.toEqual({ exists: true, disabled: true });
  });

  it('answers a missing USER owner as absent and reads nothing else', async () => {
    const { repository, client } = repositoryFor({ users: [] });

    await expect(repository.findOwnerAccess('p1', { type: 'USER', id: 'ghost' })).resolves.toEqual({ exists: false, disabled: false });
    expect(client.user.findUnique).toHaveBeenCalledTimes(1);
    expect(client.agent.findUnique).not.toHaveBeenCalled();
  });

  it('answers an AGENT owner from the agent table and never disables it by status', async () => {
    const { repository, client } = repositoryFor({ agents: [{ id: 'a1', status: 'PAUSED' }] });

    await expect(repository.findOwnerAccess('p1', { type: 'AGENT', id: 'a1' })).resolves.toEqual({ exists: true, disabled: false });
    expect(client.agent.findUnique).toHaveBeenCalled();
    expect(client.user.findUnique).not.toHaveBeenCalled();
  });

  it('AC-17: answers a deleted AGENT owner as absent', async () => {
    const { repository } = repositoryFor({ agents: [] });

    await expect(repository.findOwnerAccess('p1', { type: 'AGENT', id: 'gone' })).resolves.toEqual({ exists: false, disabled: false });
  });

  it('AC-5 / AC-6: mayDispatch accepts a developer-key owner and still refuses a viewer-key one', async () => {
    const live = repositoryFor({ users: [{ id: 'u1', disabled: false }] });
    const off = repositoryFor({ users: [{ id: 'u1', disabled: true }] });
    const agent = repositoryFor({ agents: [{ id: 'a1', status: 'ACTIVE' }] });

    expect(mayDispatch(await live.repository.findOwnerAccess('p1', { type: 'USER', id: 'u1' }), DEVELOPER_KEYS)).toBe(true);
    expect(mayDispatch(await live.repository.findOwnerAccess('p1', { type: 'USER', id: 'u1' }), VIEWER_KEYS)).toBe(false);
    expect(mayDispatch(await off.repository.findOwnerAccess('p1', { type: 'USER', id: 'u1' }), DEVELOPER_KEYS)).toBe(false);
    expect(mayDispatch(await agent.repository.findOwnerAccess('p1', { type: 'AGENT', id: 'a1' }), DEVELOPER_KEYS)).toBe(true);
  });
});
