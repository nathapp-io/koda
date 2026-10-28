import { ActorPrincipalLoader, ActorUnavailableError } from './actor-principal.loader';
import type { PrismaAuthRepository } from '../prisma-auth.repository';
import { runWithActionContext } from '../../action-context/action-context';

describe('ActorPrincipalLoader', () => {
  const repository = {
    findUserById: vi.fn(),
    hasGlobalAdminBinding: vi.fn(),
    findAgentById: vi.fn(),
  };
  const loader = new ActorPrincipalLoader(repository as unknown as PrismaAuthRepository);

  beforeEach(() => vi.resetAllMocks());

  it('rebuilds a user principal and derives its role from global bindings', async () => {
    repository.findUserById.mockResolvedValue({ id: 'u1', email: 'human@example.test', disabled: false });
    repository.hasGlobalAdminBinding.mockResolvedValue(true);
    await expect(loader.load({ type: 'USER', id: 'u1' })).resolves.toEqual({
      actorType: 'user', id: 'u1', name: 'human@example.test', email: 'human@example.test', role: 'ADMIN',
      blacklisted: false, revoked: false, authorities: ['ADMIN'],
      extra: { sub: 'u1', email: 'human@example.test', role: 'ADMIN' },
    });
  });

  it('rebuilds a non-admin user as MEMBER', async () => {
    repository.findUserById.mockResolvedValue({ id: 'u1', email: 'member@example.test', disabled: false });
    repository.hasGlobalAdminBinding.mockResolvedValue(false);
    expect(await loader.load({ type: 'USER', id: 'u1' })).toMatchObject({ actorType: 'user', role: 'MEMBER', revoked: false });
  });

  it.each([
    ['disabled user', { type: 'USER', id: 'u1' } as const, () => repository.findUserById.mockResolvedValue({ id: 'u1', email: 'x', disabled: true })],
    ['missing user', { type: 'USER', id: 'missing' } as const, () => repository.findUserById.mockResolvedValue(null)],
    ['paused agent', { type: 'AGENT', id: 'a1' } as const, () => repository.findAgentById.mockResolvedValue({ id: 'a1', slug: 'bot', status: 'PAUSED', apiKeyHash: 'hash' })],
    ['missing agent', { type: 'AGENT', id: 'missing' } as const, () => repository.findAgentById.mockResolvedValue(null)],
  ])('rejects a %s', async (_label, actor, arrange) => {
    arrange();
    await expect(loader.load(actor)).rejects.toBeInstanceOf(ActorUnavailableError);
  });

  it('rebuilds an active agent without loading capabilities', async () => {
    repository.findAgentById.mockResolvedValue({ id: 'a1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'hash' });
    await expect(loader.load({ type: 'AGENT', id: 'a1' })).resolves.toEqual({
      actorType: 'agent', id: 'a1', name: 'bot', slug: 'bot', status: 'ACTIVE', capabilities: [],
      blacklisted: false, revoked: false, authorities: [], extra: { slug: 'bot' },
    });
  });

  it('AC-7: refuses SYSTEM context without consulting the repository', async () => {
    await runWithActionContext({ actor: { type: 'SYSTEM', id: 'assistant' }, origin: 'system' }, async () => {
      await expect(loader.forContext()).rejects.toBeInstanceOf(ActorUnavailableError);
    });
    expect(repository.findUserById).not.toHaveBeenCalled();
    expect(repository.findAgentById).not.toHaveBeenCalled();
  });

  it('AC-8: refuses when there is no action context', async () => {
    await expect(loader.forContext()).rejects.toBeInstanceOf(ActorUnavailableError);
  });

  it('AC-9: preserves the error prototype and actor payload', () => {
    const actor = { type: 'AGENT', id: 'a1' };
    const error = new ActorUnavailableError(actor);
    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(ActorUnavailableError.prototype);
    expect(error.actor).toEqual(actor);
    expect(error.name).toBe('ActorUnavailableError');
  });
});
