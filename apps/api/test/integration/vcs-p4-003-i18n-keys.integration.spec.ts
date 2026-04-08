/**
 * VCS-P4-003 AC-25: i18n keys for branch/commit link display labels
 *
 * AC-25 refined: Files apps/web/i18n/locales/en.json and apps/web/i18n/locales/zh.json
 * both contain keys for web VCS link display labels.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const webI18nEnPath = join(__dirname, '../../../web/i18n/locales/en.json');
const webI18nZhPath = join(__dirname, '../../../web/i18n/locales/zh.json');

describe('VCS-P4-003 AC-25: i18n keys for branch/commit link display labels', () => {
  describe('Web i18n (apps/web/i18n/locales/en.json and zh.json)', () => {
    test('en.json has tickets.vcs section with title, pullRequests, branches, and commits', () => {
      const content = readFileSync(webI18nEnPath, 'utf-8');
      const locale = JSON.parse(content);

      expect(locale.tickets?.vcs).toBeDefined();
      expect(typeof locale.tickets.vcs.title).toBe('string');
      expect(typeof locale.tickets.vcs.pullRequests).toBe('string');
      expect(typeof locale.tickets.vcs.branches).toBe('string');
      expect(typeof locale.tickets.vcs.commits).toBe('string');
    });

    test('en.json VCS label values are non-empty strings', () => {
      const content = readFileSync(webI18nEnPath, 'utf-8');
      const locale = JSON.parse(content);

      expect(locale.tickets.vcs.title.length).toBeGreaterThan(0);
      expect(locale.tickets.vcs.pullRequests.length).toBeGreaterThan(0);
      expect(locale.tickets.vcs.branches.length).toBeGreaterThan(0);
      expect(locale.tickets.vcs.commits.length).toBeGreaterThan(0);
    });

    test('zh.json has matching tickets.vcs structure with non-empty values', () => {
      const enContent = readFileSync(webI18nEnPath, 'utf-8');
      const zhContent = readFileSync(webI18nZhPath, 'utf-8');
      const enLocale = JSON.parse(enContent);
      const zhLocale = JSON.parse(zhContent);

      expect(enLocale.tickets?.vcs).toBeDefined();
      expect(zhLocale.tickets?.vcs).toBeDefined();

      const enKeys = Object.keys(enLocale.tickets.vcs || {});
      const zhKeys = Object.keys(zhLocale.tickets.vcs || {});
      expect(zhKeys).toEqual(enKeys);

      expect(zhLocale.tickets.vcs.title.length).toBeGreaterThan(0);
      expect(zhLocale.tickets.vcs.pullRequests.length).toBeGreaterThan(0);
      expect(zhLocale.tickets.vcs.branches.length).toBeGreaterThan(0);
      expect(zhLocale.tickets.vcs.commits.length).toBeGreaterThan(0);
    });
  });
});
