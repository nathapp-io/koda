/**
 * US-004: project/auth i18n keys.
 *
 * Acceptance Criteria:
 * 4.  Translating projects.slugInvalid in en returns a string different from the key itself.
 * 5.  Translating projects.slugInvalid in zh returns a string different from the key itself.
 * 6.  Translating projects.keyInvalid in en returns a string different from the key itself.
 * 7.  Translating projects.keyInvalid in zh returns a string different from the key itself.
 * 8.  Translating common.validation.isIn in en returns a string different from the key itself.
 * 9.  Translating common.validation.isIn in zh returns a string different from the key itself.
 *
 * The spec drives the real i18n runtime (nestjs-i18n loader + I18nService, wired
 * exactly as `AppModule` wires it via I18nCoreModule) against the real
 * `src/i18n/{en,zh}` resources, so a missing key makes `translate` fall back to
 * the key itself and the assertion below fails.
 */
import { TestingModule, Test } from '@nestjs/testing';
import { I18nCoreModule, I18nWrapper } from '@nathapp/nestjs-common';
import { join } from 'node:path';

/** apps/api/src/i18n — the directory `AppModule` configures the loader with. */
const I18N_RESOURCES_PATH = join(__dirname, '../../../src/i18n');

describe('US-004: project translation keys', () => {
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

  it('AC4: translating projects.slugInvalid in en returns a string different from the key itself', () => {
    const translated = i18n.translate('projects.slugInvalid', { lang: 'en' });

    expect(typeof translated).toBe('string');
    expect(translated.length).toBeGreaterThan(0);
    expect(translated).not.toBe('projects.slugInvalid');
  });

  it('AC5: translating projects.slugInvalid in zh returns a string different from the key itself', () => {
    const translated = i18n.translate('projects.slugInvalid', { lang: 'zh' });

    expect(typeof translated).toBe('string');
    expect(translated.length).toBeGreaterThan(0);
    expect(translated).not.toBe('projects.slugInvalid');
  });

  it('AC6: translating projects.keyInvalid in en returns a string different from the key itself', () => {
    const translated = i18n.translate('projects.keyInvalid', { lang: 'en' });

    expect(typeof translated).toBe('string');
    expect(translated.length).toBeGreaterThan(0);
    expect(translated).not.toBe('projects.keyInvalid');
  });

  it('AC7: translating projects.keyInvalid in zh returns a string different from the key itself', () => {
    const translated = i18n.translate('projects.keyInvalid', { lang: 'zh' });

    expect(typeof translated).toBe('string');
    expect(translated.length).toBeGreaterThan(0);
    expect(translated).not.toBe('projects.keyInvalid');
  });

  it('AC8: translating common.validation.isIn in en returns a string different from the key itself', () => {
    const translated = i18n.translate('common.validation.isIn', { lang: 'en' });

    expect(typeof translated).toBe('string');
    expect(translated.length).toBeGreaterThan(0);
    expect(translated).not.toBe('common.validation.isIn');
  });

  it('AC9: translating common.validation.isIn in zh returns a string different from the key itself', () => {
    const translated = i18n.translate('common.validation.isIn', { lang: 'zh' });

    expect(typeof translated).toBe('string');
    expect(translated.length).toBeGreaterThan(0);
    expect(translated).not.toBe('common.validation.isIn');
  });
});
