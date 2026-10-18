/**
 * Permissions P1a US-004 — the owner bootstrap's configuration surface (AC-1 .. AC-4).
 *
 * `bun run test` runs without a database, so the production fail-fast must surface here rather than in
 * a DB-backed suite (`.nax/rules/api-testing.md`: module wiring is a unit test).
 */
import { Global, Module, Type } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from '@nathapp/nestjs-cache';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AUTH_CFG, IAuthConfig, authConfig } from '../config/auth.config';
import { restoreEnvAfterEach } from '../common/test-helpers/restore-env';
import { PermissionsModule } from './permissions.module';
import { SYSTEM_ROLES_SEED } from './permissions.tokens';
import type { RoleSeed } from './permissions.types';
import type { PrismaClient } from '../generated/prisma/client';

const OWNER_EMAIL_ENV = 'KODA_OWNER_EMAIL';

/** What `PermissionsModule.onModuleInit` must throw in production without an owner email. */
const OWNER_EMAIL_REQUIRED = 'permissions.ownerEmailRequired';

const baseAuthConfig: IAuthConfig = {
  jwtSecret: 'test-secret',
  jwtExpiresIn: '15m',
  jwtRefreshSecret: 'test-refresh-secret',
  jwtRefreshExpiresIn: '7d',
  apiKeySecret: 'test-api-key-secret',
  registrationEnabled: false,
};

/** What the application registers globally: `PrismaModule.forRoot({ isGlobal: true })` and `CacheModule`. */
function stubsFor(authCfg: IAuthConfig): Type<unknown> {
  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: { client: {} } as unknown as PrismaService<PrismaClient> },
      {
        provide: TRANSACTION_MANAGER,
        useValue: {
          run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
          getClient: () => undefined,
          isInTransaction: () => false,
        } as ITransactionManager,
      },
      { provide: CacheManager, useValue: { get: vi.fn(), set: vi.fn(), invalidate: vi.fn() } },
      { provide: AUTH_CFG, useValue: authCfg },
    ],
    exports: [PrismaService, TRANSACTION_MANAGER, CacheManager, AUTH_CFG],
  })
  class PermissionStubsModule {}

  return PermissionStubsModule;
}

describe('authConfig ownerEmail (US-004)', () => {
  restoreEnvAfterEach();

  it("AC-1: KODA_OWNER_EMAIL='Owner@Koda.test ' resolves to 'owner@koda.test'", () => {
    process.env[OWNER_EMAIL_ENV] = 'Owner@Koda.test ';

    expect(authConfig().ownerEmail).toBe('owner@koda.test');
  });

  it('AC-2: ownerEmail is undefined when KODA_OWNER_EMAIL is unset', () => {
    delete process.env[OWNER_EMAIL_ENV];

    expect(authConfig().ownerEmail).toBeUndefined();
  });

  it('treats a blank value as unset', () => {
    process.env[OWNER_EMAIL_ENV] = '   ';

    expect(authConfig().ownerEmail).toBeUndefined();
  });

  it('rejects a value that is not an email at boot', () => {
    process.env[OWNER_EMAIL_ENV] = 'not-an-email';

    expect(() => authConfig()).toThrow();
  });
});

describe('PermissionsModule owner-email fail-fast (US-004)', () => {
  restoreEnvAfterEach();
  let moduleRef: TestingModule | undefined;

  const build = (authCfg: IAuthConfig): Promise<TestingModule> =>
    Test.createTestingModule({ imports: [stubsFor(authCfg), PermissionsModule] })
      // The seeded roles are irrelevant here; an empty seed keeps the module's other lifecycle work out.
      .overrideProvider(SYSTEM_ROLES_SEED)
      .useValue([] as readonly RoleSeed[])
      .compile();

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  /** The rejection `init()` produced, or null when it booted. Kept compact for the failure output. */
  const bootOutcome = async (ref: TestingModule): Promise<unknown> =>
    ref.init().then(
      () => null,
      (error: unknown) => error,
    );

  it('AC-3: NODE_ENV=production without an owner email refuses to start', async () => {
    process.env['NODE_ENV'] = 'production';
    // Deliberately not assigned to `moduleRef`: a context whose `init()` rejected keeps the rejection
    // in `initializationPromise` and `close()` re-awaits it, so there would be nothing to release —
    // only the same error to re-throw. Every provider here is a stub.
    const ref = await build(baseAuthConfig);

    const failure = await bootOutcome(ref);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(OWNER_EMAIL_REQUIRED);
  });

  it('AC-4: NODE_ENV=production with an owner email starts', async () => {
    process.env['NODE_ENV'] = 'production';
    moduleRef = await build({ ...baseAuthConfig, ownerEmail: 'owner@koda.test' });

    expect(await bootOutcome(moduleRef)).toBeNull();
  });

  it('needs no owner email outside production', async () => {
    process.env['NODE_ENV'] = 'development';
    moduleRef = await build(baseAuthConfig);

    expect(await bootOutcome(moduleRef)).toBeNull();
  });
});
