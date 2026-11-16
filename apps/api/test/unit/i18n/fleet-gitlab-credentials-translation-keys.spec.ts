import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * US-005 (GitLab parity F1): the two refusals the credential rotation answers are translated in both
 * locales. The key is `fleet.repoGitlabCredentialsEmpty` / `fleet.repoNotGitlab`, and like every other
 * `ValidationAppException` message in this module it lives one code deeper (`-2`).
 */
type Catalog = Record<string, Record<string, string>>;
const load = (lang: string): Catalog => JSON.parse(readFileSync(join(__dirname, '../../../src/i18n', lang, 'fleet.json'), 'utf8')) as Catalog;

const KEYS = ['repoGitlabCredentialsEmpty', 'repoNotGitlab'];

describe('fleet GitLab credential rotation translation keys', () => {
  it.each(KEYS)('US-005: %s is translated in en and zh', (key) => {
    expect(load('en')[key]?.['-2']?.trim()).toBeTruthy();
    expect(load('zh')[key]?.['-2']?.trim()).toBeTruthy();
  });
});
