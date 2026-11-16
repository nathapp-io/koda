import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * US-002 (GitLab parity F1): the GitLab reasons of a repo check are translated in both locales.
 * The key is `fleet.repoCheckReason.<reason>`; the web renders the same reasons from its own
 * catalog (`fleet.repoReason`, US-008).
 */
type Catalog = Record<string, Record<string, string>>;
const load = (lang: string): Catalog => JSON.parse(readFileSync(join(__dirname, '../../../src/i18n', lang, 'fleet.json'), 'utf8')) as Catalog;

const REASONS = [
  'gitlab_credentials_missing',
  'gitlab_host_invalid',
  'gitlab_host_blocked',
  'gitlab_host_unclassified',
  'gitlab_read_token_writable',
  'gitlab_read_token_no_access',
  'gitlab_project_mismatch',
];

describe('fleet repo check reason translation keys', () => {
  it.each(REASONS)('US-002: %s is translated in en and zh', (reason) => {
    expect(load('en').repoCheckReason?.[reason]?.trim()).toBeTruthy();
    expect(load('zh').repoCheckReason?.[reason]?.trim()).toBeTruthy();
  });

  it('US-002: the catalog covers exactly the new GitLab reasons', () => {
    expect(Object.keys(load('en').repoCheckReason ?? {}).sort()).toEqual([...REASONS].sort());
    expect(Object.keys(load('zh').repoCheckReason ?? {}).sort()).toEqual([...REASONS].sort());
  });
});
