/**
 * S4c US-004 — the assignment refusal messages.
 *
 * `TicketsService.assign` refuses a disabled user or an ineligible agent with
 * `new ConflictAppException({}, 'tickets.<key>')`, and
 * `GlobalExceptionsFilter` builds the i18n key from `${prefix}.${code}`:
 *
 *   - `tickets.userDisabled`      + 409 -> `tickets.userDisabled.409`
 *   - `tickets.agentNotInProject` + 409 -> `tickets.agentNotInProject.409`
 *   - `tickets.agentOffline`      + 409 -> `tickets.agentOffline.409`
 *
 * The spec drives the real nestjs-i18n runtime wired exactly as `AppModule` wires
 * it via I18nCoreModule against the real `src/i18n/{en,zh}` resources, so a
 * missing or misspelled key falls back to the key itself and the assertions
 * below fail. Each entry has to be nested under its status
 * (`"agentOffline": { "409": … }`): a flat `"agentOffline": "…"` never resolves
 * for that lookup, which leaves the 409 body carrying the raw key instead of the
 * sentence.
 */
import { TestingModule, Test } from '@nestjs/testing';
import { I18nCoreModule, I18nWrapper } from '@nathapp/nestjs-common';
import { join } from 'node:path';

/** apps/api/src/i18n — the directory `AppModule` configures the loader with. */
const I18N_RESOURCES_PATH = join(__dirname, '../../../src/i18n');

/** Key GlobalExceptionsFilter builds from new ConflictAppException({}, 'tickets.userDisabled'). */
const USER_DISABLED_KEY = 'tickets.userDisabled.409';
/** Key GlobalExceptionsFilter builds from new ConflictAppException({}, 'tickets.agentNotInProject'). */
const AGENT_NOT_IN_PROJECT_KEY = 'tickets.agentNotInProject.409';
/** Key GlobalExceptionsFilter builds from new ConflictAppException({}, 'tickets.agentOffline'). */
const AGENT_OFFLINE_KEY = 'tickets.agentOffline.409';

describe('S4c US-004: assignment conflict translation keys', () => {
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

  it.each(['en', 'zh'])('%s: tickets.userDisabled.409 resolves to the disabled-account sentence', (lang) => {
    const translated = i18n.translate(USER_DISABLED_KEY, { lang });

    expect(translated).not.toBe(USER_DISABLED_KEY);
    expect(translated).not.toContain('userDisabled');
    expect(translated.toLowerCase()).toContain(lang === 'en' ? 'disabled' : '禁用');
  });

  it.each(['en', 'zh'])('%s: tickets.agentNotInProject.409 resolves to the unrostered-agent sentence', (lang) => {
    const translated = i18n.translate(AGENT_NOT_IN_PROJECT_KEY, { lang });

    expect(translated).not.toBe(AGENT_NOT_IN_PROJECT_KEY);
    expect(translated).not.toContain('agentNotInProject');
    expect(translated.toLowerCase()).toContain(lang === 'en' ? 'roster' : '名册');
  });

  it.each(['en', 'zh'])('%s: tickets.agentOffline.409 resolves to the offline-agent sentence', (lang) => {
    const translated = i18n.translate(AGENT_OFFLINE_KEY, { lang });

    expect(translated).not.toBe(AGENT_OFFLINE_KEY);
    expect(translated).not.toContain('agentOffline');
    expect(translated.toLowerCase()).toContain(lang === 'en' ? 'offline' : '离线');
  });
});
