/**
 * VCS Pull Request Types Tests
 *
 * Tests for VcsPullRequest and CreatePrParams types used by IVcsProvider
 * for pull request creation.
 *
 * Run: bun test test/integration/vcs/vcs-pr-types.integration.spec.ts
 */

import { VcsPullRequest, CreatePrParams } from '../../../src/vcs/types';

describe('VcsPullRequest type', () => {
  describe('type structure', () => {
    it('should have number field as number', () => {
      const pr: VcsPullRequest = {
        number: 42,
        url: 'https://github.com/owner/repo/pull/42',
        branchName: 'feature-branch',
        state: 'open',
        draft: false,
      };
      expect(typeof pr.number).toBe('number');
      expect(pr.number).toBe(42);
    });

    it('should have url field as string', () => {
      const pr: VcsPullRequest = {
        number: 1,
        url: 'https://github.com/owner/repo/pull/1',
        branchName: 'feature-branch',
        state: 'open',
        draft: false,
      };
      expect(typeof pr.url).toBe('string');
      expect(pr.url).toMatch(/^https?:\/\//);
    });

    it('should have branchName field as string', () => {
      const pr: VcsPullRequest = {
        number: 1,
        url: 'https://github.com/owner/repo/pull/1',
        branchName: 'koda/KODA-42/fix-login-bug',
        state: 'open',
        draft: false,
      };
      expect(typeof pr.branchName).toBe('string');
    });

    it('should have state field as string', () => {
      const pr: VcsPullRequest = {
        number: 1,
        url: 'https://github.com/owner/repo/pull/1',
        branchName: 'feature-branch',
        state: 'open',
        draft: false,
      };
      expect(typeof pr.state).toBe('string');
      expect(pr.state).toBe('open');
    });

    it('should have draft field as boolean', () => {
      const pr: VcsPullRequest = {
        number: 1,
        url: 'https://github.com/owner/repo/pull/1',
        branchName: 'feature-branch',
        state: 'open',
        draft: true,
      };
      expect(typeof pr.draft).toBe('boolean');
      expect(pr.draft).toBe(true);
    });
  });

  describe('draft PR representation', () => {
    it('should have draft true for draft pull requests', () => {
      const draftPr: VcsPullRequest = {
        number: 1,
        url: 'https://github.com/owner/repo/pull/1',
        branchName: 'feature-branch',
        state: 'open',
        draft: true,
      };
      expect(draftPr.draft).toBe(true);
    });

    it('should have draft false for regular pull requests', () => {
      const regularPr: VcsPullRequest = {
        number: 1,
        url: 'https://github.com/owner/repo/pull/1',
        branchName: 'feature-branch',
        state: 'open',
        draft: false,
      };
      expect(regularPr.draft).toBe(false);
    });
  });
});

describe('CreatePrParams type', () => {
  describe('type structure', () => {
    it('should have title field as string', () => {
      const params: CreatePrParams = {
        title: 'Fix login redirect bug',
        body: 'This PR fixes the login redirect bug',
        headBranch: 'koda/KODA-42/fix-login-redirect-bug',
        baseBranch: 'main',
      };
      expect(typeof params.title).toBe('string');
      expect(params.title).toBe('Fix login redirect bug');
    });

    it('should have body field as string', () => {
      const params: CreatePrParams = {
        title: 'Fix bug',
        body: 'This PR fixes the bug',
        headBranch: 'feature-branch',
        baseBranch: 'main',
      };
      expect(typeof params.body).toBe('string');
    });

    it('should have headBranch field as string', () => {
      const params: CreatePrParams = {
        title: 'Fix bug',
        body: 'Description',
        headBranch: 'koda/KODA-42/fix-login-redirect-bug',
        baseBranch: 'main',
      };
      expect(typeof params.headBranch).toBe('string');
    });

    it('should have baseBranch field as string', () => {
      const params: CreatePrParams = {
        title: 'Fix bug',
        body: 'Description',
        headBranch: 'feature-branch',
        baseBranch: 'main',
      };
      expect(typeof params.baseBranch).toBe('string');
      expect(params.baseBranch).toBe('main');
    });
  });

  describe('field requirements', () => {
    it('should require all fields', () => {
      type RequiredParams = Required<CreatePrParams>;
      const params: RequiredParams = {
        title: 'Title',
        body: 'Body',
        headBranch: 'feature-branch',
        baseBranch: 'main',
      };
      expect(params.title).toBeDefined();
      expect(params.body).toBeDefined();
      expect(params.headBranch).toBeDefined();
      expect(params.baseBranch).toBeDefined();
    });

    it('should allow empty strings for optional fields', () => {
      const params: CreatePrParams = {
        title: 'Title',
        body: '',
        headBranch: 'feature-branch',
        baseBranch: 'main',
      };
      expect(params.body).toBe('');
    });
  });
});
