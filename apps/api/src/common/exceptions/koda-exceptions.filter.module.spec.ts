/**
 * S4c US-003 — the wiring that installs `KodaExceptionsFilter`.
 *
 * The filter only matters if `NathApplication.useAppGlobalFilters()` (the call
 * `main.ts` and every HTTP test harness make) actually installs the instance
 * `AppModule` provides under the `GlobalExceptionsFilter` token, rather than the
 * library building its own. Nothing else would notice a regression here: the
 * response would still be a 409 with the translated sentence, only without the
 * `data.key` / `data.args` the clients read.
 *
 * The spec therefore boots a module through the production call and asserts the
 * wire bytes, with a provider-less module as the control.
 */
import { Controller, Get, Module } from '@nestjs/common';
import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { AppFactory } from '@nathapp/nestjs-app';
import { GlobalExceptionsFilter, I18nCoreModule } from '@nathapp/nestjs-common';
import { join } from 'node:path';
import request from 'supertest';
import { ConflictAppException } from './conflict-app.exception';
import { KodaExceptionsFilter } from './koda-exceptions.filter';

/** apps/api/src/i18n — the directory `AppModule` configures the loader with. */
const I18N_RESOURCES_PATH = join(__dirname, '../../i18n');

const i18n = () =>
  I18nCoreModule.forRoot({
    fallbackLanguage: 'en',
    loaderOptions: { path: I18N_RESOURCES_PATH, watch: false },
  });

@Controller('wiring')
class WiringController {
  @Get('refusal')
  refuse(): void {
    throw new ConflictAppException({ count: 2, refs: 'ALP-3,ALP-4' }, 'projectAgents.hasOpenTickets');
  }
}

@Module({
  imports: [i18n()],
  controllers: [WiringController],
  providers: [{ provide: GlobalExceptionsFilter, useClass: KodaExceptionsFilter }],
})
class WiredModule {}

/** Control: the same refusal with nothing registered under the filter token. */
@Module({ imports: [i18n()], controllers: [WiringController] })
class UnwiredModule {}

describe('KodaExceptionsFilter module wiring (S4c US-003)', () => {
  let app: INestApplication;

  const boot = async (imports: Array<Type<unknown> | DynamicModule>): Promise<request.Response> => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports }).compile();
    app = moduleRef.createNestApplication();
    AppFactory.useApp(app).useAppGlobalFilters();
    await app.init();

    return request(app.getHttpServer()).get('/wiring/refusal');
  };

  afterEach(async () => {
    if (app) await app.close();
  });

  it('useAppGlobalFilters installs the DI-provided filter, so the refusal carries key and args', async () => {
    const res = await boot([WiredModule]);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ret: 409,
      message: '2 open tickets are still assigned to this agent: ALP-3,ALP-4',
      data: { key: 'projectAgents.hasOpenTickets.409', args: { count: 2, refs: 'ALP-3,ALP-4' } },
    });
  });

  it('control: without that provider the library filter answers, and the body has no data', async () => {
    const res = await boot([UnwiredModule]);

    expect(res.status).toBe(409);
    expect(res.body.ret).toBe(409);
    expect(res.body.message).toBe('2 open tickets are still assigned to this agent: ALP-3,ALP-4');
    expect(res.body).not.toHaveProperty('data');
  });
});
