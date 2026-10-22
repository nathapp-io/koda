import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaProjectAssigneesRepository } from './prisma-project-assignees.repository';

const transactionManager = {
  run: <T>(fn: () => Promise<T>) => fn(),
  getClient: () => ({}),
  isInTransaction: () => false,
} as unknown as ITransactionManager;

const PROJECT_ID = 'proj-1';

interface UserRow {
  id: string;
  name: string | null;
  email: string;
  disabled?: boolean;
}

interface AgentRow {
  id: string;
  name: string;
  slug: string;
  status: string;
}

/** The rows the fake database holds, and which of them the project reaches. */
interface Fixtures {
  /** Every user row; `user.findMany` answers the requested ids from it. */
  users?: UserRow[];
  /** Every agent row. */
  agents?: AgentRow[];
  /** PROJECT-scope bindings in the project, by principal type. */
  bindings?: { user?: string[]; agent?: string[] };
  /** `projectId`-null PROJECT-scope bindings, by principal type. */
  globalBindings?: { user?: string[]; agent?: string[] };
}

interface FindManyArgs {
  where: {
    id: { in: string[] };
    disabled?: boolean;
    principalType?: string;
    projectId?: string | null;
    OR?: unknown;
  };
  take?: number;
  orderBy?: unknown;
  select?: unknown;
}

/** Binding reads determine candidate ids before the bounded account detail reads. */
const repositoryWith = (fixtures: Fixtures) => {
  const bindingFindMany = vi.fn(async (args: FindManyArgs) => {
    const { principalType, projectId } = args.where;
    const table = projectId === null ? fixtures.globalBindings : fixtures.bindings;
    const ids = (principalType === 'USER' ? table?.user : table?.agent) ?? [];
    return ids.map((principalId) => ({ principalId }));
  });
  const userFindMany = vi.fn(async (args: FindManyArgs) =>
    (fixtures.users ?? [])
      .filter((user) => args.where.id.in.includes(user.id))
      .filter((user) => args.where.disabled !== false || user.disabled !== true)
      .map(({ id, name, email }) => ({ id, name, email })),
  );
  const agentFindMany = vi.fn(async (args: FindManyArgs) =>
    (fixtures.agents ?? [])
      .filter((agent) => args.where.id.in.includes(agent.id))
      .map(({ id, name, slug, status }) => ({ id, name, slug, status })),
  );

  const prisma = {
    client: {
      roleBinding: { findMany: bindingFindMany },
      user: { findMany: userFindMany },
      agent: { findMany: agentFindMany },
      project: { count: vi.fn(async () => 1) },
    },
  };

  return {
    repository: new PrismaProjectAssigneesRepository(
      transactionManager,
      prisma as unknown as PrismaService<PrismaClient>,
    ),
    bindingFindMany,
    userFindMany,
    agentFindMany,
  };
};

describe('PrismaProjectAssigneesRepository.search', () => {
  it('reads non-disabled users whose id has access to the project only', async () => {
    const { repository, userFindMany } = repositoryWith({
      bindings: { user: ['u1'] },
      users: [{ id: 'u1', name: 'Alice', email: 'alice@koda.test' }],
    });

    const items = await repository.search(PROJECT_ID, '', 20);

    expect(userFindMany.mock.calls[0][0].where).toEqual({ id: { in: ['u1'] }, disabled: false });
    expect(userFindMany.mock.calls[0][0].take).toBe(20);
    expect(items).toEqual([{ type: 'user', id: 'u1', name: 'Alice', secondary: 'alice@koda.test' }]);
  });

  it('falls back to the email when a user has no name', async () => {
    const { repository } = repositoryWith({
      bindings: { user: ['u1'] },
      users: [{ id: 'u1', name: null, email: 'alice@koda.test' }],
    });

    const [user] = await repository.search(PROJECT_ID, '', 20);

    expect(user.name).toBe('alice@koda.test');
  });

  it('offers a user whose only source in the project is a PROJECT-scope binding', async () => {
    const { repository, bindingFindMany } = repositoryWith({
      users: [{ id: 'u1', name: 'Bound', email: 'bound@koda.test' }],
      bindings: { user: ['u1'] },
    });

    const items = await repository.search(PROJECT_ID, '', 20);

    expect(bindingFindMany.mock.calls.some(([args]) => args.where.projectId === PROJECT_ID)).toBe(true);
    expect(items).toEqual([{ type: 'user', id: 'u1', name: 'Bound', secondary: 'bound@koda.test' }]);
  });

  it('offers a user whose only source is a projectId-null binding', async () => {
    const { repository, userFindMany } = repositoryWith({
      users: [{ id: 'u1', name: 'Everywhere', email: 'everywhere@koda.test' }],
      globalBindings: { user: ['u1'] },
    });

    const items = await repository.search(PROJECT_ID, '', 20);

    expect(userFindMany.mock.calls[0][0].where).toEqual({ id: { in: ['u1'] }, disabled: false });
    expect(items).toEqual([
      { type: 'user', id: 'u1', name: 'Everywhere', secondary: 'everywhere@koda.test' },
    ]);
  });

  it('never offers a disabled user, even when a binding is its source', async () => {
    const { repository, userFindMany } = repositoryWith({
      users: [{ id: 'u1', name: 'Disabled', email: 'disabled@koda.test', disabled: true }],
      bindings: { user: ['u1'] },
    });

    const items = await repository.search(PROJECT_ID, '', 20);

    expect(userFindMany.mock.calls[0][0].where.disabled).toBe(false);
    expect(items).toEqual([]);
  });

  it('offers only agents with an access source and an ACTIVE or PAUSED status, carrying the status', async () => {
    const { repository, agentFindMany } = repositoryWith({
      agents: [{ id: 'a1', name: 'alias-bot', slug: 'alias-bot', status: 'PAUSED' }],
      bindings: { agent: ['a1'] },
    });

    const items = await repository.search(PROJECT_ID, '', 20);

    expect(agentFindMany.mock.calls[0][0].where).toEqual({
      id: { in: ['a1'] },
      status: { in: ['ACTIVE', 'PAUSED'] },
    });
    expect(items).toEqual([
      { type: 'agent', id: 'a1', name: 'alias-bot', secondary: 'alias-bot', status: 'PAUSED' },
    ]);
  });

  it('matches q case-insensitively on name or email (users) and name or slug (agents)', async () => {
    const { repository, userFindMany, agentFindMany } = repositoryWith({});

    await repository.search(PROJECT_ID, 'ALI', 20);

    expect(userFindMany.mock.calls[0][0].where).toEqual({
      id: { in: [] },
      disabled: false,
      OR: [
        { name: { contains: 'ALI', mode: 'insensitive' } },
        { email: { contains: 'ALI', mode: 'insensitive' } },
      ],
    });
    expect(agentFindMany.mock.calls[0][0].where).toEqual({
      id: { in: [] },
      status: { in: ['ACTIVE', 'PAUSED'] },
      OR: [
        { name: { contains: 'ALI', mode: 'insensitive' } },
        { slug: { contains: 'ALI', mode: 'insensitive' } },
      ],
    });
  });

  it('adds no name filter for an empty q', async () => {
    const { repository, userFindMany, agentFindMany } = repositoryWith({});

    await repository.search(PROJECT_ID, '', 20);

    expect(userFindMany.mock.calls[0][0].where.OR).toBeUndefined();
    expect(agentFindMany.mock.calls[0][0].where.OR).toBeUndefined();
  });

  it('puts every user before every agent and caps the combined list at limit', async () => {
    const { repository } = repositoryWith({
      bindings: { user: ['u1'], agent: ['a1'] },
      users: [{ id: 'u1', name: 'Alice', email: 'alice@koda.test' }],
      agents: [{ id: 'a1', name: 'a-bot', slug: 'a-bot', status: 'ACTIVE' }],
    });

    const items = await repository.search(PROJECT_ID, '', 2);

    expect(items.map((item) => item.type)).toEqual(['user', 'agent']);

    const capped = await repository.search(PROJECT_ID, '', 1);
    expect(capped).toHaveLength(1);
    expect(capped[0].type).toBe('user');
  });

  it('orders each group by name', async () => {
    const { repository, userFindMany, agentFindMany } = repositoryWith({});

    await repository.search(PROJECT_ID, '', 20);

    expect(userFindMany.mock.calls[0][0].orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
    expect(agentFindMany.mock.calls[0][0].orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
  });
});
