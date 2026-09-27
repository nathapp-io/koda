/**
 * US-003 — the localized webhook URL rejection message.
 *
 * AC15: translating `webhooks.-2` with args `{ reason: 'blocked_destination' }` in both
 * `en` and `zh` returns a message that differs from the key and names the reason.
 *
 * The spec drives the real i18n runtime (nestjs-i18n loader + I18nService, wired exactly
 * as `AppModule` wires it via I18nCoreModule) against the real `src/i18n/{en,zh}`
 * resources, so a missing key makes `translate` fall back to the key itself and the
 * assertions below fail. `webhooks.-2` is the key `GlobalExceptionsFilter` builds from
 * `new ValidationAppException({ reason }, 'webhooks')` (CommonExceptionCode -2).
 */
import { TestingModule, Test } from '@nestjs/testing';
import { I18nCoreModule, I18nWrapper } from '@nathapp/nestjs-common';
import { join } from 'node:path';

/** apps/api/src/i18n — the directory `AppModule` configures the loader with. */
const I18N_RESOURCES_PATH = join(__dirname, '../../../src/i18n');

const REJECTION_KEY = 'webhooks.-2';

describe('US-003: webhook URL rejection translation key', () => {
  let moduleRef: TestingModule;
  let i18n: I18nWrapper;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        I18nCoreModule.forRoot({
          fallbackLanguage: 'en',
          loaderOptions: { path: I18N_RESOURCES_PATH, watch: false },
        }),
      ],
    }).compile();

    i18n = moduleRef.get(I18nWrapper);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('AC15: translating webhooks.-2 in en differs from the key and contains the reason', () => {
    const translated = i18n.translate(REJECTION_KEY, {
      lang: 'en',
      args: { reason: 'blocked_destination' },
    });

    expect(translated).not.toBe(REJECTION_KEY);
    expect(translated).toContain('blocked_destination');
  });

  it('AC15: translating webhooks.-2 in zh differs from the key and contains the reason', () => {
    const translated = i18n.translate(REJECTION_KEY, {
      lang: 'zh',
      args: { reason: 'blocked_destination' },
    });

    expect(translated).not.toBe(REJECTION_KEY);
    expect(translated).toContain('blocked_destination');
  });

  it('AC15 boundary: the en message leaves no unresolved {reason} placeholder', () => {
    const translated = i18n.translate(REJECTION_KEY, {
      lang: 'en',
      args: { reason: 'blocked_destination' },
    });

    expect(translated).not.toContain('{reason}');
    expect(translated).toContain('blocked_destination');
  });

  it('AC15 boundary: the zh message leaves no unresolved {reason} placeholder', () => {
    const translated = i18n.translate(REJECTION_KEY, {
      lang: 'zh',
      args: { reason: 'blocked_destination' },
    });

    expect(translated).not.toContain('{reason}');
    expect(translated).toContain('blocked_destination');
  });

  it('AC15 boundary: the en message renders whatever reason the guard reported', () => {
    const translated = i18n.translate(REJECTION_KEY, {
      lang: 'en',
      args: { reason: 'credentials_not_allowed' },
    });

    expect(translated).not.toBe(REJECTION_KEY);
    expect(translated).toContain('credentials_not_allowed');
  });
});
