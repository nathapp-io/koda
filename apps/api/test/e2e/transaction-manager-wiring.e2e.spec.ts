/**
 * E2E wiring test: verifies that TRANSACTION_MANAGER is correctly provided
 * by PrismaModule.forRoot({ transaction: true }) when AppModule is bootstrapped,
 * and that all repositories extending AbstractPrismaRepository can be resolved.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaCommentRepository } from '../../src/comments/prisma-comment.repository';
import { PrismaMemoryItemRepository } from '../../src/memory/prisma-memory-item.repository';
import { PrismaOutboxRepository } from '../../src/outbox/prisma-outbox.repository';

describe('Transaction Manager Wiring (E2E)', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
  });

  it('TRANSACTION_MANAGER token is resolvable from AppModule', () => {
    const txManager = module.get(TRANSACTION_MANAGER, { strict: false });
    expect(txManager).toBeDefined();
    expect(typeof txManager.run).toBe('function');
  });

  it('PrismaCommentRepository (AbstractPrismaRepository) is resolvable', () => {
    const repo = module.get(PrismaCommentRepository, { strict: false });
    expect(repo).toBeInstanceOf(PrismaCommentRepository);
  });

  it('PrismaMemoryItemRepository (AbstractPrismaRepository) is resolvable', () => {
    const repo = module.get(PrismaMemoryItemRepository, { strict: false });
    expect(repo).toBeInstanceOf(PrismaMemoryItemRepository);
  });

  it('PrismaOutboxRepository (AbstractPrismaRepository) is resolvable', () => {
    const repo = module.get(PrismaOutboxRepository, { strict: false });
    expect(repo).toBeInstanceOf(PrismaOutboxRepository);
  });
});
