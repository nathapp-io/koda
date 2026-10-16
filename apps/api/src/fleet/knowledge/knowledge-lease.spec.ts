import { PrismaKnowledgeIndexRepository } from './prisma-knowledge-index.repository';
import type { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';

it('fences renewal by the claiming pass start time, not only running status', async () => {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const repo = new PrismaKnowledgeIndexRepository({ client: { knowledgeRepoIndex: { updateMany } } } as unknown as PrismaService<PrismaClient>);
  const startedAt = new Date('2026-10-16T00:00:00Z');
  const leaseUntil = new Date('2026-10-16T00:15:00Z');
  expect(await repo.renew('r1', leaseUntil, startedAt)).toBe(false);
  expect(updateMany).toHaveBeenCalledWith({ where: { repoId: 'r1', status: 'running', startedAt }, data: { leaseUntil } });
});
