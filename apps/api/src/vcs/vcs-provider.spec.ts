import { IVcsProvider } from './vcs-provider';
import { VcsIssue, VcsPullRequest, CreatePrParams } from './types';

describe('VcsIssue Type', () => {
  describe('VcsIssue type structure', () => {
    it('should have number field', () => {
      const issue: VcsIssue = {
        number: 42,
        title: 'Test Issue',
        body: 'Test body',
        authorLogin: 'testuser',
        url: 'https://github.com/test/repo/issues/42',
        labels: ['bug', 'feature'],
        createdAt: new Date(),
      };
      expect(issue.number).toBe(42);
      expect(typeof issue.number).toBe('number');
    });

    it('should have title field as string', () => {
      const issue: VcsIssue = {
        number: 1,
        title: 'Test Title',
        body: null,
        authorLogin: 'user',
        url: 'https://example.com',
        labels: [],
        createdAt: new Date(),
      };
      expect(typeof issue.title).toBe('string');
      expect(issue.title).toBe('Test Title');
    });

    it('should have body field as string or null', () => {
      const issueWithBody: VcsIssue = {
        number: 1,
        title: 'Title',
        body: 'Body text',
        authorLogin: 'user',
        url: 'https://example.com',
        labels: [],
        createdAt: new Date(),
      };
      expect(typeof issueWithBody.body).toBe('string');

      const issueWithoutBody: VcsIssue = {
        number: 2,
        title: 'Title',
        body: null,
        authorLogin: 'user',
        url: 'https://example.com',
        labels: [],
        createdAt: new Date(),
      };
      expect(issueWithoutBody.body).toBeNull();
    });

    it('should have authorLogin field as string', () => {
      const issue: VcsIssue = {
        number: 1,
        title: 'Title',
        body: null,
        authorLogin: 'john_doe',
        url: 'https://example.com',
        labels: [],
        createdAt: new Date(),
      };
      expect(typeof issue.authorLogin).toBe('string');
      expect(issue.authorLogin).toBe('john_doe');
    });

    it('should have url field as string', () => {
      const issue: VcsIssue = {
        number: 1,
        title: 'Title',
        body: null,
        authorLogin: 'user',
        url: 'https://github.com/owner/repo/issues/1',
        labels: [],
        createdAt: new Date(),
      };
      expect(typeof issue.url).toBe('string');
      expect(issue.url).toMatch(/^https?:\/\//);
    });

    it('should have labels field as string array', () => {
      const issue: VcsIssue = {
        number: 1,
        title: 'Title',
        body: null,
        authorLogin: 'user',
        url: 'https://example.com',
        labels: ['bug', 'enhancement', 'documentation'],
        createdAt: new Date(),
      };
      expect(Array.isArray(issue.labels)).toBe(true);
      expect(issue.labels.every((label) => typeof label === 'string')).toBe(true);
    });

    it('should have createdAt field as Date', () => {
      const now = new Date();
      const issue: VcsIssue = {
        number: 1,
        title: 'Title',
        body: null,
        authorLogin: 'user',
        url: 'https://example.com',
        labels: [],
        createdAt: now,
      };
      expect(issue.createdAt instanceof Date).toBe(true);
      expect(issue.createdAt).toEqual(now);
    });

    it('should require all fields in VcsIssue', () => {
      type RequiredFields = Required<VcsIssue>;
      const issue: RequiredFields = {
        number: 1,
        title: 'Title',
        body: 'Body',
        authorLogin: 'user',
        url: 'https://example.com',
        labels: ['label'],
        createdAt: new Date(),
      };
      expect(issue).toBeDefined();
      expect(issue.number).toBeDefined();
      expect(issue.title).toBeDefined();
      expect(issue.body).toBeDefined();
      expect(issue.authorLogin).toBeDefined();
      expect(issue.url).toBeDefined();
      expect(issue.labels).toBeDefined();
      expect(issue.createdAt).toBeDefined();
    });
  });
});

describe('IVcsProvider Interface', () => {
  describe('IVcsProvider interface structure', () => {
    it('should define fetchIssues method with optional since parameter', () => {
      class MockVcsProvider implements IVcsProvider {
        async fetchIssues(since?: Date): Promise<VcsIssue[]> {
          return [];
        }

        async fetchIssue(issueNumber: number): Promise<VcsIssue> {
          throw new Error('Not implemented');
        }

        async testConnection(): Promise<{ ok: boolean; error?: string }> {
          return { ok: true };
        }

        async getDefaultBranch(): Promise<string> {
          return 'main';
        }

        async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
          throw new Error('Not implemented');
        }
      }

      const provider = new MockVcsProvider();
      expect(typeof provider.fetchIssues).toBe('function');
    });

    it('should have fetchIssues return Promise<VcsIssue[]>', async () => {
      class MockVcsProvider implements IVcsProvider {
        async fetchIssues(since?: Date): Promise<VcsIssue[]> {
          const now = new Date();
          return [
            {
              number: 1,
              title: 'Issue 1',
              body: null,
              authorLogin: 'user',
              url: 'https://example.com/1',
              labels: [],
              createdAt: now,
            },
          ];
        }

        async fetchIssue(issueNumber: number): Promise<VcsIssue> {
          throw new Error('Not implemented');
        }

        async testConnection(): Promise<{ ok: boolean; error?: string }> {
          return { ok: true };
        }

        async getDefaultBranch(): Promise<string> {
          return 'main';
        }

        async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
          throw new Error('Not implemented');
        }
      }

      const provider = new MockVcsProvider();
      const result = await provider.fetchIssues();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should have fetchIssues accept optional since parameter', async () => {
      class MockVcsProvider implements IVcsProvider {
        async fetchIssues(since?: Date): Promise<VcsIssue[]> {
          if (since) {
            return [];
          }
          return [];
        }

        async fetchIssue(issueNumber: number): Promise<VcsIssue> {
          throw new Error('Not implemented');
        }

        async testConnection(): Promise<{ ok: boolean; error?: string }> {
          return { ok: true };
        }

        async getDefaultBranch(): Promise<string> {
          return 'main';
        }

        async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
          throw new Error('Not implemented');
        }
      }

      const provider = new MockVcsProvider();
      const sinceDate = new Date('2024-01-01');
      const result = await provider.fetchIssues(sinceDate);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should define fetchIssue method with issueNumber parameter', async () => {
      class MockVcsProvider implements IVcsProvider {
        async fetchIssues(since?: Date): Promise<VcsIssue[]> {
          return [];
        }

        async fetchIssue(issueNumber: number): Promise<VcsIssue> {
          return {
            number: issueNumber,
            title: 'Issue',
            body: null,
            authorLogin: 'user',
            url: 'https://example.com',
            labels: [],
            createdAt: new Date(),
          };
        }

        async testConnection(): Promise<{ ok: boolean; error?: string }> {
          return { ok: true };
        }

        async getDefaultBranch(): Promise<string> {
          return 'main';
        }

        async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
          throw new Error('Not implemented');
        }
      }

      const provider = new MockVcsProvider();
      expect(typeof provider.fetchIssue).toBe('function');
    });

    it('should have fetchIssue return Promise<VcsIssue>', async () => {
      class MockVcsProvider implements IVcsProvider {
        async fetchIssues(since?: Date): Promise<VcsIssue[]> {
          return [];
        }

        async fetchIssue(issueNumber: number): Promise<VcsIssue> {
          return {
            number: issueNumber,
            title: `Issue ${issueNumber}`,
            body: 'Description',
            authorLogin: 'user',
            url: `https://example.com/issues/${issueNumber}`,
            labels: ['bug'],
            createdAt: new Date(),
          };
        }

        async testConnection(): Promise<{ ok: boolean; error?: string }> {
          return { ok: true };
        }

        async getDefaultBranch(): Promise<string> {
          return 'main';
        }

        async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
          throw new Error('Not implemented');
        }
      }

      const provider = new MockVcsProvider();
      const issue = await provider.fetchIssue(42);
      expect(issue.number).toBe(42);
      expect(issue.title).toBe('Issue 42');
    });

    it('should define testConnection method', async () => {
      class MockVcsProvider implements IVcsProvider {
        async fetchIssues(since?: Date): Promise<VcsIssue[]> {
          return [];
        }

        async fetchIssue(issueNumber: number): Promise<VcsIssue> {
          throw new Error('Not implemented');
        }

        async testConnection(): Promise<{ ok: boolean; error?: string }> {
          return { ok: true };
        }

        async getDefaultBranch(): Promise<string> {
          return 'main';
        }

        async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
          throw new Error('Not implemented');
        }
      }

      const provider = new MockVcsProvider();
      expect(typeof provider.testConnection).toBe('function');
    });

    it('should have testConnection return Promise<{ ok: boolean; error?: string }>', async () => {
      class MockVcsProvider implements IVcsProvider {
        async fetchIssues(since?: Date): Promise<VcsIssue[]> {
          return [];
        }

        async fetchIssue(issueNumber: number): Promise<VcsIssue> {
          throw new Error('Not implemented');
        }

        async testConnection(): Promise<{ ok: boolean; error?: string }> {
          return { ok: true, error: undefined };
        }

        async getDefaultBranch(): Promise<string> {
          return 'main';
        }

        async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
          throw new Error('Not implemented');
        }
      }

      const provider = new MockVcsProvider();
      const result = await provider.testConnection();
      expect(typeof result.ok).toBe('boolean');
      expect(result.error === undefined || typeof result.error === 'string').toBe(true);
    });

    it('should have testConnection return error on failure', async () => {
      class MockVcsProvider implements IVcsProvider {
        async fetchIssues(since?: Date): Promise<VcsIssue[]> {
          return [];
        }

        async fetchIssue(issueNumber: number): Promise<VcsIssue> {
          throw new Error('Not implemented');
        }

        async testConnection(): Promise<{ ok: boolean; error?: string }> {
          return { ok: false, error: 'Connection failed' };
        }

        async getDefaultBranch(): Promise<string> {
          return 'main';
        }

        async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
          throw new Error('Not implemented');
        }
      }

      const provider = new MockVcsProvider();
      const result = await provider.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Connection failed');
    });
  });
});

describe('VcsIssue and IVcsProvider exports', () => {
  it('should export VcsIssue type', () => {
    const issue: VcsIssue = {
      number: 1,
      title: 'Test',
      body: null,
      authorLogin: 'user',
      url: 'https://example.com',
      labels: [],
      createdAt: new Date(),
    };
    expect(issue).toBeDefined();
  });

  it('should export IVcsProvider interface', () => {
    class TestProvider implements IVcsProvider {
      async fetchIssues(since?: Date): Promise<VcsIssue[]> {
        return [];
      }

      async fetchIssue(issueNumber: number): Promise<VcsIssue> {
        throw new Error('Not implemented');
      }

      async testConnection(): Promise<{ ok: boolean; error?: string }> {
        return { ok: true };
      }

      async getDefaultBranch(): Promise<string> {
        return 'main';
      }

      async createPullRequest(params: CreatePrParams): Promise<VcsPullRequest> {
        throw new Error('Not implemented');
      }
    }
    expect(TestProvider).toBeDefined();
  });
});
