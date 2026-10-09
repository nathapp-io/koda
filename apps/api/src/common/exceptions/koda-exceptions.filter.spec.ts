import type { ArgumentsHost } from '@nestjs/common';
import type { AbstractHttpAdapter } from '@nestjs/core';
import { HttpAdapterHost } from '@nestjs/core';
import { AppException, GlobalExceptionsFilter, I18nCoreModule, I18nWrapper } from '@nathapp/nestjs-common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { join } from 'node:path';
import { ConflictAppException } from './conflict-app.exception';
import { KodaExceptionsFilter } from './koda-exceptions.filter';

/** apps/api/src/i18n — the directory `AppModule` configures the loader with. */
const I18N_RESOURCES_PATH = join(__dirname, '../../i18n');

describe('KodaExceptionsFilter', () => {
  let moduleRef: TestingModule;
  let filter: KodaExceptionsFilter;
  let reply: jest.Mock;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        I18nCoreModule.forRoot({
          fallbackLanguage: 'en',
          loaderOptions: { path: I18N_RESOURCES_PATH, watch: false },
        }),
      ],
    }).compile();

    reply = jest.fn();
    const adapterHost = new HttpAdapterHost();
    adapterHost.httpAdapter = { reply } as unknown as AbstractHttpAdapter;

    filter = new KodaExceptionsFilter(adapterHost, moduleRef.get(I18nWrapper));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await moduleRef?.close();
  });

  const host = (): ArgumentsHost =>
    ({ switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }) }) as unknown as ArgumentsHost;

  it('names the refusing i18n key and its args in `data` beside the translated message', async () => {
    await filter.catch(
      new ConflictAppException({ count: 2, refs: 'ALP-3,ALP-4' }, 'projectAgents.hasOpenTickets'),
      host(),
    );

    expect(reply).toHaveBeenCalledTimes(1);
    const [, body, status] = reply.mock.calls[0] as [unknown, { ret: number; message: string; data: unknown }, number];
    expect(status).toBe(409);
    expect(body.ret).toBe(409);
    expect(body.message).toContain('ALP-3,ALP-4');
    expect(body.data).toEqual({
      key: 'projectAgents.hasOpenTickets.409',
      args: { count: 2, refs: 'ALP-3,ALP-4' },
    });
  });

  it('carries an empty args object for a refusal that has none', async () => {
    await filter.catch(new ConflictAppException({}, 'members.userDisabled'), host());

    const [, body] = reply.mock.calls[0] as [unknown, { data: unknown }];
    expect(body.data).toEqual({ key: 'members.userDisabled.409', args: {} });
  });

  it('leaves exceptions the library derives a status for to the library filter', async () => {
    const delegated = jest.spyOn(GlobalExceptionsFilter.prototype, 'catch').mockResolvedValue(undefined);

    await filter.catch(new AppException(40003, {}, 'projects'), host());

    expect(delegated).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it('leaves non-AppExceptions to the library filter', async () => {
    const delegated = jest.spyOn(GlobalExceptionsFilter.prototype, 'catch').mockResolvedValue(undefined);

    await filter.catch(new Error('boom'), host());

    expect(delegated).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });
});
