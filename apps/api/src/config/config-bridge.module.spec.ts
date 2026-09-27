/**
 * US-001 AC11: `ConfigBridgeModule` exposes `WEBHOOK_CFG`.
 *
 * Module-compilation and DI-wiring checks are unit tests (`.nax/rules/api-testing.md`):
 * no database, no HTTP — a testing module over `ConfigModule.forRoot({
 * load: [webhookConfig], ignoreEnvFile: true })` and `ConfigBridgeModule`.
 *
 * Two deliberate departures from the AC's literal snippet, neither of which weakens the
 * assertion on `WEBHOOK_CFG`:
 * - `isGlobal: true`, so the `ConfigService` injected by `ConfigBridgeModule` resolves.
 * - the sibling config factories are in the `load` array because `ConfigBridgeModule`'s
 *   existing providers (APP_CFG, AUTH_CFG, …) are instantiated eagerly at compile time
 *   and throw when their own config is not loaded.
 */
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigBridgeModule } from './config-bridge.module';
import { appConfig } from './app.config';
import { authConfig } from './auth.config';
import { ragConfig } from './rag.config';
import { vcsConfig } from './vcs.config';
import { liveConfig } from './live.config';
import { IWebhookConfig, WEBHOOK_CFG, webhookConfig } from './webhook.config';

/**
 * The resolved config, or the error that stopped the module from coming up / the token
 * from resolving. Capturing instead of throwing keeps every failure an assertion failure
 * (`expect(wiringError).toBeUndefined()`) while still reporting the underlying error.
 */
interface Resolution {
  cfg?: IWebhookConfig;
  wiringError?: unknown;
}

describe('US-001 AC11: ConfigBridgeModule WEBHOOK_CFG', () => {
  let moduleRef: TestingModule | undefined;
  const savedAllowedHosts = process.env['WEBHOOK_ALLOWED_HOSTS'];

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined;
    }
    if (savedAllowedHosts === undefined) delete process.env['WEBHOOK_ALLOWED_HOSTS'];
    else process.env['WEBHOOK_ALLOWED_HOSTS'] = savedAllowedHosts;
  });

  /** Boots the AC11 module shape and resolves WEBHOOK_CFG. */
  async function resolveWebhookCfg(): Promise<Resolution> {
    try {
      moduleRef = await Test.createTestingModule({
        imports: [
          await ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [appConfig, authConfig, ragConfig, vcsConfig, liveConfig, webhookConfig],
          }),
          ConfigBridgeModule,
        ],
      }).compile();
    } catch (error) {
      return { wiringError: error };
    }

    // `strict: false` returns undefined for an unregistered token instead of throwing,
    // so a missing WEBHOOK_CFG provider surfaces as the assertion below.
    return { cfg: moduleRef.get<IWebhookConfig>(WEBHOOK_CFG, { strict: false }) };
  }

  it('AC11: WEBHOOK_CFG resolves to the loaded webhook config with the parsed allowlist', async () => {
    process.env['WEBHOOK_ALLOWED_HOSTS'] = 'hooks.internal';

    const { cfg, wiringError } = await resolveWebhookCfg();

    expect(wiringError).toBeUndefined();
    expect(cfg?.allowedHostnames).toEqual(['hooks.internal']);
    expect(cfg?.deliveryTimeoutMs).toBe(5000);
  });

  it('AC11 boundary: WEBHOOK_CFG resolves to an empty allowlist when WEBHOOK_ALLOWED_HOSTS is unset', async () => {
    delete process.env['WEBHOOK_ALLOWED_HOSTS'];

    const { cfg, wiringError } = await resolveWebhookCfg();

    expect(wiringError).toBeUndefined();
    expect(cfg?.allowedHostnames).toEqual([]);
    expect(cfg?.allowedCidrs).toEqual([]);
  });
});
