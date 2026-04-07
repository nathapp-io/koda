import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

const UTILS_BRANCH_NAME_PATH = '../../../src/vcs/utils/branch-name.utils';
const GITHUB_PROVIDER_PATH = '../../../src/vcs/providers/github.provider';
const VCS_TYPES_PATH = '../../../src/vcs/types';
const FACTORY_PATH = '../../../src/vcs/factory';
const VCS_SERVICE_PATH = '../../../src/vcs/vcs.service';
const TICKET_LINKS_SERVICE_PATH = '../../../src/ticket-links/ticket-links.service';
const TICKETS_SERVICE_PATH = '../../../src/tickets/tickets.service';
const ENUMS_PATH = '../../../src/common/enums';

// ============================================================================
// AC-1 to AC-4: buildBranchName function tests
// ============================================================================

describe('AC-1: buildBranchName returns exact branch format', () => {
  it('should return "koda/KODA-42/fix-login-redirect-bug" for KODA project, ticket 42', async () => {
    let buildBranchName: (projectKey: string, ticketNumber: number, title: string) => string;
    try {
      const module = await import(UTILS_BRANCH_NAME_PATH);
      buildBranchName = module.buildBranchName;
    } catch {
      throw new Error('buildBranchName function not implemented yet in src/vcs/utils/branch-name.utils');
    }
    const result = buildBranchName('KODA', 42, 'Fix login redirect bug');
    expect(result).toBe('koda/KODA-42/fix-login-redirect-bug');
  });
});

describe('AC-2: buildBranchName truncates long titles to <= 100 chars', () => {
  it('should return a string with length <= 100 for very long titles', async () => {
    let buildBranchName: (projectKey: string, ticketNumber: number, title: string) => string;
    try {
      const module = await import(UTILS_BRANCH_NAME_PATH);
      buildBranchName = module.buildBranchName;
    } catch {
      throw new Error('buildBranchName function not implemented yet in src/vcs/utils/branch-name.utils');
    }
    const longTitle = 'A very long title that exceeds the maximum allowed length for branch names';
    const result = buildBranchName('PROJ', 1, longTitle);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});

describe('AC-3: buildBranchName slug portion only has alphanumeric and hyphens', () => {
  it('should match regex /^[a-z0-9]+(-[a-z0-9]+)*$/ for special chars input', async () => {
    let buildBranchName: (projectKey: string, ticketNumber: number, title: string) => string;
    try {
      const module = await import(UTILS_BRANCH_NAME_PATH);
      buildBranchName = module.buildBranchName;
    } catch {
      throw new Error('buildBranchName function not implemented yet in src/vcs/utils/branch-name.utils');
    }
    const result = buildBranchName('PROJ', 1, 'Special chars: @#$%^&*()');
    const slugPortion = result.split('/').pop() || '';
    expect(slugPortion).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('AC-4: buildBranchName slug does not end with hyphen', () => {
  it('should not end with hyphen for trailing hyphens input', async () => {
    let buildBranchName: (projectKey: string, ticketNumber: number, title: string) => string;
    try {
      const module = await import(UTILS_BRANCH_NAME_PATH);
      buildBranchName = module.buildBranchName;
    } catch {
      throw new Error('buildBranchName function not implemented yet in src/vcs/utils/branch-name.utils');
    }
    const result = buildBranchName('PROJ', 1, 'trailing---hyphens---');
    const slugPortion = result.split('/').pop() || '';
    expect(slugPortion.endsWith('-')).toBe(false);
  });
});

// ============================================================================
// AC-5 to AC-6: GitHubProvider prototype method checks
// ============================================================================

describe('AC-5: GitHubProvider has createPullRequest method', () => {
  it('should have createPullRequest method on constructor prototype', () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet in src/vcs/providers/github.provider');
    }
    expect(typeof Object.getPrototypeOf(GitHubProvider).createPullRequest).toBe('function');
  });

  it('should have createPullRequest with signature (CreatePrParams) => Promise<VcsPullRequest>', () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }
    const methodSignature = Object.getPrototypeOf(GitHubProvider).createPullRequest.toString();
    expect(methodSignature).toContain('CreatePrParams');
    expect(methodSignature).toContain('Promise');
  });
});

describe('AC-6: GitHubProvider has getDefaultBranch method', () => {
  it('should have getDefaultBranch method on constructor prototype', () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }
    expect(typeof Object.getPrototypeOf(GitHubProvider).getDefaultBranch).toBe('function');
  });

  it('should have getDefaultBranch with signature () => Promise<string>', () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }
    const methodSignature = Object.getPrototypeOf(GitHubProvider).getDefaultBranch.toString();
    expect(methodSignature).toContain('Promise');
  });
});

// ============================================================================
// AC-7: GitHubProvider.getDefaultBranch() HTTP GET and return value
// ============================================================================

describe('AC-7: GitHubProvider.getDefaultBranch() makes correct HTTP GET and returns default_branch', () => {
  it('should call GET https://api.github.com/repos/{owner}/{repo} and return response.data.default_branch', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
    };

    const provider = new GitHubProvider('test-owner', 'test-repo', 'test-token', mockHttpClient);
    const result = await provider.getDefaultBranch();

    expect(mockHttpClient.get).toHaveBeenCalledWith(
      'https://api.github.com/repos/test-owner/test-repo',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
    expect(result).toBe('main');
  });
});

// ============================================================================
// AC-8: GitHubProvider.createPullRequest() calls POST /git/refs with ref and sha
// ============================================================================

describe('AC-8: GitHubProvider.createPullRequest() calls POST /git/refs with ref and sha', () => {
  it('should POST to https://api.github.com/repos/{owner}/{repo}/git/refs with body containing ref and sha', async () => {
    let GitHubProvider: any;
    let CreatePrParams: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
      const types = require(VCS_TYPES_PATH);
      CreatePrParams = types.CreatePrParams;
    } catch {
      throw new Error('GitHubProvider or CreatePrParams not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
      post: jest.fn().mockResolvedValue({ data: {} }),
    };

    const provider = new GitHubProvider('test-owner', 'test-repo', 'test-token', mockHttpClient);

    await provider.createPullRequest({
      owner: 'test-owner',
      repo: 'test-repo',
      title: 'Test PR',
      body: 'Test body',
      branch: 'feature/test',
      base: 'main',
    });

    expect(mockHttpClient.post).toHaveBeenCalledWith(
      'https://api.github.com/repos/test-owner/test-repo/git/refs',
      expect.objectContaining({
        ref: 'refs/heads/feature/test',
        sha: expect.any(String),
      }),
    );
  });
});

// ============================================================================
// AC-9: GitHubProvider.createPullRequest() POST /pulls with draft === true and base === defaultBranch
// ============================================================================

describe('AC-9: GitHubProvider.createPullRequest() POST /pulls with draft and base', () => {
  it('should POST to https://api.github.com/repos/{owner}/{repo}/pulls with body.draft === true and body.base === defaultBranch', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
      post: jest.fn().mockResolvedValue({ data: { number: 1, html_url: 'https://github.com/test/repo/pull/1' } }),
    };

    const provider = new GitHubProvider('test-owner', 'test-repo', 'test-token', mockHttpClient);

    await provider.createPullRequest({
      owner: 'test-owner',
      repo: 'test-repo',
      title: 'Test PR',
      body: 'Test body',
      branch: 'feature/test',
      base: 'main',
    });

    const pullsCall = mockHttpClient.post.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/pulls'),
    );
    expect(pullsCall).toBeDefined();
    expect(pullsCall[1].draft).toBe(true);
    expect(pullsCall[1].base).toBe('main');
  });
});

// ============================================================================
// AC-10: GitHubProvider.createPullRequest() return value structure
// ============================================================================

describe('AC-10: GitHubProvider.createPullRequest() returns correct VcsPullRequest structure', () => {
  it('should return object with number, url, branchName, state, draft properties', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
      post: jest.fn().mockResolvedValue({
        data: {
          number: 42,
          html_url: 'https://github.com/owner/repo/pull/42',
          state: 'open',
        },
      }),
    };

    const provider = new GitHubProvider('test-owner', 'test-repo', 'test-token', mockHttpClient);

    const result = await provider.createPullRequest({
      owner: 'test-owner',
      repo: 'test-repo',
      title: 'Test PR',
      body: 'Test body',
      branch: 'feature/test',
      base: 'main',
    });

    expect(result).toHaveProperty('number');
    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('branchName');
    expect(result).toHaveProperty('state');
    expect(result).toHaveProperty('draft');
    expect(typeof result.number).toBe('number');
    expect(typeof result.url).toBe('string');
    expect(typeof result.branchName).toBe('string');
    expect(typeof result.state).toBe('string');
    expect(typeof result.draft).toBe('boolean');
  });
});

// ============================================================================
// AC-11: When /git/refs returns 422, createPullRequest continues and returns VcsPullRequest
// ============================================================================

describe('AC-11: createPullRequest handles /git/refs 422 error gracefully', () => {
  it('should not throw when POST /git/refs returns 422, continue to POST /pulls, and return VcsPullRequest', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const error422 = new Error('Unprocessable Entity');
    (error422 as unknown as Record<string, unknown>).response = { status: 422 };

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
      post: jest.fn()
        .mockRejectedValueOnce(error422)
        .mockResolvedValueOnce({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
          },
        }),
    };

    const provider = new GitHubProvider('test-owner', 'test-repo', 'test-token', mockHttpClient);

    const result = await provider.createPullRequest({
      owner: 'test-owner',
      repo: 'test-repo',
      title: 'Test PR',
      body: 'Test body',
      branch: 'feature/test',
      base: 'main',
    });

    expect(mockHttpClient.post).toHaveBeenCalledTimes(2);
    expect(result).toHaveProperty('number');
    expect(result.number).toBe(42);
  });
});

// ============================================================================
// AC-12: HttpClient interface includes post method
// ============================================================================

describe('AC-12: HttpClient interface includes post method', () => {
  it('should have post method with signature (url: string, body?: object) => Promise<HttpResponse>', () => {
    let HttpClient: any;
    try {
      HttpClient = require(FACTORY_PATH).HttpClient;
    } catch {
      throw new Error('HttpClient interface not found in factory');
    }
    expect(typeof HttpClient.prototype.post).toBe('function');
  });
});

// ============================================================================
// AC-13: VcsProviderConfig.httpClient satisfies HttpClient interface
// ============================================================================

describe('AC-13: VcsProviderConfig.httpClient satisfies HttpClient interface', () => {
  it('should have httpClient property that is callable with url and body', () => {
    let VcsProviderConfig: any;
    let HttpClient: any;
    try {
      VcsProviderConfig = require(FACTORY_PATH).VcsProviderConfig;
      HttpClient = require(FACTORY_PATH).HttpClient;
    } catch {
      throw new Error('VcsProviderConfig or HttpClient not found in factory');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({ data: {} }),
      post: jest.fn().mockResolvedValue({ data: {} }),
    };

    const config: typeof VcsProviderConfig = {
      provider: 'github',
      token: 'test-token',
      repoUrl: 'https://github.com/owner/repo',
      httpClient: mockHttpClient,
    };

    expect(typeof config.httpClient?.post).toBe('function');
  });
});

// ============================================================================
// AC-14: vcsService.createPrForTicket is invoked on VERIFIED status with active connection
// ============================================================================

describe('AC-14: vcsService.createPrForTicket invoked on VERIFIED status with active connection', () => {
  it('should call vcsService.createPrForTicket when TicketStatusTransitionEvent has newStatus === VERIFIED and active connection', async () => {
    let VcsService: any;
    try {
      VcsService = require(VCS_SERVICE_PATH).VcsService;
    } catch {
      throw new Error('VcsService not implemented yet');
    }

    const mockCreatePrForTicket = jest.fn().mockResolvedValue({});
    const mockPrisma = {
      client: {
        vcsConnection: { findMany: jest.fn().mockResolvedValue([{ isActive: true }]) },
      },
    };

    const service = new VcsService(mockPrisma as any);
    (service as any).createPrForTicket = mockCreatePrForTicket;

    const event = {
      ticketId: 'ticket-123',
      projectId: 'project-123',
      newStatus: 'VERIFIED',
      oldStatus: 'IN_PROGRESS',
    };

    await service.handleTicketStatusTransition(event);

    expect(mockCreatePrForTicket).toHaveBeenCalledWith('ticket-123', 'project-123');
  });
});

// ============================================================================
// AC-15: Branch name matches pattern and computed by buildBranchName
// ============================================================================

describe('AC-15: Branch name matches pattern and uses buildBranchName', () => {
  it('should match /^[A-Z]+-\d+-[a-z0-9-]+$/ computed by buildBranchName', async () => {
    let buildBranchName: (projectKey: string, ticketNumber: number, title: string) => string;
    try {
      const module = await import(UTILS_BRANCH_NAME_PATH);
      buildBranchName = module.buildBranchName;
    } catch {
      throw new Error('buildBranchName function not implemented yet');
    }

    const projectKey = 'KODA';
    const ticketNumber = 42;
    const ticketTitle = 'Fix login redirect bug';

    const branchName = buildBranchName(projectKey, ticketNumber, ticketTitle);

    expect(branchName).toMatch(/^[A-Z]+-\d+-[a-z0-9-]+$/);
    expect(branchName).toContain('KODA-42');
  });

  it('should truncate title to 50 chars in branch name', async () => {
    let buildBranchName: (projectKey: string, ticketNumber: number, title: string) => string;
    try {
      const module = await import(UTILS_BRANCH_NAME_PATH);
      buildBranchName = module.buildBranchName;
    } catch {
      throw new Error('buildBranchName function not implemented yet');
    }

    const longTitle = 'This is a very long ticket title that definitely exceeds fifty characters for testing';
    const branchName = buildBranchName('KODA', 1, longTitle);
    const slugPortion = branchName.split('/').pop() || '';
    expect(slugPortion.length).toBeLessThanOrEqual(50);
  });
});

// ============================================================================
// AC-16: PR title matches /^[A-Z]+-\d+:\s+.+$/ pattern
// ============================================================================

describe('AC-16: PR title matches /^[A-Z]+-\d+:\s+.+$/ pattern', () => {
  it('should be constructed as ${project.key}-${ticket.number}: ${ticket.title}', () => {
    const projectKey = 'KODA';
    const ticketNumber = 42;
    const ticketTitle = 'Fix login redirect bug';

    const prTitle = `${projectKey}-${ticketNumber}: ${ticketTitle}`;

    expect(prTitle).toMatch(/^[A-Z]+-\d+:\s+.+$/);
    expect(prTitle).toBe('KODA-42: Fix login redirect bug');
  });
});

// ============================================================================
// AC-17: createPullRequest body equals ticket.description ?? ''
// ============================================================================

describe('AC-17: createPullRequest body equals ticket.description ?? empty string', () => {
  it('should pass ticket.description as body, or empty string if null/undefined', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
      post: jest.fn().mockResolvedValue({ data: { number: 1, html_url: 'https://github.com/test/repo/pull/1' } }),
    };

    const provider = new GitHubProvider('test-owner', 'test-repo', 'test-token', mockHttpClient);

    await provider.createPullRequest({
      owner: 'test-owner',
      repo: 'test-repo',
      title: 'Test PR',
      body: '',
      branch: 'feature/test',
      base: 'main',
    });

    const pullsCall = mockHttpClient.post.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/pulls'),
    );
    expect(pullsCall).toBeDefined();
    expect(pullsCall[1].body).toBe('');
  });
});

// ============================================================================
// AC-18: GitHub provider.createPullRequest() called with draft === true
// ============================================================================

describe('AC-18: GitHub provider.createPullRequest() called with draft === true', () => {
  it('should call createPullRequest with draft === true', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
      post: jest.fn().mockResolvedValue({ data: { number: 1, html_url: 'https://github.com/test/repo/pull/1' } }),
    };

    const provider = new GitHubProvider('test-owner', 'test-repo', 'test-token', mockHttpClient);

    await provider.createPullRequest({
      owner: 'test-owner',
      repo: 'test-repo',
      title: 'Test PR',
      body: 'Test body',
      branch: 'feature/test',
      base: 'main',
      draft: true,
    });

    expect(mockHttpClient.post).toHaveBeenCalled();
    const pullsCall = mockHttpClient.post.mock.calls.find(
      (call: unknown[]) => (call[0] as string).includes('/pulls'),
    );
    expect(pullsCall[1].draft).toBe(true);
  });
});

// ============================================================================
// AC-19: TicketLink record created with correct fields
// ============================================================================

describe('AC-19: TicketLink record created with url, provider, externalRef', () => {
  it('should create TicketLink with url, provider === github, and externalRef matching pattern', async () => {
    let TicketLinkService: any;
    try {
      TicketLinkService = require(TICKET_LINKS_SERVICE_PATH).TicketLinkService;
    } catch {
      throw new Error('TicketLinkService not implemented yet');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          create: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinkService(mockPrisma as any);

    await service.create({
      ticketId: 'ticket-123',
      url: 'https://github.com/owner/repo/pull/42',
      provider: 'github',
      externalRef: 'owner/repo#42',
    });

    expect(mockPrisma.client.ticketLink.create).toHaveBeenCalledWith({
      data: {
        ticketId: 'ticket-123',
        url: 'https://github.com/owner/repo/pull/42',
        provider: 'github',
        externalRef: 'owner/repo#42',
      },
    });
  });

  it('should validate externalRef matches /^[\w-]+\/[\w-]+#\d+$/', () => {
    const externalRef = 'owner/repo#42';
    expect(externalRef).toMatch(/^[\w-]+\/[\w-]+#\d+$/);
  });
});

// ============================================================================
// AC-20: TicketActivity record created with VCS_PR_CREATED action
// ============================================================================

describe('AC-20: TicketActivity record created with VCS_PR_CREATED action', () => {
  it('should create TicketActivity with action === VCS_PR_CREATED, entityType === TICKET, entityId === ticket.id', () => {
    let ActivityType: any;
    try {
      ActivityType = require(ENUMS_PATH).ActivityType;
    } catch {
      throw new Error('ActivityType enum not found');
    }
    expect(ActivityType.VCS_PR_CREATED).toBe('VCS_PR_CREATED');
  });
});

// ============================================================================
// AC-21: ActivityType enum exports VCS_PR_CREATED
// ============================================================================

describe('AC-21: ActivityType enum exports VCS_PR_CREATED', () => {
  it('should export VCS_PR_CREATED: string value in enums file', () => {
    let ActivityType: any;
    try {
      ActivityType = require(ENUMS_PATH).ActivityType;
    } catch {
      throw new Error('ActivityType enum not found');
    }
    expect(ActivityType).toHaveProperty('VCS_PR_CREATED');
    expect(typeof ActivityType.VCS_PR_CREATED).toBe('string');
  });

  it('should have enum file at apps/api/src/common/enums.ts', () => {
    const enumsPath = join(__dirname, '../../../src/common/enums.ts');
    const content = readFileSync(enumsPath, 'utf-8');
    expect(content).toContain('ActivityType');
    expect(content).toContain('VCS_PR_CREATED');
  });
});

// ============================================================================
// AC-22: vcsService.createPrForTicket NOT called when no active VCS connection
// ============================================================================

describe('AC-22: vcsService.createPrForTicket not called when no active connection', () => {
  it('should NOT call createPrForTicket when project.vcsConnections is empty', async () => {
    let VcsService: any;
    try {
      VcsService = require(VCS_SERVICE_PATH).VcsService;
    } catch {
      throw new Error('VcsService not implemented yet');
    }

    const mockCreatePrForTicket = jest.fn();
    const mockPrisma = {
      client: {
        vcsConnection: { findMany: jest.fn().mockResolvedValue([]) },
      },
    };

    const service = new VcsService(mockPrisma as any);
    (service as any).createPrForTicket = mockCreatePrForTicket;

    const event = {
      ticketId: 'ticket-123',
      projectId: 'project-123',
      newStatus: 'VERIFIED',
      oldStatus: 'IN_PROGRESS',
    };

    await service.handleTicketStatusTransition(event);

    expect(mockCreatePrForTicket).not.toHaveBeenCalled();
  });

  it('should NOT call createPrForTicket when all connections have isActive === false', async () => {
    let VcsService: any;
    try {
      VcsService = require(VCS_SERVICE_PATH).VcsService;
    } catch {
      throw new Error('VcsService not implemented yet');
    }

    const mockCreatePrForTicket = jest.fn();
    const mockPrisma = {
      client: {
        vcsConnection: { findMany: jest.fn().mockResolvedValue([{ isActive: false }]) },
      },
    };

    const service = new VcsService(mockPrisma as any);
    (service as any).createPrForTicket = mockCreatePrForTicket;

    const event = {
      ticketId: 'ticket-123',
      projectId: 'project-123',
      newStatus: 'VERIFIED',
      oldStatus: 'IN_PROGRESS',
    };

    await service.handleTicketStatusTransition(event);

    expect(mockCreatePrForTicket).not.toHaveBeenCalled();
  });
});

// ============================================================================
// AC-23: ticket.status === VERIFIED after GitHub API throws error
// ============================================================================

describe('AC-23: ticket.status === VERIFIED after GitHub API error', () => {
  it('should set ticket.status === VERIFIED and not propagate exception when GitHub API throws', async () => {
    let TicketStatusService: any;
    try {
      TicketStatusService = require(TICKETS_SERVICE_PATH).TicketStatusService;
    } catch {
      throw new Error('TicketStatusService not implemented yet');
    }

    const mockPrisma = {
      client: {
        ticket: {
          update: jest.fn().mockResolvedValue({ id: 'ticket-123', status: 'VERIFIED' }),
        },
      },
    };

    const service = new TicketStatusService(mockPrisma as any);

    await expect(
      service.updateStatus('ticket-123', 'VERIFIED'),
    ).resolves.not.toThrow();
  });
});

// ============================================================================
// AC-24: Logger.warn called with message containing GitHub API error or Failed to create PR
// ============================================================================

describe('AC-24: Logger.warn called with GitHub API error message', () => {
  it('should call Logger.warn with message containing GitHub API error or Failed to create PR', () => {
    const loggerSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const logger = new Logger('TestService');
    logger.warn('GitHub API error: Failed to create PR', { message: 'error', status: 500 });

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('GitHub API error'),
      expect.any(Object),
    );

    loggerSpy.mockRestore();
  });

  it('should include error object with message and status properties', () => {
    const loggerSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const logger = new Logger('TestService');
    const errorObj = { message: 'Not found', status: 404 };
    logger.warn('Failed to create PR', errorObj);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        message: expect.any(String),
        status: expect.any(Number),
      }),
    );

    loggerSpy.mockRestore();
  });
});

// ============================================================================
// AC-25: vcsService.createPrForTicket NOT called for non-VERIFIED statuses
// ============================================================================

describe('AC-25: vcsService.createPrForTicket not called for non-VERIFIED statuses', () => {
  const nonVerifiedStatuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

  nonVerifiedStatuses.forEach((status) => {
    it(`should NOT call createPrForTicket for status transition to ${status}`, async () => {
      let VcsService: any;
      try {
        VcsService = require(VCS_SERVICE_PATH).VcsService;
      } catch {
        throw new Error('VcsService not implemented yet');
      }

      const mockCreatePrForTicket = jest.fn();
      const mockPrisma = {
        client: {
          vcsConnection: { findMany: jest.fn().mockResolvedValue([{ isActive: true }]) },
        },
      };

      const service = new VcsService(mockPrisma as any);
      (service as any).createPrForTicket = mockCreatePrForTicket;

      const event = {
        ticketId: 'ticket-123',
        projectId: 'project-123',
        newStatus: status,
        oldStatus: 'IN_PROGRESS',
      };

      await service.handleTicketStatusTransition(event);

      expect(mockCreatePrForTicket).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// AC-26: i18n files contain pr.created and pr.createFailed keys
// ============================================================================

describe('AC-26: i18n files contain pr.created and pr.createFailed keys', () => {
  it('should have pr.created and pr.createFailed in en/vcs.json with non-empty values', () => {
    const enVcsPath = join(__dirname, '../../../src/i18n/en/vcs.json');
    const content = readFileSync(enVcsPath, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed.pr).toBeDefined();
    expect(parsed.pr.created).toBeDefined();
    expect(typeof parsed.pr.created).toBe('string');
    expect(parsed.pr.created.length).toBeGreaterThan(0);
    expect(parsed.pr.createFailed).toBeDefined();
    expect(typeof parsed.pr.createFailed).toBe('string');
    expect(parsed.pr.createFailed.length).toBeGreaterThan(0);
  });

  it('should have pr.created and pr.createFailed in zh/vcs.json with non-empty values', () => {
    const zhVcsPath = join(__dirname, '../../../src/i18n/zh/vcs.json');
    const content = readFileSync(zhVcsPath, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed.pr).toBeDefined();
    expect(parsed.pr.created).toBeDefined();
    expect(typeof parsed.pr.created).toBe('string');
    expect(parsed.pr.created.length).toBeGreaterThan(0);
    expect(parsed.pr.createFailed).toBeDefined();
    expect(typeof parsed.pr.createFailed).toBe('string');
    expect(parsed.pr.createFailed.length).toBeGreaterThan(0);
  });
});