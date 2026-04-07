/**
 * VCS-P4-003 AC-25: i18n keys for branch/commit link display labels
 *
 * AC-25 refined: Files apps/api/src/i18n/en/vcs.json and apps/api/src/i18n/zh/vcs.json
 * both contain keys for VCS link display labels (e.g., 'vcs.links.branch', 'vcs.links.commit',
 * 'vcs.links.pull_request' or equivalent keys). Each key exists in both files with non-empty string values.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const apiI18nEnPath = join(__dirname, '../../src/i18n/en/vcs.json');
const apiI18nZhPath = join(__dirname, '../../src/i18n/zh/vcs.json');

describe('VCS-P4-003 AC-25: i18n keys for branch/commit link display labels', () => {
  describe('API i18n (apps/api/src/i18n/en/vcs.json and zh/vcs.json)', () => {
    test('en/vcs.json has vcs.links section with branch, commit, and pull_request keys', () => {
      const content = readFileSync(apiI18nEnPath, 'utf-8');
      const vcs = JSON.parse(content);

      // Should have vcs.links section with branch, commit, pull_request keys
      expect(vcs.links).toBeDefined();
      expect(typeof vcs.links).toBe('object');
      expect(vcs.links.branch).toBeDefined();
      expect(typeof vcs.links.branch).toBe('string');
      expect(vcs.links.commit).toBeDefined();
      expect(typeof vcs.links.commit).toBe('string');
      expect(vcs.links.pull_request).toBeDefined();
      expect(typeof vcs.links.pull_request).toBe('string');
    });

    test('en/vcs.json link label values are non-empty strings', () => {
      const content = readFileSync(apiI18nEnPath, 'utf-8');
      const vcs = JSON.parse(content);

      expect(vcs.links.branch.length).toBeGreaterThan(0);
      expect(vcs.links.commit.length).toBeGreaterThan(0);
      expect(vcs.links.pull_request.length).toBeGreaterThan(0);
    });

    test('zh/vcs.json has matching vcs.links structure with non-empty values', () => {
      const enContent = readFileSync(apiI18nEnPath, 'utf-8');
      const zhContent = readFileSync(apiI18nZhPath, 'utf-8');
      const enVcs = JSON.parse(enContent);
      const zhVcs = JSON.parse(zhContent);

      // Both should have links section
      expect(enVcs.links).toBeDefined();
      expect(zhVcs.links).toBeDefined();

      // Both should have same keys
      const enKeys = Object.keys(enVcs.links || {});
      const zhKeys = Object.keys(zhVcs.links || {});
      expect(zhKeys).toEqual(enKeys);

      // Both should have non-empty values
      expect(zhVcs.links.branch.length).toBeGreaterThan(0);
      expect(zhVcs.links.commit.length).toBeGreaterThan(0);
      expect(zhVcs.links.pull_request.length).toBeGreaterThan(0);
    });
  });
});
