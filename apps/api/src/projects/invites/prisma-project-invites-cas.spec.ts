import { PrismaProjectInvitesRepository } from './prisma-project-invites.repository';

/**
 * S4b US-005: the two compare-and-set guards that make the token single-use and the rotation
 * unambiguous, pinned at the repository level (no database — see `.nax/rules/api-testing.md`).
 *
 * Both defects only show up under interleaving:
 *   1. `claimPending` used to check id/status/expiry only, so a resend that rotated the hash between
 *      the caller's lookup and the claim still let the *superseded* link be redeemed.
 *   2. `rotate` used to guard on `status = 'PENDING'`, which a rotation leaves unchanged, so two
 *      concurrent resends both matched and both reported success — one handing back a link the other
 *      had already replaced.
 */

const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);
const NOW = new Date('2026-10-10T10:00:00Z');

interface FakeRow {
  id: string;
  projectId: string;
  email: string;
  role: string;
  tokenHash: string;
  status: string;
  invitedById: string;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

const startRow = (over: Partial<FakeRow> = {}): FakeRow => ({
  id: 'i1',
  projectId: 'p1',
  email: 'new@x.io',
  role: 'DEVELOPER',
  tokenHash: OLD_HASH,
  status: 'PENDING',
  invitedById: 'admin',
  acceptedByUserId: null,
  acceptedAt: null,
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  createdAt: NOW,
  ...over,
});

const withNames = (row: FakeRow) => ({ ...row, invitedBy: { name: 'Ada' }, project: { name: 'Koda' } });

/**
 * A one-row in-memory stand-in for the `projectInvite` delegate. `updateMany` honours the `where`
 * keys the guards rely on (id, projectId, tokenHash, status) and returns `count: 0` when the row
 * stopped matching — which is what PostgreSQL does when it re-checks the predicate under the lock.
 * `expiresAt` is not evaluated here; expiry is covered by the DB-backed suite.
 */
function delegate(start: FakeRow = startRow()) {
  let row: FakeRow = { ...start };

  const findFirst = jest.fn(async (args: { where: Record<string, unknown>; select?: Record<string, true> }) => {
    if (args.where['id'] !== row.id || args.where['projectId'] !== row.projectId) return null;
    return args.select ? { tokenHash: row.tokenHash } : withNames(row);
  });

  const updateMany = jest.fn(async (args: { where: Record<string, unknown>; data: Partial<FakeRow> }) => {
    const { where } = args;
    const matches =
      (where['id'] === undefined || where['id'] === row.id) &&
      (where['projectId'] === undefined || where['projectId'] === row.projectId) &&
      (where['tokenHash'] === undefined || where['tokenHash'] === row.tokenHash) &&
      (where['status'] === undefined || where['status'] === row.status);
    if (!matches) return { count: 0 };
    row = { ...row, ...args.data };
    return { count: 1 };
  });

  const findUnique = jest.fn(async () => withNames(row));

  return {
    repo: new PrismaProjectInvitesRepository({
      client: { projectInvite: { findFirst, updateMany, findUnique } },
    } as never),
    findFirst,
    updateMany,
    findUnique,
    row: () => row,
  };
}

describe('PrismaProjectInvitesRepository.claimPending (S4b US-005)', () => {
  it('fences the claim with the token hash the caller presented, not just the row id', async () => {
    const { repo, updateMany } = delegate();
    updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(repo.claimPending('i1', OLD_HASH, NOW)).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'i1', tokenHash: OLD_HASH, status: 'PENDING', expiresAt: { gt: NOW } },
      data: { status: 'ACCEPTED', acceptedAt: NOW },
    });
  });

  it('refuses the claim when a resend rotated the hash after the lookup', async () => {
    // The admin resent the invite in between: the stored hash is now the replacement.
    const { repo, row } = delegate(startRow({ tokenHash: NEW_HASH }));

    await expect(repo.claimPending('i1', OLD_HASH, NOW)).resolves.toBe(false);
    expect(row()).toMatchObject({ status: 'PENDING', tokenHash: NEW_HASH, acceptedAt: null });
  });

  it('still claims the row once, with the current hash, and marks it ACCEPTED', async () => {
    const { repo, row } = delegate();

    await expect(repo.claimPending('i1', OLD_HASH, NOW)).resolves.toBe(true);
    expect(row()).toMatchObject({ status: 'ACCEPTED', acceptedAt: NOW });

    // Single use: the same token cannot claim the row twice (AC-7).
    await expect(repo.claimPending('i1', OLD_HASH, NOW)).resolves.toBe(false);
  });
});

describe('PrismaProjectInvitesRepository.rotate (S4b US-005)', () => {
  it('compare-and-sets on the hash it read, so a stale caller cannot overwrite a newer rotation', async () => {
    const { repo, updateMany } = delegate();

    await repo.rotate({ id: 'i1', projectId: 'p1', tokenHash: NEW_HASH, expiresAt: NOW });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'i1', projectId: 'p1', tokenHash: OLD_HASH, status: 'PENDING' },
      data: { tokenHash: NEW_HASH, status: 'PENDING', expiresAt: NOW },
    });
  });

  it('lets exactly one of two concurrent resends win, and only the winner stores a live link', async () => {
    const { repo, row } = delegate();
    const minted = ['1'.repeat(64), '2'.repeat(64)];

    const results = await Promise.all(
      minted.map((tokenHash) => repo.rotate({ id: 'i1', projectId: 'p1', tokenHash, expiresAt: NOW })),
    );

    const winner = results.findIndex((res) => res !== null);
    expect(results.filter((res) => res !== null)).toHaveLength(1);
    // The row keeps the hash the successful resend reported and emailed — never a superseded one.
    expect(row().tokenHash).toBe(minted[winner]);
  });

  it('returns null instead of rotating an invite that is already final', async () => {
    const { repo, row } = delegate(startRow({ status: 'ACCEPTED' }));

    await expect(repo.rotate({ id: 'i1', projectId: 'p1', tokenHash: NEW_HASH, expiresAt: NOW }))
      .resolves.toBeNull();
    expect(row()).toMatchObject({ status: 'ACCEPTED', tokenHash: OLD_HASH });
  });

  it('returns null without writing for an invite the caller cannot see in this project', async () => {
    const { repo, updateMany } = delegate();

    await expect(repo.rotate({ id: 'i1', projectId: 'other', tokenHash: NEW_HASH, expiresAt: NOW }))
      .resolves.toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
