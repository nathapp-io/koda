/**
 * VCS Pull Request Types Tests
 *
 * Tests for VcsPullRequest and CreatePrParams types used by IVcsProvider
 * for pull request creation.
 *
 * Run: bun test test/integration/vcs/vcs-pr-types.integration.spec.ts
 */

import { VcsPullRequest, CreatePrParams, VcsPrStatus } from '../../../src/vcs/types';

describe('VcsPrStatus type', () => {
  describe('type structure', () => {
    it('should have number field as number', () => {
      const prStatus: VcsPrStatus = {
        number: 42,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/42',
        title: 'Add new feature',
      };
      expect(typeof prStatus.number).toBe('number');
      expect(prStatus.number).toBe(42);
    });

    it('should have state field as string', () => {
      const prStatus: VcsPrStatus = {
        number: 1,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Feature',
      };
      expect(typeof prStatus.state).toBe('string');
      expect(prStatus.state).toBe('open');
    });

    it('should have draft field as boolean', () => {
      const prStatus: VcsPrStatus = {
        number: 1,
        state: 'open',
        draft: true,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Draft PR',
      };
      expect(typeof prStatus.draft).toBe('boolean');
      expect(prStatus.draft).toBe(true);
    });

    it('should have merged field as boolean', () => {
      const prStatus: VcsPrStatus = {
        number: 1,
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: new Date('2024-01-15T10:30:00Z'),
        mergedBy: 'merger',
        mergeSha: 'abc123',
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Merged PR',
      };
      expect(typeof prStatus.merged).toBe('boolean');
      expect(prStatus.merged).toBe(true);
    });

    it('should have mergedAt field as Date or null', () => {
      const mergedPr: VcsPrStatus = {
        number: 1,
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: new Date('2024-01-15T10:30:00Z'),
        mergedBy: 'merger',
        mergeSha: 'abc123',
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Merged PR',
      };
      expect(mergedPr.mergedAt instanceof Date).toBe(true);

      const openPr: VcsPrStatus = {
        number: 2,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/2',
        title: 'Open PR',
      };
      expect(openPr.mergedAt).toBeNull();
    });

    it('should have mergedBy field as string or null', () => {
      const mergedPr: VcsPrStatus = {
        number: 1,
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: new Date('2024-01-15T10:30:00Z'),
        mergedBy: 'merger',
        mergeSha: 'abc123',
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Merged PR',
      };
      expect(typeof mergedPr.mergedBy).toBe('string');
      expect(mergedPr.mergedBy).toBe('merger');

      const openPr: VcsPrStatus = {
        number: 2,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/2',
        title: 'Open PR',
      };
      expect(openPr.mergedBy).toBeNull();
    });

    it('should have mergeSha field as string or null', () => {
      const mergedPr: VcsPrStatus = {
        number: 1,
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: new Date('2024-01-15T10:30:00Z'),
        mergedBy: 'merger',
        mergeSha: 'abc123def456',
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Merged PR',
      };
      expect(typeof mergedPr.mergeSha).toBe('string');
      expect(mergedPr.mergeSha).toBe('abc123def456');

      const openPr: VcsPrStatus = {
        number: 2,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/2',
        title: 'Open PR',
      };
      expect(openPr.mergeSha).toBeNull();
    });

    it('should have url field as string', () => {
      const prStatus: VcsPrStatus = {
        number: 1,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/1',
        title: 'PR Title',
      };
      expect(typeof prStatus.url).toBe('string');
      expect(prStatus.url).toMatch(/^https?:\/\//);
    });

    it('should have title field as string', () => {
      const prStatus: VcsPrStatus = {
        number: 1,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/1',
        title: 'My Pull Request Title',
      };
      expect(typeof prStatus.title).toBe('string');
      expect(prStatus.title).toBe('My Pull Request Title');
    });
  });

  describe('merged PR representation', () => {
    it('should represent a merged PR with merged=true and populated mergedAt, mergedBy, mergeSha', () => {
      const mergedPr: VcsPrStatus = {
        number: 42,
        state: 'closed',
        draft: false,
        merged: true,
        mergedAt: new Date('2024-01-15T10:30:00Z'),
        mergedBy: 'octocat',
        mergeSha: 'sha123abc',
        url: 'https://github.com/owner/repo/pull/42',
        title: 'Merged Feature',
      };
      expect(mergedPr.merged).toBe(true);
      expect(mergedPr.mergedAt).toEqual(new Date('2024-01-15T10:30:00Z'));
      expect(mergedPr.mergedBy).toBe('octocat');
      expect(mergedPr.mergeSha).toBe('sha123abc');
    });
  });

  describe('open PR representation', () => {
    it('should represent an open PR with null merged fields', () => {
      const openPr: VcsPrStatus = {
        number: 1,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Open PR',
      };
      expect(openPr.merged).toBe(false);
      expect(openPr.mergedAt).toBeNull();
      expect(openPr.mergedBy).toBeNull();
      expect(openPr.mergeSha).toBeNull();
    });
  });

  describe('draft PR representation', () => {
    it('should represent a draft PR with draft=true', () => {
      const draftPr: VcsPrStatus = {
        number: 1,
        state: 'open',
        draft: true,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Draft PR',
      };
      expect(draftPr.draft).toBe(true);
      expect(draftPr.merged).toBe(false);
    });
  });
});

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
        branchName: 'koda/KODA-42/fix-login-redirect-bug',
        baseBranch: 'main',
      };
      expect(typeof params.title).toBe('string');
      expect(params.title).toBe('Fix login redirect bug');
    });

    it('should have body field as string', () => {
      const params: CreatePrParams = {
        title: 'Fix bug',
        body: 'This PR fixes the bug',
        branchName: 'feature-branch',
      };
      expect(typeof params.body).toBe('string');
    });

    it('should support branchName field as string', () => {
      const params: CreatePrParams = {
        title: 'Fix bug',
        body: 'Description',
        branchName: 'koda/KODA-42/fix-login-redirect-bug',
      };
      expect(typeof params.branchName).toBe('string');
    });

    it('should allow optional baseBranch field', () => {
      const params: CreatePrParams = {
        title: 'Fix bug',
        body: 'Description',
        branchName: 'feature-branch',
        baseBranch: 'main',
      };
      expect(typeof params.baseBranch).toBe('string');
      expect(params.baseBranch).toBe('main');
    });

    it('should support legacy headBranch for backward compatibility', () => {
      const params: CreatePrParams = {
        title: 'Fix bug',
        body: 'Description',
        headBranch: 'feature-branch',
      };
      expect(typeof params.headBranch).toBe('string');
    });
  });

  describe('field requirements', () => {
    it('should require title/body and at least one branch field', () => {
      type RequiredParams = Required<CreatePrParams>;
      const params: RequiredParams = {
        title: 'Title',
        body: 'Body',
        branchName: 'feature-branch',
        headBranch: 'feature-branch',
        baseBranch: 'main',
        draft: false,
      };
      expect(params.title).toBeDefined();
      expect(params.body).toBeDefined();
      expect(params.branchName || params.headBranch).toBeDefined();
      expect(params.baseBranch).toBeDefined();
      expect(params.draft).toBeDefined();
    });

    it('should allow empty strings for optional fields', () => {
      const params: CreatePrParams = {
        title: 'Title',
        body: '',
        branchName: 'feature-branch',
      };
      expect(params.body).toBe('');
    });
  });
});
