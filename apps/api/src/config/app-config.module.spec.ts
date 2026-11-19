/**
 * US-002 AC-8 without a database: the registered `WEBHOOK_SIGNATURE_CFG` namespace, resolved through
 * the `ConfigModule.forRoot` registration `AppModule` itself imports.
 *
 * Compiling `AppConfigModule` on its own would keep passing if `AppModule` stopped importing it, so the
 * wiring is asserted from `AppModule`'s own `@Module()` metadata, and the registration this spec
 * compiles comes from that metadata too (review B3). Both assertions are DB-free: no application graph
 * is built — `ConfigModule` is instantiated alone, and every factory in the load array reads
 * `process.env`, which `test-setup.ts` fills from `.env.test`. The full boot check stays in
 * `test/integration/config/webhook-signature-config.integration.spec.ts` (`.nax/rules/api-testing.md`:
 * module wiring is a unit test).
 */
import type { DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { AppConfigModule } from './app-config.module';
import { IWebhookSignatureConfig, WEBHOOK_SIGNATURE_CFG } from './webhook-signature.config';

const SWITCHES = ['WEBHOOK_SIGNATURE_V1_ENABLED', 'CI_WEBHOOK_REQUIRE_V2'] as const;

/** What `AppModule` imports, exactly as its `@Module()` decorator recorded it. */
function appModuleImports(): unknown[] {
  return (Reflect.getMetadata('imports', AppModule) as unknown[] | undefined) ?? [];
}

/**
 * The config registration `AppModule` imports. `ConfigModule.forRoot` is async in @nestjs/config 12, so
 * `AppConfigModule` is a promise Nest resolves as an async dynamic module; this spec resolves the very
 * entry AppModule holds instead of the constant on its own.
 */
async function appModuleConfigRegistration(): Promise<DynamicModule> {
  const registration = appModuleImports().find((entry) => entry === AppConfigModule);
  if (registration === undefined) {
    throw new Error('AppModule does not import the app config registration');
  }
  const resolved = (await registration) as DynamicModule;
  expect(resolved.module).toBe(ConfigModule);
  return resolved;
}

describe('app config registration (US-002 AC-8)', () => {
  let moduleRef: TestingModule | undefined;
  const previous = SWITCHES.map((key) => [key, process.env[key]] as const);

  beforeEach(() => {
    // The defaults are the assertion: neither switch is set for this boot.
    for (const key of SWITCHES) delete process.env[key];
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('AC-8: AppModule imports the config registration that carries the signature switches', () => {
    expect(appModuleImports()).toContain(AppConfigModule);
  });

  it('AC-8: resolves the signature switches with their documented defaults', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [await appModuleConfigRegistration()],
    }).compile();

    const config = moduleRef.get(ConfigService).get<IWebhookSignatureConfig>(WEBHOOK_SIGNATURE_CFG);

    expect(config).toEqual({ v1Enabled: true, ciRequireV2: false });
  });
});
