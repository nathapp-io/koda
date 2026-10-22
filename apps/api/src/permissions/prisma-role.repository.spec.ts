import { describe, expect, it, vi } from 'vitest';
import { PrismaRoleRepository } from './prisma-role.repository';

interface Row {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: 'GLOBAL' | 'PROJECT';
  system: boolean;
  locked: boolean;
  permissions: string[];
}

const row = (key: string, over: Partial<Row> = {}): Row => ({
  id: key, key, name: key, description: '', scope: 'PROJECT', system: false, locked: false, permissions: [], ...over,
});

/** A `role.findMany` that honours the `where` (system, scope, key > cursor), `orderBy` key and `take`. */
function setup(rows: Row[]) {
  const findMany = vi.fn(async (args: {
    where?: { system?: boolean; scope?: string; key?: { gt: string } }
    take?: number
  }) => rows
    .filter((r) => args.where?.system === undefined || r.system === args.where.system)
    .filter((r) => args.where?.scope === undefined || r.scope === args.where.scope)
    .filter((r) => args.where?.key === undefined || r.key > args.where.key.gt)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, args.take ?? rows.length));
  const repo = new PrismaRoleRepository({} as never, { client: { role: { findMany } } } as never);
  return { repo, findMany };
}

describe('PrismaRoleRepository.findRoles', () => {
  it('answers every role past 500, system roles first then by key', async () => {
    const custom = Array.from({ length: 1203 }, (_, i) => row(`r-${String(i).padStart(5, '0')}`, { scope: i % 2 === 0 ? 'GLOBAL' : 'PROJECT' }));
    const system = [row('owner', { system: true, locked: true }), row('developer', { system: true })];
    const { repo, findMany } = setup([...custom, ...system]);

    const roles = await repo.findRoles();

    expect(roles).toHaveLength(1205);
    expect(roles.slice(0, 2).map((r) => r.key)).toEqual(['developer', 'owner']);
    expect(roles.slice(2).map((r) => r.key)).toEqual(custom.map((r) => r.key));
    expect(findMany.mock.calls.every(([args]) => (args.take ?? 0) <= 500)).toBe(true);
  });

  it('reads a role that sorts beyond the 500th position', async () => {
    const custom = Array.from({ length: 600 }, (_, i) => row(`a-${String(i).padStart(4, '0')}`));
    const { repo } = setup([...custom, row('zzz-last')]);

    const roles = await repo.findRoles();

    expect(roles.map((r) => r.key)).toContain('zzz-last');
  });
});
