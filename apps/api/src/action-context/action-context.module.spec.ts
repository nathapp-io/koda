/**
 * US-001 — the module wiring of the action context, without a database.
 *
 * `ActionContextModule` contributes one thing to the application: `ActionContextInterceptor` as a
 * global `APP_INTERCEPTOR`. A missing or renamed provider here would leave every request outside the
 * context and every fleet write labelled `USER`, which no unit test of the interceptor itself would
 * catch — so this spec pins the registration, that the provider is what the app metadata names, and
 * that `AppModule` imports the module.
 */
import { APP_INTERCEPTOR, ApplicationConfig, NestFactory } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { Module, type Provider } from '@nestjs/common';
import { AppModule } from '../app.module';
import { ActionContextInterceptor } from './action-context.interceptor';
import { ActionContextModule } from './action-context.module';

/** A host module for a real bootstrap: the context module is all it imports. */
@Module({ imports: [ActionContextModule] })
class HostModule {}

describe('ActionContextModule', () => {
  let module: TestingModule | undefined;

  afterEach(async () => {
    await module?.close();
    module = undefined;
  });

  it('registers ActionContextInterceptor as a global APP_INTERCEPTOR', () => {
    const providers = Reflect.getMetadata('providers', ActionContextModule) as Provider[];

    expect(providers).toEqual([{ provide: APP_INTERCEPTOR, useClass: ActionContextInterceptor }]);
  });

  it('compiles, instantiating the interceptor the global registration names', async () => {
    module = await Test.createTestingModule({ imports: [ActionContextModule] }).compile();

    expect(module).toBeDefined();
  });

  it('is applied to the application config of a booted application, so it runs on every route', async () => {
    const app = await NestFactory.createApplicationContext(HostModule, { logger: false });

    try {
      expect(app.get(ApplicationConfig).getGlobalInterceptors()).toEqual([
        expect.any(ActionContextInterceptor),
      ]);
    } finally {
      await app.close();
    }
  });

  it('is imported by AppModule, so the interceptor is global', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];

    expect(imports).toContain(ActionContextModule);
  });
});
