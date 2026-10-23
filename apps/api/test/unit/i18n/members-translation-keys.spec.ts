/**
 * S4c US-003 — the disabled-member refusal message.
 *
 * `ProjectMembersService.add` throws `new ConflictAppException({}, 'members.userDisabled')`, and
 * `GlobalExceptionsFilter` builds the i18n key from `${prefix}.${code}` — so the key that has to
 * exist is `members.userDisabled.409`. A flat `"userDisabled": "…"` never resolves for that lookup
 * and the 409 body carries the raw key instead of the sentence (the sibling
 * `invites.userDisabled` is nested `{ "409": … }` for the same reason).
 *
 * The spec drives the real nestjs-i18n runtime, wired exactly as `AppModule` wires it via
 * I18nCoreModule, against the real `src/i18n/{en,zh}` resources: while the entry is flat,
 * `translate` falls back to the key itself and the assertions below fail.
 */
import { TestingModule, Test } from '@nestjs/testing';
import { I18nCoreModule, I18nWrapper } from '@nathapp/nestjs-common';
import { join } from 'node:path';

/** apps/api/src/i18n — the directory `AppModule` configures the loader with. */
const I18N_RESOURCES_PATH = join(__dirname, '../../../src/i18n');

/** The key `GlobalExceptionsFilter` builds from new ConflictAppException({}, 'members.userDisabled'). */
const USER_DISABLED_KEY = 'members.userDisabled.409';

describe('S4c US-003: disabled-member refusal translation key', () => {
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

  it.each(['en', 'zh'])('%s: members.userDisabled.409 resolves to the disabled-account sentence', (lang) => {
    const translated = i18n.translate(USER_DISABLED_KEY, { lang });

    expect(translated).not.toBe(USER_DISABLED_KEY);
    expect(translated).not.toContain('userDisabled');
  });

  it('en: the refusal names the disabled account, matching the invite path wording', () => {
    const translated = i18n.translate(USER_DISABLED_KEY, { lang: 'en' });

    expect(translated.toLowerCase()).toContain('disabled');
    expect(translated).toBe(i18n.translate('invites.userDisabled.409', { lang: 'en' }));
  });

  it('zh: the refusal names the disabled account, matching the invite path wording', () => {
    const translated = i18n.translate(USER_DISABLED_KEY, { lang: 'zh' });

    expect(translated).toContain('禁用');
    expect(translated).toBe(i18n.translate('invites.userDisabled.409', { lang: 'zh' }));
  });
});
