/**
 * Branch Name Utility Tests
 *
 * Tests for the buildBranchName utility function that creates standardized branch names
 * from project key, ticket number, and title.
 *
 * Run: bun test test/integration/vcs/branch-name.integration.spec.ts
 */

import { buildBranchName } from '../../../src/common/utils/branch-name.util';

describe('buildBranchName', () => {
  describe('AC1: Basic branch name format', () => {
    it('returns koda/KODA-42/fix-login-redirect-bug when given KODA, 42, Fix login redirect bug', () => {
      const result = buildBranchName('KODA', 42, 'Fix login redirect bug');
      expect(result).toBe('koda/KODA-42/fix-login-redirect-bug');
    });
  });

  describe('AC2: Long title truncation', () => {
    it('returns branch name at most 100 characters for very long titles', () => {
      const longTitle = 'A very long title that exceeds the maximum allowed length for branch names';
      const result = buildBranchName('PROJ', 1, longTitle);
      expect(result.length).toBeLessThanOrEqual(100);
    });

    it('includes project prefix and ticket number in length count', () => {
      const longTitle = 'A very long title that exceeds the maximum allowed length for branch names';
      const result = buildBranchName('PROJ', 1, longTitle);
      expect(result).toMatch(/^proj\/PROJ-1\//);
    });
  });

  describe('AC3: Special characters handling', () => {
    it('returns branch name with only alphanumeric characters and hyphens in slug portion', () => {
      const result = buildBranchName('PROJ', 1, 'Special chars: @#$%^&*()');
      const slugPart = result.split('/')[2];
      expect(slugPart).toMatch(/^[a-z0-9-]+$/);
    });

    it('removes all special characters from title', () => {
      const result = buildBranchName('PROJ', 1, 'Special @#$% chars');
      const slugPart = result.split('/')[2];
      expect(slugPart).not.toContain('@');
      expect(slugPart).not.toContain('#');
      expect(slugPart).not.toContain('$');
    });
  });

  describe('AC4: Trailing hyphens removal', () => {
    it('returns branch name with no trailing hyphens in slug portion', () => {
      const result = buildBranchName('PROJ', 1, 'trailing---hyphens---');
      const slugPart = result.split('/')[2];
      expect(slugPart).not.toMatch(/-+$/);
    });

    it('removes trailing hyphens but preserves internal hyphens', () => {
      const result = buildBranchName('PROJ', 1, 'foo---bar');
      const slugPart = result.split('/')[2];
      expect(slugPart).toBe('foo-bar');
    });
  });

  describe('project key formatting', () => {
    it('converts project key to lowercase in prefix', () => {
      const result = buildBranchName('KODA', 1, 'Test');
      expect(result).toMatch(/^koda\//);
    });

    it('keeps project key uppercase in ticket number portion', () => {
      const result = buildBranchName('KODA', 1, 'Test');
      expect(result).toMatch(/KODA-1/);
    });
  });

  describe('title slugification', () => {
    it('converts title to lowercase', () => {
      const result = buildBranchName('PROJ', 1, 'UPPERCASE TITLE');
      const slugPart = result.split('/')[2];
      expect(slugPart).toBe('uppercase-title');
    });

    it('replaces spaces with hyphens', () => {
      const result = buildBranchName('PROJ', 1, 'one two three');
      const slugPart = result.split('/')[2];
      expect(slugPart).toBe('one-two-three');
    });

    it('collapses multiple spaces into single hyphen', () => {
      const result = buildBranchName('PROJ', 1, 'one  two');
      const slugPart = result.split('/')[2];
      expect(slugPart).toBe('one-two');
    });

    it('handles empty title gracefully', () => {
      const result = buildBranchName('PROJ', 1, '');
      const slugPart = result.split('/')[2];
      expect(slugPart).toBe('');
    });
  });

  describe('ticket number formatting', () => {
    it('formats ticket number as KEY-NUMBER', () => {
      const result = buildBranchName('PROJ', 42, 'Test');
      expect(result).toContain('/PROJ-42/');
    });

    it('handles single digit ticket numbers', () => {
      const result = buildBranchName('PROJ', 1, 'Test');
      expect(result).toContain('/PROJ-1/');
    });

    it('handles large ticket numbers', () => {
      const result = buildBranchName('PROJ', 99999, 'Test');
      expect(result).toContain('/PROJ-99999/');
    });
  });

  describe('branch name format', () => {
    it('returns branch name in format {projectLower}/{projectKey}-{ticketNumber}/{slug}', () => {
      const result = buildBranchName('KODA', 42, 'Fix bug');
      expect(result).toMatch(/^[a-z]+\/KODA-\d+\/[a-z0-9-]+$/);
    });

    it('always has three parts separated by slashes', () => {
      const result = buildBranchName('PROJ', 1, 'Test');
      const parts = result.split('/');
      expect(parts.length).toBe(3);
    });
  });
});
