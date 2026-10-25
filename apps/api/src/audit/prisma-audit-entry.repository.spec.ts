import { describe, expect, it, vi } from 'vitest';
import { PrismaAuditEntryRepository as Repository } from './prisma-audit-entry.repository';

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

/**
 * A Prisma client whose every model delegate records the `findMany`-style call it receives, so a
 * projection test can assert exactly which tables were read — and which were not.
 */
function fakePrismaClient(rows: Record<string, unknown[]> = {}) {
  const calls: RecordedCall[] = [];
  const delegate = (model: string) => new Proxy({}, {
    get: (_target, method: string | symbol) => {
      if (typeof method !== 'string') return undefined;
      return (args: unknown) => {
        calls.push({ model, method, args });
        return Promise.resolve(rows[model] ?? []);
      };
    },
  });
  const client = new Proxy({}, {
    get: (_target, model: string | symbol) => (typeof model === 'string' ? delegate(model) : undefined),
  });
  const prisma = { client, isConnected: true, onModuleInit: vi.fn(), onModuleDestroy: vi.fn() };
  const tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false) };
  const repo = new Repository(tx as never, prisma as never);
  return { repo, calls, prisma };
}

describe('PrismaAuditEntryRepository.findDisplayNames', () => {
  it('AC-14: reads no table but User when only user ids are asked for', async () => {
    const { repo, calls } = fakePrismaClient({ user: [{ id: 'u1', name: 'Ada', email: 'ada@koda.test' }] });
    const names = await repo.findDisplayNames({ userIds: ['u1'], agentIds: [], runnerIds: [], projectIds: [] });
    expect(calls.map((call) => `${call.model}.${call.method}`)).toEqual(['user.findMany']);
    expect(calls[0].args).toEqual({ where: { id: { in: ['u1'] } }, select: { id: true, name: true, email: true } });
    expect(names.users).toEqual(new Map([['u1', 'Ada']]));
  });

  it('issues one findMany per non-empty kind and none for the empty ones', async () => {
    const { repo, calls } = fakePrismaClient();
    await repo.findDisplayNames({ userIds: ['u1'], agentIds: ['a1'], runnerIds: [], projectIds: ['p1'] });
    expect(calls.map((call) => `${call.model}.${call.method}`)).toEqual(['user.findMany', 'agent.findMany', 'project.findMany']);
  });

  it('keys every map by id and selects only the label columns', async () => {
    const { repo, calls } = fakePrismaClient({
      user: [{ id: 'u1', name: 'Ada', email: 'ada@koda.test' }],
      agent: [{ id: 'a1', name: 'robot' }],
      runner: [{ id: 'r1', name: 'wk-mac' }],
      project: [{ id: 'p1', slug: 'ops', name: 'Operations' }],
    });
    const names = await repo.findDisplayNames({ userIds: ['u1'], agentIds: ['a1'], runnerIds: ['r1'], projectIds: ['p1'] });
    expect(names).toEqual({
      users: new Map([['u1', 'Ada']]),
      agents: new Map([['a1', 'robot']]),
      runners: new Map([['r1', 'wk-mac']]),
      projects: new Map([['p1', { slug: 'ops', name: 'Operations' }]]),
    });
    expect(calls.map((call) => (call.args as { select: unknown }).select)).toEqual([
      { id: true, name: true, email: true },
      { id: true, name: true },
      { id: true, name: true },
      { id: true, slug: true, name: true },
    ]);
  });

  it('falls back to the email when a user name is null or blank', async () => {
    const { repo } = fakePrismaClient({
      user: [
        { id: 'u1', name: null, email: 'one@koda.test' },
        { id: 'u2', name: '   ', email: 'two@koda.test' },
        { id: 'u3', name: ' Ada ', email: 'three@koda.test' },
      ],
    });
    const names = await repo.findDisplayNames({ userIds: ['u1', 'u2', 'u3'], agentIds: [], runnerIds: [], projectIds: [] });
    expect(names.users).toEqual(new Map([['u1', 'one@koda.test'], ['u2', 'two@koda.test'], ['u3', 'Ada']]));
  });

  it('leaves ids with no row unresolved and resolves a soft-deleted project', async () => {
    const { repo, calls } = fakePrismaClient({ project: [{ id: 'p1', slug: 'ops', name: 'Operations' }] });
    const names = await repo.findDisplayNames({ userIds: ['ghost'], agentIds: [], runnerIds: [], projectIds: ['p1', 'ghost'] });
    expect(names.users.size).toBe(0);
    expect(names.projects).toEqual(new Map([['p1', { slug: 'ops', name: 'Operations' }]]));
    // No deletedAt filter: history resolves a project the user has since deleted.
    expect((calls[1].args as { where: unknown }).where).toEqual({ id: { in: ['p1', 'ghost'] } });
  });

  it('propagates a read failure instead of answering a partial page', async () => {
    const error = new Error('database unavailable');
    const client = new Proxy({}, { get: () => ({ findMany: vi.fn().mockRejectedValue(error) }) });
    const repo = new Repository(
      { run: vi.fn(), getClient: vi.fn(), isInTransaction: vi.fn() } as never,
      { client, isConnected: true, onModuleInit: vi.fn(), onModuleDestroy: vi.fn() } as never,
    );
    await expect(repo.findDisplayNames({ userIds: ['u1'], agentIds: [], runnerIds: [], projectIds: [] })).rejects.toBe(error);
  });
});
