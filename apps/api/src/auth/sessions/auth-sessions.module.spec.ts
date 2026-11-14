import { Test, TestingModule } from '@nestjs/testing';
import { Global, Module } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AUTH_SESSION_REPOSITORY } from './auth-session.domain';
import { AuthSessionService } from './auth-session.service';
import { AuthSessionsModule } from './auth-sessions.module';
import { PrismaAuthSessionRepository } from './prisma-auth-session.repository';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * auth-sessions US-001 — the module's DI contract, without a database.
 *
 * `bun run test` runs without Postgres, so the wiring the follow-up stories depend on must be checked
 * here: the repository sits behind its private token, the service resolves, and the module exports the
 * service and nothing else (a leaked repository or token is the `memory.module.ts` drift this story
 * deliberately avoids).
 */

const mockTransactionManager: ITransactionManager = {
  run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  getClient: () => ({}) as never,
  isInTransaction: () => false,
};

const mockPrismaService = { client: {} } as unknown as PrismaService<PrismaClient>;

/** What `PrismaModule.forRoot({ isGlobal: true })` provides in the application. */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: mockPrismaService },
    { provide: TRANSACTION_MANAGER, useValue: mockTransactionManager },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER],
})
class PrismaStubsModule {}

describe('AuthSessionsModule', () => {
  let moduleRef: TestingModule;

  const build = (): Promise<TestingModule> =>
    Test.createTestingModule({ imports: [PrismaStubsModule, AuthSessionsModule] }).compile();

  afterEach(async () => {
    await moduleRef?.close();
  });

  // auth-sessions US-002 AC-10: the module compiles from a mocked Prisma/transaction layer and resolves
  // `AuthSessionService` — the wiring `AuthModule` depends on, proven without a database.
  it('US-002 AC-10: compiles without a database and resolves AuthSessionService', async () => {
    moduleRef = await build();

    expect(moduleRef.get(AuthSessionService)).toBeInstanceOf(AuthSessionService);
  });

  it('registers the repository behind its private token and resolves the service', async () => {
    moduleRef = await build();

    expect(moduleRef.get(AUTH_SESSION_REPOSITORY)).toBeInstanceOf(PrismaAuthSessionRepository);
    expect(moduleRef.get(AuthSessionService)).toBeInstanceOf(AuthSessionService);
  });

  it('exports AuthSessionService only', () => {
    const exported: unknown[] = Reflect.getMetadata('exports', AuthSessionsModule) ?? [];

    expect(exported).toEqual([AuthSessionService]);
  });
});
