/**
 * S4c US-003 — the roster conflict messages.
 *
 * Every roster refusal is an AppException whose prefix is turned into an i18n key
 * by `KodaExceptionsFilter` / `GlobalExceptionsFilter` as `${prefix}.${code}`:
 *
 *   - `projectAgents.alreadyAssigned` + 409 -> `projectAgents.alreadyAssigned.409`
 *   - `projectAgents.agentOffline`    + 409 -> `projectAgents.agentOffline.409`
 *   - `projectAgents.hasOpenTickets`  + 409 -> `projectAgents.hasOpenTickets.409`
 *     (D531: the refusal message names the count and the ticket refs; the CLI
 *     prints the message, the web reads `openTicketRefs` off the roster row)
 *
 * The spec drives the real nestjs-i18n runtime wired exactly as `AppModule` wires
 * it via I18nCoreModule against the real `src/i18n/{en,zh}` resources, so a
 * missing or misspelled key falls back to the key itself and the assertions below
 * fail. Each entry has to be nested under its status (`"agentOffline": { "409":
 * … }`): a flat `"agentOffline": "…"` never resolves for that lookup, which
 * leaves the 409 body carrying the raw key instead of the sentence.
 */
import { TestingModule, Test } from '@nestjs/testing';
import { I18nCoreModule, I18nWrapper } from '@nathapp/nestjs-common';
import { join } from 'node:path';

/** apps/api/src/i18n — the directory `AppModule` configures the loader with. */
const I18N_RESOURCES_PATH = join(__dirname, '../../../src/i18n');

/** Key GlobalExceptionsFilter builds from new ConflictAppException({}, 'projectAgents.alreadyAssigned'). */
const ALREADY_ASSIGNED_KEY = 'projectAgents.alreadyAssigned.409';
/** Key GlobalExceptionsFilter builds from new ConflictAppException({}, 'projectAgents.agentOffline'). */
const AGENT_OFFLINE_KEY = 'projectAgents.agentOffline.409';
/** Key GlobalExceptionsFilter builds from new ConflictAppException({...}, 'projectAgents.hasOpenTickets'). */
const OPEN_TICKETS_KEY = 'projectAgents.hasOpenTickets.409';
const ARGS = { count: 2, refs: 'ALP-3,ALP-4' };

describe('S4c US-003: roster conflict translation keys', () => {
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

  it.each(['en', 'zh'])('%s: projectAgents.alreadyAssigned.409 resolves to the duplicate-roster sentence', (lang) => {
    const translated = i18n.translate(ALREADY_ASSIGNED_KEY, { lang });

    expect(translated).not.toBe(ALREADY_ASSIGNED_KEY);
    expect(translated).not.toContain('alreadyAssigned');
  });

  it('en: names the agent as already rostered', () => {
    const translated = i18n.translate(ALREADY_ASSIGNED_KEY, { lang: 'en' });

    expect(translated.toLowerCase()).toContain('already');
    expect(translated.toLowerCase()).toContain('roster');
  });

  it('zh: names the agent as already rostered', () => {
    const translated = i18n.translate(ALREADY_ASSIGNED_KEY, { lang: 'zh' });

    expect(translated).toContain('已在');
  });

  it.each(['en', 'zh'])('%s: projectAgents.agentOffline.409 resolves to the offline-agent sentence', (lang) => {
    const translated = i18n.translate(AGENT_OFFLINE_KEY, { lang });

    expect(translated).not.toBe(AGENT_OFFLINE_KEY);
    expect(translated).not.toContain('agentOffline');
  });

  it('en: names the agent as offline and refuses the add', () => {
    const translated = i18n.translate(AGENT_OFFLINE_KEY, { lang: 'en' });

    // 'offline' alone is satisfied by the lowercased fallback key ("…agentoffline.409"),
    // so the refusal itself has to be part of the sentence.
    expect(translated.toLowerCase()).toContain('offline');
    expect(translated.toLowerCase()).toContain('cannot be added');
  });

  it('zh: names the agent as offline', () => {
    const translated = i18n.translate(AGENT_OFFLINE_KEY, { lang: 'zh' });

    expect(translated).toContain('离线');
  });

  it.each(['en', 'zh'])('%s: names the open-ticket count and the refs of the blocked removal', (lang) => {
    const translated = i18n.translate(OPEN_TICKETS_KEY, { lang, args: ARGS });

    expect(translated).not.toBe(OPEN_TICKETS_KEY);
    expect(translated).toContain('2');
    expect(translated).toContain('ALP-3,ALP-4');
  });

  it.each(['en', 'zh'])('%s: leaves no unresolved {count}/{refs} placeholder', (lang) => {
    const translated = i18n.translate(OPEN_TICKETS_KEY, { lang, args: ARGS });

    expect(translated).not.toContain('{count}');
    expect(translated).not.toContain('{refs}');
  });
});
