import type { PrismaClient } from '../generated/prisma/client';
import type { ProjectMembership } from './permissions.types';
import {
  accessibleProjectIds,
  agentHasProjectAccess,
  countActiveProjectAdmins,
  listProjectMemberships,
  localProjectRole,
  principalIdsWithAccess,
  userProjectRole,
} from './legacy-membership.queries';

/**
 * US-001 — the compatibility queries' source union without a database.
 *
 * The Postgres behaviour is pinned by `test/integration/permissions/legacy-membership-queries.integration.spec.ts`;
 * this spec drives the same functions through a stub client so the merge logic (which sources count,
 * strongest role, `since`, `addedByUserId`, ordering) is pinned by a run that needs no database.
 * The stub keeps the rows in their relational shape and matches `where` the way Prisma does
 * (equality, `in`, `null`, nested relation filters, `OR`), so a query shape the stub cannot answer
 * fails loudly instead of answering with the unfiltered rows.
 */

type Row = Record<string, unknown>;

const COMPOUND_KEYS = ['projectId_userId', 'agentId_projectId'];

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') {
      return (expected as Row[]).some((clause) => matches(row, clause));
    }
    const actual = row[key];
    if (expected === null) return actual === null;
    if (typeof expected !== 'object' || expected instanceof Date) return actual === expected;
    if (Array.isArray(expected)) return (expected as unknown[]).includes(actual);
    const clause = expected as Row;
    if ('in' in clause) return (clause['in'] as unknown[]).includes(actual);
    if ('not' in clause) return actual !== clause['not'];
    return matches((actual ?? {}) as Row, clause);
  });
}

function project(row: Row, select: Row | undefined): Row {
  if (!select) return row;
  const out: Row = {};
  for (const [key, value] of Object.entries(select)) {
    out[key] =
      value && typeof value === 'object' && 'select' in (value as Row)
        ? project((row[key] ?? {}) as Row, (value as Row)['select'] as Row)
        : row[key];
  }
  return out;
}

/** The subset of the generated client the queries use, backed by plain rows. */
function stubClient(rows: {
  role: Row[];
  roleBinding: Row[];
  projectMember: Row[];
  agentProject: Row[];
  project: Row[];
  user: Row[];
  agent: Row[];
}): PrismaClient {
  const findMany = (table: Row[]) => async (args: Row = {}): Promise<Row[]> => {
    const where = (args['where'] ?? {}) as Row;
    const orderBy = args['orderBy'] === undefined ? [] : ([] as Row[]).concat(args['orderBy'] as Row);
    const take = args['take'] as number | undefined;
    let found = table.filter((row) => matches(row, where));
    for (const order of [...orderBy].reverse()) {
      const [field, direction] = Object.entries(order)[0] as [string, string];
      found = [...found].sort((a, b) => {
        const left = a[field] as string | number | Date;
        const right = b[field] as string | number | Date;
        const result = left < right ? -1 : left > right ? 1 : 0;
        return direction === 'desc' ? -result : result;
      });
    }
    return found.slice(0, take ?? found.length).map((row) => project(row, args['select'] as Row | undefined));
  };

  const findUnique = (table: Row[]) => async (args: Row = {}): Promise<Row | null> => {
    const where = (args['where'] ?? {}) as Row;
    const compound = COMPOUND_KEYS.map((key) => where[key]).find((value) => value !== undefined);
    const filter = (compound ?? where) as Row;
    const found = table.find((row) => matches(row, filter)) ?? null;
    return found ? project(found, args['select'] as Row | undefined) : null;
  };

  return {
    role: { findMany: findMany(rows.role), findUnique: findUnique(rows.role) },
    roleBinding: { findMany: findMany(rows.roleBinding), findUnique: findUnique(rows.roleBinding) },
    projectMember: { findMany: findMany(rows.projectMember), findUnique: findUnique(rows.projectMember) },
    agentProject: { findMany: findMany(rows.agentProject), findUnique: findUnique(rows.agentProject) },
    project: {
      findMany: findMany(rows.project),
      count: async (args: Row = {}) =>
        rows.project.filter((row) => matches(row, (args['where'] ?? {}) as Row)).length,
    },
    user: {
      count: async (args: Row = {}) =>
        rows.user.filter((row) => matches(row, (args['where'] ?? {}) as Row)).length,
    },
    agent: { findMany: findMany(rows.agent) },
  } as unknown as PrismaClient;
}

interface World {
  db: PrismaClient;
  addProject(id: string, softDeleted?: boolean): void;
  addUser(id: string, disabled?: boolean): void;
  addAgent(id: string): void;
  bind(
    principalType: 'USER' | 'AGENT',
    principalId: string,
    roleKey: string,
    projectId: string | null,
    options?: { grantedByType?: string; grantedById?: string; createdAt?: Date },
  ): void;
  addLegacyMember(projectId: string, userId: string, role: string, joinedAt?: Date): void;
  addRosterRow(agentId: string, projectId: string, addedById: string | null, createdAt?: Date): void;
}

const ROLES: ReadonlyArray<{ key: string; scope: 'GLOBAL' | 'PROJECT' }> = [
  { key: 'owner', scope: 'GLOBAL' },
  { key: 'admin', scope: 'GLOBAL' },
  { key: 'member', scope: 'GLOBAL' },
  { key: 'agent', scope: 'GLOBAL' },
  { key: 'project-admin', scope: 'PROJECT' },
  { key: 'developer', scope: 'PROJECT' },
  { key: 'reviewer', scope: 'PROJECT' },
  { key: 'viewer', scope: 'PROJECT' },
];

function world(): World {
  let seq = 0;
  const next = (): Date => new Date(1_700_000_000_000 + (seq += 1_000));
  const rows = {
    role: ROLES.map(({ key, scope }) => ({ id: `role-${key}`, key, scope })),
    roleBinding: [] as Row[],
    projectMember: [] as Row[],
    agentProject: [] as Row[],
    project: [] as Row[],
    user: [] as Row[],
    agent: [] as Row[],
  };
  const roleId = (key: string): string => {
    const role = rows.role.find((candidate) => candidate['key'] === key);
    if (!role) throw new Error(`unknown role key ${key}`);
    return role['id'] as string;
  };
  return {
    db: stubClient(rows),
    addProject(id, softDeleted = false) {
      rows.project.push({ id, deletedAt: softDeleted ? next() : null });
    },
    addUser(id, disabled = false) {
      rows.user.push({ id, disabled });
    },
    addAgent(id) {
      rows.agent.push({ id });
    },
    bind(principalType, principalId, roleKey, projectId, options = {}) {
      rows.roleBinding.push({
        id: `binding-${rows.roleBinding.length + 1}`,
        principalType,
        principalId,
        roleId: roleId(roleKey),
        role: rows.role.find((role) => role['key'] === roleKey),
        projectId,
        grantedByType: options.grantedByType ?? 'SYSTEM',
        grantedById: options.grantedById ?? 'test',
        createdAt: options.createdAt ?? next(),
      });
    },
    addLegacyMember(projectId, userId, role, joinedAt) {
      rows.projectMember.push({
        projectId,
        userId,
        role,
        joinedAt: joinedAt ?? next(),
        user: rows.user.find((user) => user['id'] === userId) ?? { id: userId, disabled: false },
      });
    },
    addRosterRow(agentId, projectId, addedById, createdAt) {
      rows.agentProject.push({ agentId, projectId, addedById, createdAt: createdAt ?? next() });
    },
  };
}

describe('legacy-membership.queries', () => {
  let fixture: World;
  let db: PrismaClient;

  beforeEach(() => {
    fixture = world();
    db = fixture.db;
  });

  const user = (id: string) => ({ type: 'USER' as const, id });

  describe('userProjectRole', () => {
    it('AC-3: a binding-only user answers the mapped legacy role', async () => {
      fixture.addUser('u1');
      fixture.addProject('p1');
      fixture.bind('USER', 'u1', 'developer', 'p1');

      expect(await userProjectRole(db, 'u1', 'p1')).toBe('DEVELOPER');
    });

    it('AC-4: the strongest of a legacy row and a project binding wins', async () => {
      fixture.addUser('u1');
      fixture.addProject('p1');
      fixture.addLegacyMember('p1', 'u1', 'VIEWER');
      fixture.bind('USER', 'u1', 'project-admin', 'p1');

      expect(await userProjectRole(db, 'u1', 'p1')).toBe('ADMIN');
    });

    it('AC-5: a global project binding applies in any project, a local one does not', async () => {
      fixture.addUser('u1');
      fixture.addProject('p2');
      fixture.bind('USER', 'u1', 'reviewer', null);

      expect(await userProjectRole(db, 'u1', 'p2')).toBe('VIEWER');
      expect(await localProjectRole(db, user('u1'), 'p2')).toBeNull();
    });

    it('AC-6: a GLOBAL-scope binding is never a source', async () => {
      fixture.addUser('u1');
      fixture.addProject('p1');
      fixture.bind('USER', 'u1', 'admin', null);

      expect(await userProjectRole(db, 'u1', 'p1')).toBeNull();
      expect(await localProjectRole(db, user('u1'), 'p1')).toBeNull();
    });

    it('answers null for a project the user has no source in, and for unknown ids', async () => {
      fixture.addUser('u1');
      fixture.addProject('p1');
      fixture.addProject('p2');
      fixture.bind('USER', 'u1', 'developer', 'p1');

      expect(await userProjectRole(db, 'u1', 'p2')).toBeNull();
      expect(await userProjectRole(db, 'ghost-user', 'p1')).toBeNull();
      expect(await userProjectRole(db, 'u1', 'ghost-project')).toBeNull();
    });

    it('does not answer a global binding for a project id that names no live project', async () => {
      fixture.addUser('u1');
      fixture.addProject('gone', true);
      fixture.bind('USER', 'u1', 'developer', null);

      expect(await userProjectRole(db, 'u1', 'ghost-project')).toBeNull();
      expect(await userProjectRole(db, 'u1', 'gone')).toBeNull();
    });

    it('reads the sources on every call, never from a cache', async () => {
      fixture.addUser('u1');
      fixture.addProject('p1');
      fixture.bind('USER', 'u1', 'viewer', 'p1');

      expect(await userProjectRole(db, 'u1', 'p1')).toBe('VIEWER');
      fixture.bind('USER', 'u1', 'project-admin', 'p1');
      expect(await userProjectRole(db, 'u1', 'p1')).toBe('ADMIN');
    });
  });

  describe('localProjectRole', () => {
    it('reads the legacy row for a USER and the roster row for an AGENT', async () => {
      fixture.addUser('u1');
      fixture.addAgent('a1');
      fixture.addProject('p1');
      fixture.addLegacyMember('p1', 'u1', 'AGENT');
      fixture.addRosterRow('a1', 'p1', null);

      expect(await localProjectRole(db, user('u1'), 'p1')).toBe('AGENT');
      expect(await localProjectRole(db, { type: 'AGENT', id: 'a1' }, 'p1')).toBe('VIEWER');
      expect(await localProjectRole(db, { type: 'AGENT', id: 'ghost' }, 'p1')).toBeNull();
    });

    it('takes the strongest of a legacy row and the project bindings', async () => {
      fixture.addUser('u1');
      fixture.addProject('p1');
      fixture.addLegacyMember('p1', 'u1', 'VIEWER');
      fixture.bind('USER', 'u1', 'developer', 'p1');
      fixture.bind('USER', 'u1', 'viewer', null);

      expect(await localProjectRole(db, user('u1'), 'p1')).toBe('DEVELOPER');
    });
  });

  describe('agentHasProjectAccess', () => {
    it('AC-7: a binding-only agent has access, an unknown project answers false', async () => {
      fixture.addAgent('a1');
      fixture.addProject('p1');
      fixture.bind('AGENT', 'a1', 'viewer', 'p1');

      expect(await agentHasProjectAccess(db, 'a1', 'p1')).toBe(true);
      expect(await agentHasProjectAccess(db, 'a1', 'no-such-project')).toBe(false);
    });

    it('answers false for an unknown agent and for a GLOBAL-scope binding only', async () => {
      fixture.addProject('p1');
      fixture.addAgent('a1');
      fixture.bind('AGENT', 'a1', 'agent', null);

      expect(await agentHasProjectAccess(db, 'ghost', 'p1')).toBe(false);
      expect(await agentHasProjectAccess(db, 'a1', 'p1')).toBe(false);
    });
  });

  describe('accessibleProjectIds', () => {
    it('AC-8: legacy roster row and project bindings, without soft-deleted projects', async () => {
      fixture.addAgent('a1');
      fixture.addProject('p2');
      fixture.addProject('p1');
      fixture.addProject('gone', true);
      fixture.addRosterRow('a1', 'p1', null);
      fixture.bind('AGENT', 'a1', 'viewer', 'p2');
      fixture.bind('AGENT', 'a1', 'viewer', 'gone');

      expect(await accessibleProjectIds(db, { type: 'AGENT', id: 'a1' })).toEqual(['p1', 'p2']);
    });

    it('AC-9: a global project binding answers every non-deleted project', async () => {
      fixture.addUser('u1');
      fixture.addProject('p1');
      fixture.addProject('p2');
      fixture.addProject('gone', true);
      fixture.bind('USER', 'u1', 'developer', null);

      expect(await accessibleProjectIds(db, user('u1'))).toEqual(['p1', 'p2']);
    });

    it('answers [] for a principal with no source and for an unknown principal', async () => {
      fixture.addUser('u1');
      fixture.addProject('p1');
      fixture.bind('USER', 'u1', 'admin', null);
      fixture.bind('USER', 'u1', 'developer', 'gone');

      fixture.addUser('u2');
      fixture.addProject('gone', true);
      fixture.bind('USER', 'u2', 'developer', 'gone');

      expect(await accessibleProjectIds(db, user('u1'))).toEqual([]);
      expect(await accessibleProjectIds(db, user('u2'))).toEqual([]);
      expect(await accessibleProjectIds(db, user('ghost'))).toEqual([]);
    });

    it('de-duplicates a project reached through two sources', async () => {
      fixture.addUser('u1');
      fixture.addProject('p1');
      fixture.addLegacyMember('p1', 'u1', 'DEVELOPER');
      fixture.bind('USER', 'u1', 'viewer', 'p1');

      expect(await accessibleProjectIds(db, user('u1'))).toEqual(['p1']);
    });
  });

  describe('principalIdsWithAccess', () => {
    it('AC-10: legacy rows, project bindings and global project bindings; nothing else', async () => {
      fixture.addProject('p1');
      fixture.addProject('p2');
      fixture.addUser('legacy');
      fixture.addUser('bound');
      fixture.addUser('global');
      fixture.addUser('global-admin');
      fixture.addUser('other-project');
      fixture.addLegacyMember('p1', 'legacy', 'VIEWER');
      fixture.bind('USER', 'bound', 'viewer', 'p1');
      fixture.bind('USER', 'global', 'viewer', null);
      fixture.bind('USER', 'global-admin', 'admin', null);
      fixture.bind('USER', 'other-project', 'developer', 'p2');

      expect(await principalIdsWithAccess(db, 'p1', 'USER')).toEqual(['bound', 'global', 'legacy']);
    });

    it('includes disabled users: the caller filters on disabled', async () => {
      fixture.addProject('p1');
      fixture.addUser('off', true);
      fixture.bind('USER', 'off', 'developer', 'p1');

      expect(await principalIdsWithAccess(db, 'p1', 'USER')).toEqual(['off']);
    });

    it('keeps the two principal types apart and answers [] for unknown projects', async () => {
      fixture.addProject('p1');
      fixture.addUser('u1');
      fixture.addAgent('a1');
      fixture.bind('USER', 'u1', 'developer', 'p1');
      fixture.bind('AGENT', 'a1', 'viewer', 'p1');
      fixture.addRosterRow('a1', 'p1', null);

      expect(await principalIdsWithAccess(db, 'p1', 'AGENT')).toEqual(['a1']);
      expect(await principalIdsWithAccess(db, 'p1', 'USER')).toEqual(['u1']);
      expect(await principalIdsWithAccess(db, 'ghost-project', 'USER')).toEqual([]);
    });

    it('answers [] for a project that names no row, even for a global project binding', async () => {
      fixture.addUser('u1');
      fixture.bind('USER', 'u1', 'developer', null);

      expect(await principalIdsWithAccess(db, 'ghost-project', 'USER')).toEqual([]);
    });
  });

  describe('listProjectMemberships', () => {
    it('AC-11: one entry per principal with a local source, from its earliest one', async () => {
      const earliest = new Date('2026-01-01T00:00:00.000Z');
      const later = new Date('2026-02-01T00:00:00.000Z');
      fixture.addProject('p1');
      fixture.addAgent('a1');
      fixture.addAgent('a2');
      fixture.addUser('u1');
      fixture.addRosterRow('a1', 'p1', 'u1', earliest);
      fixture.bind('AGENT', 'a1', 'viewer', 'p1', { createdAt: later });
      fixture.bind('AGENT', 'a2', 'developer', null);
      fixture.addLegacyMember('p1', 'u1', 'ADMIN', later);

      expect(await listProjectMemberships(db, 'p1', 'AGENT')).toEqual<ProjectMembership[]>([
        { principalId: 'a1', role: 'VIEWER', since: earliest, addedByUserId: 'u1' },
      ]);
      expect(await listProjectMemberships(db, 'p1', 'USER')).toEqual<ProjectMembership[]>([
        { principalId: 'u1', role: 'ADMIN', since: later, addedByUserId: null },
      ]);
    });

    it('carries the granter of an earliest binding and null for a non-user granter', async () => {
      const first = new Date('2026-01-01T00:00:00.000Z');
      const second = new Date('2026-01-02T00:00:00.000Z');
      const third = new Date('2026-01-03T00:00:00.000Z');
      fixture.addProject('p1');
      fixture.addUser('granter');
      fixture.addUser('granted');
      fixture.addUser('system-granted');
      fixture.addUser('agent-granted');
      fixture.bind('USER', 'granted', 'developer', 'p1', { grantedByType: 'USER', grantedById: 'granter', createdAt: first });
      fixture.bind('USER', 'granted', 'viewer', 'p1', { createdAt: second });
      fixture.bind('USER', 'system-granted', 'developer', 'p1', { grantedByType: 'SYSTEM', grantedById: 'invite', createdAt: second });
      fixture.bind('USER', 'agent-granted', 'developer', 'p1', { grantedByType: 'AGENT', grantedById: 'a1', createdAt: third });

      expect(await listProjectMemberships(db, 'p1', 'USER')).toEqual<ProjectMembership[]>([
        { principalId: 'granted', role: 'DEVELOPER', since: first, addedByUserId: 'granter' },
        { principalId: 'system-granted', role: 'DEVELOPER', since: second, addedByUserId: null },
        { principalId: 'agent-granted', role: 'DEVELOPER', since: third, addedByUserId: null },
      ]);
    });

    it('orders by since ascending then principalId ascending', async () => {
      fixture.addProject('p1');
      fixture.addUser('b');
      fixture.addUser('a');
      fixture.addUser('c');
      fixture.bind('USER', 'a', 'viewer', 'p1', { createdAt: new Date('2026-01-02T00:00:00.000Z') });
      fixture.bind('USER', 'b', 'viewer', 'p1', { createdAt: new Date('2026-01-01T00:00:00.000Z') });
      fixture.bind('USER', 'c', 'viewer', 'p1', { createdAt: new Date('2026-01-02T00:00:00.000Z') });

      expect((await listProjectMemberships(db, 'p1', 'USER')).map((m) => m.principalId)).toEqual(['b', 'a', 'c']);
    });

    it('ignores global project bindings and answers [] for an unknown project', async () => {
      fixture.addUser('u1');
      fixture.addProject('p1');
      fixture.bind('USER', 'u1', 'developer', null);

      expect(await listProjectMemberships(db, 'p1', 'USER')).toEqual([]);
      expect(await listProjectMemberships(db, 'ghost-project', 'USER')).toEqual([]);
      expect(await listProjectMemberships(db, 'ghost-project', 'AGENT')).toEqual([]);
    });

    it('keeps a legacy role that is not one of the three, and takes the strongest of the sources', async () => {
      fixture.addProject('p1');
      fixture.addUser('u1');
      fixture.addUser('u2');
      fixture.addLegacyMember('p1', 'u1', 'AGENT');
      fixture.bind('USER', 'u1', 'viewer', 'p1');
      fixture.addLegacyMember('p1', 'u2', 'VIEWER');
      fixture.bind('USER', 'u2', 'project-admin', 'p1');

      const memberships = await listProjectMemberships(db, 'p1', 'USER');
      expect(memberships.map((m) => [m.principalId, m.role])).toEqual([
        ['u1', 'VIEWER'],
        ['u2', 'ADMIN'],
      ]);
    });
  });

  describe('countActiveProjectAdmins', () => {
    it('AC-12: counts distinct non-disabled users with a local ADMIN source', async () => {
      fixture.addProject('p1');
      fixture.addUser('a');
      fixture.addUser('b');
      fixture.addUser('c');
      fixture.addUser('d', true);
      fixture.addUser('viewer-only');
      fixture.addLegacyMember('p1', 'a', 'ADMIN');
      fixture.bind('USER', 'b', 'project-admin', 'p1');
      fixture.addLegacyMember('p1', 'c', 'ADMIN');
      fixture.bind('USER', 'c', 'project-admin', 'p1');
      fixture.bind('USER', 'd', 'project-admin', 'p1');
      fixture.bind('USER', 'viewer-only', 'viewer', 'p1');

      expect(await countActiveProjectAdmins(db, 'p1')).toBe(3);
    });

    it('ignores a global project-admin binding, another project and unknown ids', async () => {
      fixture.addProject('p1');
      fixture.addProject('p2');
      fixture.addUser('global');
      fixture.addUser('other');
      fixture.addUser('disabled-legacy', true);
      fixture.bind('USER', 'global', 'project-admin', null);
      fixture.bind('USER', 'other', 'project-admin', 'p2');
      fixture.addLegacyMember('p1', 'disabled-legacy', 'ADMIN');

      expect(await countActiveProjectAdmins(db, 'p1')).toBe(0);
      expect(await countActiveProjectAdmins(db, 'ghost-project')).toBe(0);
    });
  });
});
