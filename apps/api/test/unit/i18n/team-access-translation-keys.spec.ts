/**
 * S4c US-003 — the roster conflict messages.
 *
 * D531: removing an agent that still holds open tickets is refused with 409
 * `projectAgents.hasOpenTickets` and the message names the count and the ticket
 * refs (the CLI prints the message; the web reads `openTicketRefs` off the
 * roster row). The spec drives the real nestjs-i18n runtime wired exactly as
 * `AppModule` wires it via I18nCoreModule against the real `src/i18n/{en,zh}`
 * resources, so a missing or misspelled key falls back to the key itself and
 * the assertions below fail.
 */
import { TestingModule, Test } from '@nestjs/testing';
import { I18nCoreModule, I18nWrapper } from '@nathapp/nestjs-common';
import { join } from 'node:path';

/** apps/api/src/i18n — the directory `AppModule` configures the loader with. */
const I18N_RESOURCES_PATH = join(__dirname, '../../../src/i18n');

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
