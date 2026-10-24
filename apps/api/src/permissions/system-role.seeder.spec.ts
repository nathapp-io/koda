import type { IPageResult } from '@nathapp/nestjs-data';
import { currentContext, type ActionContext } from '../action-context/action-context';
import { UnknownPermissionEntryError } from './entry-matcher';
import type { RoleDomain, RoleRepository, RoleSeed } from './permissions.types';
import { SystemRoleSeeder } from './system-role.seeder';
import { SYSTEM_ROLES } from './system-roles';

/**
 * US-002 — the seeder's upsert rules, without a database.
 *
 * The acceptance criteria state these against Postgres (AC-3, AC-4, AC-5); this spec pins the same
 * behaviour at the call level, where `bun run test` can see it: which repository calls the seeder
 * makes, and with which patch.
 */

const role = (over: Partial<RoleDomain> = {}): RoleDomain => ({
  id: `role-${over.key ?? 'x'}`,
  key: 'x',
  name: 'X',
  description: '',
  scope: 'PROJECT',
  system: true,
  locked: false,
  permissions: [],
  ...over,
});

/** Rows the fake repository answers with, keyed by role key. */
function fakeRepo(rows: RoleDomain[] = []): {
  repo: RoleRepository;
  created: RoleDomain[];
  updates: Array<{ id: string; patch: Partial<RoleDomain> }>;
} {
  const created: RoleDomain[] = [];
  const updates: Array<{ id: string; patch: Partial<RoleDomain> }> = [];
  const store = [...rows];

  const matches = (row: RoleDomain, criteria: Partial<RoleDomain>): boolean =>
    Object.entries(criteria).every(([key, value]) => row[key as keyof RoleDomain] === value);

  const repo: RoleRepository = {
    findById: async (id: string) => store.find((row) => row.id === id) ?? null,
    findOne: async (criteria: Partial<RoleDomain>) => store.find((row) => matches(row, criteria)) ?? null,
    findAll: async (): Promise<IPageResult<RoleDomain>> => ({
      records: store,
      total: store.length,
      current: 1,
      size: store.length,
      hasNext: false,
      hasPrev: false,
    }),
    count: async () => store.length,
    createRole: async (input) => {
      const row: RoleDomain = { ...input, id: `new-${input.key}` };
      created.push(row);
      store.push(row);
      return row;
    },
    create: async (input: RoleDomain) => {
      created.push(input);
      store.push(input);
      return input;
    },
    update: async (id: string, patch: Partial<RoleDomain>) => {
      updates.push({ id, patch });
      const index = store.findIndex((row) => row.id === id);
      // Mutate in place: the spec holds references to the rows it seeded.
      Object.assign(store[index], patch);
      return store[index];
    },
    delete: async () => undefined,
  };

  return { repo, created, updates };
}

const seed = (over: Partial<RoleSeed> & Pick<RoleSeed, 'key'>): RoleSeed => ({
  name: over.key,
  scope: 'PROJECT',
  system: true,
  permissions: ['ticket.read'],
  ...over,
});

/** Test-local lookups that fail loudly instead of using `!` (oxlint forbids non-null assertions). */
function findRow(rows: readonly RoleDomain[], key: string): RoleDomain {
  const row = rows.find((entry) => entry.key === key);
  if (row === undefined) throw new Error(`no ${key} role`);
  return row;
}

function findSeed(key: string): RoleSeed {
  const seedEntry = SYSTEM_ROLES.find((entry) => entry.key === key);
  if (seedEntry === undefined) throw new Error(`no ${key} seed`);
  return seedEntry;
}

describe('US-002 SystemRoleSeeder.onApplicationBootstrap', () => {
  describe('seed validation (AC-6, AC-7)', () => {
    const invalidSeeds: readonly RoleSeed[] = [
      seed({ key: 'developer', name: 'Developer' }),
      seed({ key: 'broken', name: 'Broken', permissions: ['no.such.key'] }),
    ];

    it('AC-6: rejects with UnknownPermissionEntryError when a seeded role holds an unknown entry', async () => {
      const { repo } = fakeRepo();

      await expect(new SystemRoleSeeder(invalidSeeds, repo).onApplicationBootstrap()).rejects.toBeInstanceOf(
        UnknownPermissionEntryError,
      );
    });

    it('AC-7: writes nothing when any seeded role holds an unknown entry', async () => {
      const { repo, created, updates } = fakeRepo();

      await expect(new SystemRoleSeeder(invalidSeeds, repo).onApplicationBootstrap()).rejects.toBeInstanceOf(
        UnknownPermissionEntryError,
      );

      // The valid seed sorts first: a seeder that validated one role at a time, creating as it went,
      // would already have inserted `developer` here.
      expect(created).toEqual([]);
      expect(updates).toEqual([]);
    });
  });

  describe('first bootstrap on an empty table', () => {
    it('creates every seeded role with its scope, system flag, lock and permissions', async () => {
      const { repo, created } = fakeRepo();

      await new SystemRoleSeeder(SYSTEM_ROLES, repo).onApplicationBootstrap();

      expect(created.map((row) => row.key)).toEqual(SYSTEM_ROLES.map((entry) => entry.key));
      expect(created.every((row) => row.system)).toBe(true);
      expect(created.filter((row) => row.locked).map((row) => row.key)).toEqual(['owner']);
      const developer = created.find((row) => row.key === 'developer');
      expect(developer).toMatchObject({ name: 'Developer', scope: 'PROJECT', locked: false });
      expect(developer?.permissions).toEqual([...findSeed('developer').permissions]);
    });
  });

  describe('a later bootstrap (AC-3, AC-4, AC-5)', () => {
    /** The table after one successful bootstrap. */
    const seeded = (): RoleDomain[] =>
      SYSTEM_ROLES.map((entry) =>
        role({
          id: `id-${entry.key}`,
          key: entry.key,
          name: entry.name,
          scope: entry.scope,
          locked: entry.locked ?? false,
          permissions: [...entry.permissions],
        }),
      );

    it('AC-3: creates no new Role rows', async () => {
      const { repo, created, updates } = fakeRepo(seeded());

      await new SystemRoleSeeder(SYSTEM_ROLES, repo).onApplicationBootstrap();

      expect(created).toEqual([]);
      // Nothing about the stored rows differs from the seed, so there is nothing to write either.
      expect(updates).toEqual([]);
    });

    it('AC-4: keeps an unlocked system role’s stored permissions', async () => {
      const rows = seeded();
      const developer = findRow(rows, 'developer');
      developer.permissions = ['ticket.read'];
      const { repo, created, updates } = fakeRepo(rows);

      await new SystemRoleSeeder(SYSTEM_ROLES, repo).onApplicationBootstrap();

      expect(created).toEqual([]);
      expect(updates).toEqual([]);
      expect(developer.permissions).toEqual(['ticket.read']);
    });

    it('AC-5: restores a locked role’s permissions from the seed', async () => {
      const rows = seeded();
      const owner = findRow(rows, 'owner');
      owner.permissions = ['ticket.read'];
      const { repo, updates } = fakeRepo(rows);

      await new SystemRoleSeeder(SYSTEM_ROLES, repo).onApplicationBootstrap();

      expect(updates).toHaveLength(1);
      expect(updates[0].id).toBe('id-owner');
      expect(updates[0].patch.permissions).toEqual(['*']);
      expect(owner.permissions).toEqual(['*']);
    });

    it('restores a locked role’s name and scope when only those differ', async () => {
      const rows = seeded();
      const owner = findRow(rows, 'owner');
      owner.name = 'Renamed';
      owner.scope = 'PROJECT';
      const { repo, updates } = fakeRepo(rows);

      await new SystemRoleSeeder(SYSTEM_ROLES, repo).onApplicationBootstrap();

      expect(updates).toHaveLength(1);
      expect(updates[0].patch).toMatchObject({ name: 'Owner', scope: 'GLOBAL', permissions: ['*'] });
    });

    it('resets an unlocked role’s name and scope but never its permissions', async () => {
      const rows = seeded();
      const developer = findRow(rows, 'developer');
      developer.name = 'Renamed';
      developer.scope = 'GLOBAL';
      developer.permissions = ['ticket.read'];
      const { repo, updates } = fakeRepo(rows);

      await new SystemRoleSeeder(SYSTEM_ROLES, repo).onApplicationBootstrap();

      expect(updates).toHaveLength(1);
      expect(updates[0].patch).toEqual({ name: 'Developer', scope: 'PROJECT' });
      expect(developer.name).toBe('Developer');
      expect(developer.scope).toBe('PROJECT');
      expect(developer.permissions).toEqual(['ticket.read']);
    });

    it('never deletes a role row', async () => {
      const { repo } = fakeRepo(seeded());
      const del = vi.spyOn(repo, 'delete');

      await new SystemRoleSeeder(SYSTEM_ROLES, repo).onApplicationBootstrap();

      expect(del).not.toHaveBeenCalled();
    });

    /** Permissions P2 US-005: the boot hook is the background entry; the seed writes as `seed`. */
    it('AC-11: a role created at boot is created as SYSTEM/seed', async () => {
      const { repo } = fakeRepo();
      const seen: Array<ActionContext | undefined> = [];
      const createRole = vi.spyOn(repo, 'createRole').mockImplementation(async (input) => {
        seen.push(currentContext());
        return { ...input, id: `new-${input.key}` } as RoleDomain;
      });

      // A single seed keeps the assertion to one recorded creation.
      await new SystemRoleSeeder([findSeed('developer')], repo).onApplicationBootstrap();

      expect(createRole).toHaveBeenCalledTimes(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.actor).toEqual({ type: 'SYSTEM', id: 'seed' });
    });
  });

  describe('the module seed', () => {
    it('all eleven system roles expand without error', async () => {
      const { expandEntries } = await import('./entry-matcher');

      for (const entry of SYSTEM_ROLES) {
        expect(() => expandEntries(entry.permissions, entry.scope)).not.toThrow();
      }
    });

    it('the six non-admin project roles reach neither project secret read, and project-admin does', async () => {
      const { expandEntries } = await import('./entry-matcher');
      const secretReads = ['project.ci-token.read', 'invite.read'];
      const nonAdminProjectRoles = ['developer', 'reviewer', 'verifier', 'triager', 'approver', 'viewer'];

      const held = Object.fromEntries(
        SYSTEM_ROLES.map((entry) => [
          entry.key,
          secretReads.filter((key) => expandEntries(entry.permissions, entry.scope).has(key)),
        ]),
      );

      for (const key of nonAdminProjectRoles) expect([key, held[key]]).toEqual([key, []]);
      // `project-admin` keeps both through `*`; the global roles keep them in every project.
      expect(held['project-admin']).toEqual(secretReads);
    });
  });
});
