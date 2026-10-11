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
  tokenHash: TOKEN_HASH,
  status: 'PENDING',
  invitedById: 'admin',
  acceptedByUserId: null,
  acceptedAt: null,
  expiresAt: EXPIRES_AT,
  createdAt: CREATED_AT,
  invitedBy: { name: 'Ada' },
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
  'status',
].sort();

function setup() {
  const findMany = vi.fn().mockResolvedValue([]);
  const create = vi.fn().mockResolvedValue(row());
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const repo = new PrismaProjectInvitesRepository({
    client: { projectInvite: { findMany, create, updateMany } },
  } as never);
  return { repo, findMany, create, updateMany };
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
      tokenHash: TOKEN_HASH,
      invitedById: 'admin',
      expiresAt: EXPIRES_AT,
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        projectId: 'p1',
        email: 'new@x.io',
        role: 'DEVELOPER',
        tokenHash: TOKEN_HASH,
        invitedById: 'admin',
        expiresAt: EXPIRES_AT,
      },
      include: { invitedBy: { select: { name: true } }, project: { select: { name: true } } },
    });
    expect(created).toMatchObject({ id: 'i9', projectName: 'Koda' });
    expect(Object.keys(created)).not.toContain('tokenHash');
  });
});
