/**
 * Permissions P1 US-008: `MemoryWriteGuard` is the one place that decides whether a principal may
 * supersede an active memory item, and it is the check `upsert` runs inside its own transaction.
 *
 * The guard is a pure collaborator over `PermissionService` and the repository, so these cases drive it
 * with two mocks and no Nest container: the semantics (which `createdBy` is passed, and which refusals
 * are raised) are what the story pins.
 */
import { MemoryKind } from '../common/enums';
import { PermissionService } from '../permissions/permission.service';
import { MemoryReplaceRefusedError, MemoryWriteGuard } from './memory-write.guard';
import type { MemoryItem } from './memory-item-repository';
import type { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import type { UserPrincipal } from '../auth/principal/koda-principal.types';

const principal: UserPrincipal = {
  actorType: 'user',
  id: 'user-1',
  name: 'dev@koda.test',
  email: 'dev@koda.test',
  role: 'MEMBER',
  blacklisted: false,
  revoked: false,
  authorities: ['MEMBER'],
};

const makeItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-1',
  kind: MemoryKind.FACT,
  subject: 'ticket:1',
  predicate: 'status',
  object: 'active',
  status: 'active',
  confidence: 0.9,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('MemoryWriteGuard', () => {
  let guard: MemoryWriteGuard;
  let can: ReturnType<typeof vi.fn>;
  let findActive: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    can = vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' });
    findActive = vi.fn().mockResolvedValue(null);
    guard = new MemoryWriteGuard(
      { can } as unknown as PermissionService,
      { findActive } as unknown as PrismaMemoryItemRepository,
    );
  });

  describe('mayReplace', () => {
    it('asks for memory.update in the item\'s project with the item\'s owner as the resource', async () => {
      await expect(
        guard.mayReplace(principal, 'project-1', makeItem({ ownerType: 'USER', ownerId: 'user-2' })),
      ).resolves.toBe(true);

      expect(can).toHaveBeenCalledWith(principal, 'memory.update', {
        projectId: 'project-1',
        resource: { createdBy: { type: 'USER', id: 'user-2' } },
      });
    });

    it('passes no creator for a system item (no ownerType)', async () => {
      await guard.mayReplace(principal, 'project-1', makeItem({ ownerId: 'user-2' }));

      expect(can).toHaveBeenCalledWith(principal, 'memory.update', {
        projectId: 'project-1',
        resource: { createdBy: null },
      });
    });

    it('passes no creator for an item that has an ownerType but no ownerId', async () => {
      await guard.mayReplace(principal, 'project-1', makeItem({ ownerType: 'AGENT' }));

      expect(can).toHaveBeenCalledWith(principal, 'memory.update', {
        projectId: 'project-1',
        resource: { createdBy: null },
      });
    });

    it('answers false when the key is refused', async () => {
      can.mockResolvedValue({ allowed: false, reason: 'not-owner' });

      await expect(guard.mayReplace(principal, 'project-1', makeItem({ ownerType: 'USER', ownerId: 'user-2' })))
        .resolves.toBe(false);
    });
  });

  describe('replaceCheck', () => {
    it('resolves when the principal may replace the active item', async () => {
      await expect(guard.replaceCheck(principal, 'project-1')(makeItem())).resolves.toBeUndefined();
    });

    it('throws MemoryReplaceRefusedError carrying the item id when the key is refused', async () => {
      can.mockResolvedValue({ allowed: false, reason: 'not-owner' });

      const check = guard.replaceCheck(principal, 'project-1');

      await expect(check(makeItem({ id: 'mem-9' }))).rejects.toThrow(MemoryReplaceRefusedError);
      await expect(check(makeItem({ id: 'mem-9' }))).rejects.toMatchObject({ itemId: 'mem-9', message: 'memory:mem-9' });
    });
  });

  describe('assertMayReplace', () => {
    const key = { kind: MemoryKind.FACT, subject: 'ticket:1', predicate: 'status' };

    it('reads the active item of the key in the project', async () => {
      await guard.assertMayReplace(principal, 'project-1', key);

      expect(findActive).toHaveBeenCalledWith('project-1', MemoryKind.FACT, 'ticket:1', 'status');
    });

    it('resolves when no active item holds the key', async () => {
      await expect(guard.assertMayReplace(principal, 'project-1', key)).resolves.toBeUndefined();
      expect(can).not.toHaveBeenCalled();
    });

    it('resolves when the active item is the principal\'s to replace', async () => {
      findActive.mockResolvedValue(makeItem({ ownerType: 'USER', ownerId: 'user-1' }));

      await expect(guard.assertMayReplace(principal, 'project-1', key)).resolves.toBeUndefined();
    });

    it('throws MemoryReplaceRefusedError when the active item is another principal\'s', async () => {
      findActive.mockResolvedValue(makeItem({ id: 'mem-2', ownerType: 'USER', ownerId: 'user-2' }));
      can.mockResolvedValue({ allowed: false, reason: 'not-owner' });

      await expect(guard.assertMayReplace(principal, 'project-1', key)).rejects.toMatchObject({ itemId: 'mem-2' });
    });

    it('throws MemoryReplaceRefusedError when the active item has no owner (a system item)', async () => {
      findActive.mockResolvedValue(makeItem({ id: 'mem-3', ownerType: null, ownerId: null }));
      can.mockResolvedValue({ allowed: false, reason: 'not-owner' });

      await expect(guard.assertMayReplace(principal, 'project-1', key)).rejects.toMatchObject({ itemId: 'mem-3' });
    });
  });
});
