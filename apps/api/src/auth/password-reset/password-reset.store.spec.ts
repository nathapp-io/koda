import { PasswordResetTokenStore } from './password-reset-token.store';
import { PrismaPasswordResetRepository } from './prisma-password-reset.repository';
import { PASSWORD_RESET_TTL_MS } from './password-reset.constants';

describe('password reset store', () => {
  it('AC-6: expires in 30 minutes', () => expect(PASSWORD_RESET_TTL_MS).toBe(1_800_000));
  it('delegates all operations to its repository', async () => {
    const repo = { replaceUnused: vi.fn(), findByHash: vi.fn(), markUsed: vi.fn(), deleteUnusedOf: vi.fn() };
    const store = new PasswordResetTokenStore(repo as never);
    const now = new Date();
    await store.replaceUnused('u', 'h', now); await store.findByHash('h'); await store.markUsed('i', now); await store.discardUnusedFor('u');
    expect(repo.replaceUnused).toHaveBeenCalledWith('u', 'h', now);
    expect(repo.findByHash).toHaveBeenCalledWith('h');
    expect(repo.markUsed).toHaveBeenCalledWith('i', now);
    expect(repo.deleteUnusedOf).toHaveBeenCalledWith('u');
  });
  it('serializes replacement on the user row within the transaction', async () => {
    const steps: string[] = [];
    const client = { $queryRaw: vi.fn(async () => { steps.push('lock'); }), passwordResetToken: {
      deleteMany: vi.fn(async () => { steps.push('delete'); return { count: 1 }; }),
      create: vi.fn(async () => { steps.push('create'); }),
    } };
    const tx = { run: async (fn: () => Promise<void>) => { steps.push('begin'); await fn(); steps.push('commit'); } };
    const repo = new PrismaPasswordResetRepository(tx as never, { client } as never);
    const expiry = new Date();
    await repo.replaceUnused('u', 'h', expiry);
    expect(steps).toEqual(['begin', 'lock', 'delete', 'create', 'commit']);
    expect(client.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u', usedAt: null } });
    expect(client.passwordResetToken.create).toHaveBeenCalledWith({ data: { userId: 'u', tokenHash: 'h', expiresAt: expiry } });
  });
});
