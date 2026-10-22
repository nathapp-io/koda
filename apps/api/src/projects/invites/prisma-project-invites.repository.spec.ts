import { PrismaProjectInvitesRepository } from './prisma-project-invites.repository';

/**
 * S4b US-004: `PrismaProjectInvitesRepository` is module-private, but its query *shape* is part of what the
 * admin routes depend on. Most importantly `.nax/rules/api-data.md` (Pagination Anti-Patterns) says "Every
 * `findMany` on an unbounded table must include `take`; never issue a bare `findMany` that returns all rows".
 * `ProjectInvite` is exactly that kind of table: it grows with every invite ever created for a project, so a
 * bare `findMany` makes both the query and the `GET /projects/:slug/invites` response grow without bound.
 */

const TOKEN_HASH = 'f'.repeat(64);
const EXPIRES_AT = new Date('2026-10-17T10:00:00Z');
const CREATED_AT = new Date('2026-10-10T10:00:00Z');

/** A `ProjectInvite` row as Prisma returns it with `INCLUDE_CONTEXT` (includes the two display names). */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  projectId: 'p1',
  email: 'new@x.io',
  role: 'DEVELOPER',
  roleId: null,
  tokenHash: TOKEN_HASH,
  status: 'PENDING',
  invitedById: 'admin',
  invitedByAgentId: null,
  acceptedByUserId: null,
  acceptedAt: null,
  expiresAt: EXPIRES_AT,
  createdAt: CREATED_AT,
  invitedBy: { name: 'Ada' },
  assignedRole: null,
  project: { name: 'Koda' },
  ...over,
});

const RECORD_KEYS = [
  'acceptedAt',
  'acceptedByUserId',
  'createdAt',
  'email',
  'expiresAt',
  'id',
  'invitedById',
  'inviterName',
  'projectId',
  'role',
  'roleId',
  'roleKey',
  'roleName',
  'status',
].sort();

function setup() {
  const findMany = vi.fn().mockResolvedValue([]);
  const create = vi.fn().mockResolvedValue(row());
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const findAgents = vi.fn().mockResolvedValue([]);
  const findRoles = vi.fn().mockResolvedValue([{ key: 'developer', name: 'Developer' }]);
  const repo = new PrismaProjectInvitesRepository({
    client: { projectInvite: { findMany, create, updateMany }, agent: { findMany: findAgents }, role: { findMany: findRoles } },
  } as never);
  return { repo, findMany, create, updateMany, findAgents, findRoles };
}

describe('PrismaProjectInvitesRepository.list (S4b US-004)', () => {
  it('clamps the project invite list with a finite take — a bare findMany returns every invite ever created', async () => {
    const { repo, findMany } = setup();

    await repo.list('p1');

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0] as { where: unknown; orderBy: unknown; take?: number };
    expect(args.where).toEqual({ projectId: 'p1' });
    // Newest first, so the invite an admin just sent is at the top; the id tiebreak keeps the order total
    // when two invites share a `createdAt`.
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    // The bound itself: any positive, finite integer cap satisfies the rule, but *some* cap must be present.
    expect(typeof args.take).toBe('number');
    expect(Number.isInteger(args.take)).toBe(true);
    expect(args.take).toBeGreaterThan(0);
  });

  it('maps rows to the public record shape and never leaks the stored token hash', async () => {
    const { repo, findMany } = setup();
    findMany.mockResolvedValueOnce([row({ invitedBy: null }), row({ id: 'i2', email: 'other@x.io' })]);

    const records = await repo.list('p1');

    expect(records).toHaveLength(2);
    expect(Object.keys(records[0]).sort()).toEqual(RECORD_KEYS);
    expect(records[0]).toEqual({
      id: 'i1',
      projectId: 'p1',
      email: 'new@x.io',
      role: 'DEVELOPER',
      roleId: null,
      // No roleId: the legacy role names the role, and its name is read from the role table.
      roleKey: 'developer',
      roleName: 'Developer',
      status: 'PENDING',
      invitedById: 'admin',
      // The inviter may have been deleted since the invite was sent; the name is display-only.
      inviterName: null,
      acceptedByUserId: null,
      acceptedAt: null,
      expiresAt: EXPIRES_AT,
      createdAt: CREATED_AT,
    });
    expect(records[1]).toMatchObject({ id: 'i2', inviterName: 'Ada' });
    expect(JSON.stringify(records)).not.toContain(TOKEN_HASH);
  });
});

describe('PrismaProjectInvitesRepository role fields (permissions P1 web US-005)', () => {
  it('reads roleKey and roleName from the related role, and the legacy role stays null for a custom key', async () => {
    const { repo, findMany, findRoles } = setup();
    findMany.mockResolvedValueOnce([
      row({ role: null, roleId: 'r1', assignedRole: { key: 'triager', name: 'Triager' } }),
    ]);

    const [record] = await repo.list('p1');

    expect(record).toMatchObject({ role: null, roleId: 'r1', roleKey: 'triager', roleName: 'Triager' });
    // Every row names its role through the relation: no legacy lookup is needed.
    expect(findRoles).not.toHaveBeenCalled();
  });

  it('answers null roleKey and roleName for a row whose roleId and role are both null', async () => {
    const { repo, findMany, findRoles } = setup();
    findMany.mockResolvedValueOnce([row({ role: null, roleId: null })]);

    const [record] = await repo.list('p1');

    expect(record).toMatchObject({ role: null, roleId: null, roleKey: null, roleName: null });
    expect(findRoles).not.toHaveBeenCalled();
  });

  it('reads the legacy role names of a page in one bounded query', async () => {
    const { repo, findMany, findRoles } = setup();
    findRoles.mockResolvedValueOnce([
      { key: 'viewer', name: 'Viewer' },
      { key: 'developer', name: 'Developer' },
    ]);
    findMany.mockResolvedValueOnce([row({ role: 'VIEWER' }), row({ id: 'i2', role: 'DEVELOPER' }), row({ id: 'i3', role: 'VIEWER' })]);

    const records = await repo.list('p1');

    expect(findRoles).toHaveBeenCalledTimes(1);
    expect(findRoles).toHaveBeenCalledWith({
      where: { key: { in: ['viewer', 'developer'] } },
      select: { key: true, name: true },
      take: 2,
    });
    expect(records.map((record) => record.roleName)).toEqual(['Viewer', 'Developer', 'Viewer']);
  });
});

describe('PrismaProjectInvitesRepository writes (S4b US-004)', () => {
  it('cancelPending cancels only the PENDING invites of one project and address (AC-7)', async () => {
    const { repo, updateMany } = setup();
    updateMany.mockResolvedValueOnce({ count: 3 });

    await expect(repo.cancelPending('p1', 'new@x.io')).resolves.toBe(3);

    expect(updateMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', email: 'new@x.io', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  });

  it('create stores the hash (never a raw token) and returns the project name the invite email renders', async () => {
    const { repo, create } = setup();
    create.mockResolvedValueOnce(row({ id: 'i9' }));

    const created = await repo.create({
      projectId: 'p1',
      email: 'new@x.io',
      role: 'DEVELOPER',
      roleId: 'id-developer',
      tokenHash: TOKEN_HASH,
      invitedById: 'admin',
      invitedByAgentId: null,
      expiresAt: EXPIRES_AT,
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        projectId: 'p1',
        email: 'new@x.io',
        role: 'DEVELOPER',
        roleId: 'id-developer',
        tokenHash: TOKEN_HASH,
        invitedById: 'admin',
        invitedByAgentId: null,
        expiresAt: EXPIRES_AT,
      },
      include: {
        invitedBy: { select: { name: true } },
        assignedRole: { select: { key: true, name: true } },
        project: { select: { name: true } },
      },
    });
    expect(created).toMatchObject({ id: 'i9', projectName: 'Koda' });
    expect(Object.keys(created)).not.toContain('tokenHash');
  });

  it('B4: an agent inviter is stored in invitedByAgentId, with invitedById null', async () => {
    const { repo, create, findAgents } = setup();
    create.mockResolvedValueOnce(
      row({ id: 'i9', invitedById: null, invitedByAgentId: 'agent-1', invitedBy: null }),
    );
    findAgents.mockResolvedValueOnce([{ id: 'agent-1', name: 'roster-agent' }]);

    const created = await repo.create({
      projectId: 'p1',
      email: 'new@x.io',
      role: 'VIEWER',
      roleId: 'id-viewer',
      tokenHash: TOKEN_HASH,
      invitedById: null,
      invitedByAgentId: 'agent-1',
      expiresAt: EXPIRES_AT,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ invitedById: null, invitedByAgentId: 'agent-1' }),
      }),
    );
    // The name comes from the agent row, because `invitedByAgentId` has no relation to include.
    expect(findAgents).toHaveBeenCalledWith({
      where: { id: { in: ['agent-1'] } },
      select: { id: true, name: true },
      take: 1,
    });
    expect(created).toMatchObject({ invitedById: null, inviterName: 'roster-agent' });
  });

  it('B4: a page of agent invites resolves the agent names in one read, skipping user inviters', async () => {
    const { repo, findMany, findAgents } = setup();
    findMany.mockResolvedValueOnce([
      row({ id: 'i1', invitedBy: null, invitedById: null, invitedByAgentId: 'agent-1' }),
      row({ id: 'i2', invitedBy: null, invitedById: null, invitedByAgentId: 'agent-2' }),
      row({ id: 'i3' }),
    ]);
    findAgents.mockResolvedValueOnce([
      { id: 'agent-1', name: 'first-agent' },
      { id: 'agent-2', name: 'second-agent' },
    ]);

    const records = await repo.list('p1');

    expect(findAgents).toHaveBeenCalledTimes(1);
    expect(findAgents).toHaveBeenCalledWith({
      where: { id: { in: ['agent-1', 'agent-2'] } },
      select: { id: true, name: true },
      take: 2,
    });
    expect(records.map((record) => record.inviterName)).toEqual(['first-agent', 'second-agent', 'Ada']);
  });
});
