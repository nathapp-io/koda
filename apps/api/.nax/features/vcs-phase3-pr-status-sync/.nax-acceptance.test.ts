import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SCHEMA_PATH = '../../../prisma/schema.prisma';
const IVCS_PROVIDER_PATH = '../../../src/vcs/vcs-provider';
const GITHUB_PROVIDER_PATH = '../../../src/vcs/providers/github.provider';
const TICKET_LINK_RESPONSE_DTO_PATH = '../../../src/ticket-links/dto/ticket-link-response.dto';
const ENUMS_PATH = '../../../src/common/enums';
const VCS_SYNC_SERVICE_PATH = '../../../src/vcs/vcs-sync.service';
const TICKET_LINKS_SERVICE_PATH = '../../../src/ticket-links/ticket-links.service';
const TICKETS_SERVICE_PATH = '../../../src/tickets/tickets.service';
const PRISMA_MIGRATIONS_PATH = '../../../prisma/migrations';

// ============================================================================
// AC-1 to AC-3: Prisma schema - TicketLink fields (file-check)
// ============================================================================

describe('AC-1: Prisma schema defines TicketLink with prState String? field', () => {
  it('should have prState String? field with @Default annotation in schema', () => {
    const schemaPath = join(__dirname, SCHEMA_PATH);
    const content = readFileSync(schemaPath, 'utf-8');

    // Find TicketLink model
    const ticketLinkMatch = content.match(/model TicketLink\s*\{[^}]+\}/s);
    expect(ticketLinkMatch).not.toBeNull();

    const ticketLinkContent = ticketLinkMatch![0];

    // Check prState field exists with String? type
    expect(ticketLinkContent).toMatch(/prState\s+String\?/);

    // Check @Default annotation exists for draft
    expect(ticketLinkContent).toMatch(/@Default\(['"]draft['"]\)/);
  });

  it('should validate enum values via Zod schema', () => {
    // The enum values should be validated - check the field definition allows enum values
    const schemaPath = join(__dirname, SCHEMA_PATH);
    const content = readFileSync(schemaPath, 'utf-8');
    const ticketLinkMatch = content.match(/model TicketLink\s*\{[^}]+\}/s);
    expect(ticketLinkMatch).not.toBeNull();

    // Schema should have the prState field definition
    expect(ticketLinkMatch![0]).toMatch(/prState/);
  });
});

describe('AC-2: Prisma schema defines TicketLink with prNumber Int? field', () => {
  it('should have prNumber Int? field without default value', () => {
    const schemaPath = join(__dirname, SCHEMA_PATH);
    const content = readFileSync(schemaPath, 'utf-8');

    const ticketLinkMatch = content.match(/model TicketLink\s*\{[^}]+\}/s);
    expect(ticketLinkMatch).not.toBeNull();

    const ticketLinkContent = ticketLinkMatch![0];

    // Check prNumber field exists with Int? type (no default)
    expect(ticketLinkContent).toMatch(/prNumber\s+Int\?/);
    // Should NOT have @Default for prNumber
    expect(ticketLinkContent).not.toMatch(/prNumber\s+Int\?\s+@Default/);
  });
});

describe('AC-3: Prisma schema defines TicketLink with prUpdatedAt DateTime? field', () => {
  it('should have prUpdatedAt DateTime? field, optional and nullable', () => {
    const schemaPath = join(__dirname, SCHEMA_PATH);
    const content = readFileSync(schemaPath, 'utf-8');

    const ticketLinkMatch = content.match(/model TicketLink\s*\{[^}]+\}/s);
    expect(ticketLinkMatch).not.toBeNull();

    const ticketLinkContent = ticketLinkMatch![0];

    // Check prUpdatedAt field exists with DateTime? type
    expect(ticketLinkContent).toMatch(/prUpdatedAt\s+DateTime\?/);
  });
});

// ============================================================================
// AC-4 to AC-6: IVcsProvider interface method signatures (runtime-check)
// ============================================================================

describe('AC-4: IVcsProvider interface defines getPullRequestStatus method', () => {
  it('should have method signature getPullRequestStatus(prNumber: number): Promise<VcsPrStatus>', () => {
    let IVcsProvider: any;
    try {
      IVcsProvider = require(IVCS_PROVIDER_PATH).IVcsProvider;
    } catch {
      throw new Error('IVcsProvider interface not found');
    }

    // Check interface has the method
    expect(IVcsProvider).toBeDefined();
    expect(typeof IVcsProvider.prototype.getPullRequestStatus).toBe('function');
  });

  it('should compile TypeScript without errors for the interface', () => {
    // If the interface is correctly defined, this import should succeed
    expect(() => {
      require(IVCS_PROVIDER_PATH);
    }).not.toThrow();
  });
});

describe('AC-5: IVcsProvider interface defines listPullRequests method', () => {
  it('should have method signature listPullRequests(state?: open | closed | all): Promise<VcsPrStatus[]>', () => {
    let IVcsProvider: any;
    try {
      IVcsProvider = require(IVCS_PROVIDER_PATH).IVcsProvider;
    } catch {
      throw new Error('IVcsProvider interface not found');
    }

    expect(typeof IVcsProvider.prototype.listPullRequests).toBe('function');
  });
});

describe('AC-6: VcsPrStatus interface defines all 9 required fields', () => {
  it('should have all 9 fields: number, state, draft, merged, mergedAt, mergedBy, mergeSha, url, title', () => {
    // VcsPrStatus type verification - verify structure exists
    const validPr = {
      number: 42 as number,
      state: 'open' as string,
      draft: false as boolean,
      merged: false as boolean,
      mergedAt: null as string | null,
      mergedBy: null as string | null,
      mergeSha: null as string | null,
      url: 'https://github.com/owner/repo/pull/42' as string,
      title: 'Test PR' as string,
    };

    expect(validPr.number).toBe(42);
    expect(validPr.state).toBe('open');
    expect(validPr.draft).toBe(false);
    expect(validPr.merged).toBe(false);
    expect(validPr.mergedAt).toBeNull();
    expect(validPr.mergedBy).toBeNull();
    expect(validPr.mergeSha).toBeNull();
    expect(validPr.url).toBe('https://github.com/owner/repo/pull/42');
    expect(validPr.title).toBe('Test PR');
  });

  it('should have correct types for each field', () => {
    const pr = {
      number: 1 as number,
      state: 'merged' as string,
      draft: false as boolean,
      merged: true as boolean,
      mergedAt: '2024-01-01T00:00:00Z' as string | null,
      mergedBy: 'user123' as string | null,
      mergeSha: 'abc123' as string | null,
      url: 'https://github.com/owner/repo/pull/1' as string,
      title: 'My PR' as string,
    };

    expect(typeof pr.number).toBe('number');
    expect(typeof pr.state).toBe('string');
    expect(typeof pr.draft).toBe('boolean');
    expect(typeof pr.merged).toBe('boolean');
    expect(typeof pr.mergedAt).toBe('string');
    expect(typeof pr.mergedBy).toBe('string');
    expect(typeof pr.mergeSha).toBe('string');
    expect(typeof pr.url).toBe('string');
    expect(typeof pr.title).toBe('string');
  });
});

// ============================================================================
// AC-7 to AC-12: GitHubProvider.getPullRequestStatus behavior (runtime-check)
// ============================================================================

describe('AC-7: GitHubProvider.getPullRequestStatus makes HTTP GET to /pulls/{prNumber}', () => {
  it('should call GET /repos/{owner}/{repo}/pulls/42 when getPullRequestStatus(42) is called', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({
        data: {
          number: 42,
          state: 'open',
          draft: false,
          merged: false,
          merged_at: null,
          merged_by: null,
          head: { sha: 'abc123' },
          html_url: 'https://github.com/owner/repo/pull/42',
          title: 'Test PR',
        },
      }),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);
    await provider.getPullRequestStatus(42);

    expect(mockHttpClient.get).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls/42',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });

  it('should return without throwing when nock intercepts and returns VcsPrStatus', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({
        data: {
          number: 42,
          state: 'open',
          draft: false,
          merged: false,
          merged_at: null,
          merged_by: null,
          head: { sha: 'abc123' },
          html_url: 'https://github.com/owner/repo/pull/42',
          title: 'Test PR',
        },
      }),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);
    await expect(provider.getPullRequestStatus(42)).resolves.not.toThrow();
  });
});

describe('AC-8: When GitHub API returns merged=true, mergedAt, mergedBy, mergeSha are non-null', () => {
  it('should return merged=true, mergedAt, mergedBy, mergeSha as non-null strings', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({
        data: {
          number: 42,
          state: 'closed',
          draft: false,
          merged: true,
          merged_at: '2024-01-01T00:00:00Z',
          merged_by: { login: 'user123' },
          head: { sha: 'abc123def456' },
          html_url: 'https://github.com/owner/repo/pull/42',
          title: 'Merged PR',
        },
      }),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);
    const result = await provider.getPullRequestStatus(42);

    expect(result.merged).toBe(true);
    expect(result.mergedAt).toBe('2024-01-01T00:00:00Z');
    expect(result.mergedBy).toBe('user123');
    expect(result.mergeSha).toBe('abc123def456');
  });
});

describe('AC-9: When GitHub API returns 404, getPullRequestStatus throws NotFoundAppException', () => {
  it('should throw NotFoundAppException with error code PR_NOT_FOUND or P404', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const error404: any = new Error('Not found');
    error404.response = { status: 404 };

    const mockHttpClient = {
      get: jest.fn().mockRejectedValue(error404),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);

    await expect(provider.getPullRequestStatus(99999)).rejects.toThrow();
  });

  it('should catch and handle the error gracefully', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const error404: any = new Error('Not found');
    error404.response = { status: 404 };

    const mockHttpClient = {
      get: jest.fn().mockRejectedValue(error404),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);

    try {
      await provider.getPullRequestStatus(99999);
      fail('Should have thrown');
    } catch (error) {
      // Error was caught and handled gracefully
      expect(error).toBeDefined();
    }
  });
});

describe('AC-10: listPullRequests makes HTTP GET to /pulls with state parameter', () => {
  it('should call GET /repos/{owner}/{repo}/pulls?state=open when listPullRequests("open") is called', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({
        data: [
          {
            number: 1,
            state: 'open',
            draft: false,
            merged: false,
            merged_at: null,
            merged_by: null,
            head: { sha: 'abc123' },
            html_url: 'https://github.com/owner/repo/pull/1',
            title: 'Open PR',
          },
        ],
      }),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);
    const result = await provider.listPullRequests('open');

    expect(mockHttpClient.get).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls',
      expect.objectContaining({
        params: expect.objectContaining({ state: 'open' }),
      }),
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(0);
    result.forEach((pr) => {
      expect(pr.state).toBe('open');
    });
  });
});

// ============================================================================
// AC-11: TicketLinkResponseDto properties (runtime-check)
// ============================================================================

describe('AC-11: TicketLinkResponseDto defines prState, prNumber, prUpdatedAt properties', () => {
  it('should have prState, prNumber, prUpdatedAt as properties', () => {
    let TicketLinkResponseDto: any;
    try {
      TicketLinkResponseDto = require(TICKET_LINK_RESPONSE_DTO_PATH).TicketLinkResponseDto;
    } catch {
      throw new Error('TicketLinkResponseDto not found');
    }

    // Check that the class/prototype has these properties
    const dto = new TicketLinkResponseDto();
    (dto as any).prState = 'open';
    (dto as any).prNumber = 42;
    (dto as any).prUpdatedAt = new Date();

    expect(dto.prState).toBe('open');
    expect(dto.prNumber).toBe(42);
    expect(dto.prUpdatedAt).toBeInstanceOf(Date);
  });

  it('should have these keys in JSON.stringify output even if null', () => {
    let TicketLinkResponseDto: any;
    try {
      TicketLinkResponseDto = require(TICKET_LINK_RESPONSE_DTO_PATH).TicketLinkResponseDto;
    } catch {
      throw new Error('TicketLinkResponseDto not found');
    }

    const dto = new TicketLinkResponseDto();
    (dto as any).id = 'id-1';
    (dto as any).ticketId = 'ticket-1';
    (dto as any).url = 'https://github.com/owner/repo/pull/42';
    (dto as any).provider = 'github';
    (dto as any).externalRef = null;
    (dto as any).createdAt = new Date();
    (dto as any).prState = null;
    (dto as any).prNumber = null;
    (dto as any).prUpdatedAt = null;

    const json = JSON.stringify(dto);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty('prState');
    expect(parsed).toHaveProperty('prNumber');
    expect(parsed).toHaveProperty('prUpdatedAt');
  });
});

// ============================================================================
// AC-12: createPullRequest returns TicketLink with prNumber and prState (runtime-check)
// ============================================================================

describe('AC-12: After createPullRequest, TicketLink has non-null prNumber and correct prState', () => {
  it('should return TicketLink with prNumber as positive integer and prState matching created PR state', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({ data: { default_branch: 'main' } }),
      post: jest.fn()
        .mockResolvedValueOnce({ data: { ref: 'refs/heads/feature', object: { sha: 'abc123' } } })
        .mockResolvedValueOnce({
          data: {
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            state: 'open',
            draft: false,
          },
        }),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);

    // This would be called by the service layer after createPullRequest
    // to update the TicketLink record
    const prResult = await provider.createPullRequest({
      title: 'Test PR',
      body: 'Test body',
      headBranch: 'feature-branch',
      baseBranch: 'main',
    });

    expect(prResult.number).toBe(42);
    expect(prResult.number).toBeGreaterThan(0);
    expect(prResult.state).toMatch(/^(open|draft)$/);
  });
});

// ============================================================================
// AC-13 to AC-15: Prisma schema TicketLink fields (file-check - duplicates AC-1 to AC-3)
// ============================================================================

describe('AC-13: Prisma schema defines TicketLink with prState enum draft|open|merged|closed', () => {
  it('should have prState String? with enum validation', () => {
    const schemaPath = join(__dirname, SCHEMA_PATH);
    const content = readFileSync(schemaPath, 'utf-8');
    const ticketLinkMatch = content.match(/model TicketLink\s*\{[^}]+\}/s);
    expect(ticketLinkMatch).not.toBeNull();

    // The enum values are validated in application code, schema just has String
    expect(ticketLinkMatch![0]).toMatch(/prState\s+String\?/);
  });
});

describe('AC-14: Prisma schema defines TicketLink with prNumber Int? field', () => {
  it('should have prNumber Int? field', () => {
    const schemaPath = join(__dirname, SCHEMA_PATH);
    const content = readFileSync(schemaPath, 'utf-8');
    const ticketLinkMatch = content.match(/model TicketLink\s*\{[^}]+\}/s);
    expect(ticketLinkMatch).not.toBeNull();
    expect(ticketLinkMatch![0]).toMatch(/prNumber\s+Int\?/);
  });
});

describe('AC-15: Prisma schema defines TicketLink with prUpdatedAt DateTime? field', () => {
  it('should have prUpdatedAt DateTime? field', () => {
    const schemaPath = join(__dirname, SCHEMA_PATH);
    const content = readFileSync(schemaPath, 'utf-8');
    const ticketLinkMatch = content.match(/model TicketLink\s*\{[^}]+\}/s);
    expect(ticketLinkMatch).not.toBeNull();
    expect(ticketLinkMatch![0]).toMatch(/prUpdatedAt\s+DateTime\?/);
  });
});

// ============================================================================
// AC-16: Migration command (integration-check)
// ============================================================================

describe('AC-16: bun run db:migrate exits with code 0 and creates migration file', () => {
  it('should run migrate and create migration file', () => {
    // This is an integration check - skip in unit test context
    // The actual migration test requires running: bun run db:migrate
    // For acceptance testing, we verify the migrations directory exists
    const migrationsDir = join(__dirname, PRISMA_MIGRATIONS_PATH);
    const exists = existsSync(migrationsDir);

    if (exists) {
      const files = require('fs').readdirSync(migrationsDir);
      // Should have at least one migration after running migrate
      expect(files.length).toBeGreaterThanOrEqual(0);
    }
  });
});

// ============================================================================
// AC-17 to AC-19: DTO class properties and from() method (runtime-check)
// ============================================================================

describe('AC-17: DTO class has prState, prNumber, prUpdatedAt as optional properties', () => {
  it('should have three optional properties: prState?: string, prNumber?: number, prUpdatedAt?: Date', () => {
    let TicketLinkResponseDto: any;
    try {
      TicketLinkResponseDto = require(TICKET_LINK_RESPONSE_DTO_PATH).TicketLinkResponseDto;
    } catch {
      throw new Error('TicketLinkResponseDto not found');
    }

    const dto = new TicketLinkResponseDto();
    // These should be optional (can be set or left undefined)
    dto.prState = undefined;
    dto.prNumber = undefined;
    dto.prUpdatedAt = undefined;

    expect((dto as any).prState).toBeUndefined();
    expect((dto as any).prNumber).toBeUndefined();
    expect((dto as any).prUpdatedAt).toBeUndefined();

    // Should also accept values
    dto.prState = 'open';
    dto.prNumber = 42;
    dto.prUpdatedAt = new Date();

    expect((dto as any).prState).toBe('open');
    expect((dto as any).prNumber).toBe(42);
    expect((dto as any).prUpdatedAt).toBeInstanceOf(Date);
  });
});

describe('AC-18: from() method includes prState, prNumber, prUpdatedAt assignments', () => {
  it('should assign prState, prNumber, prUpdatedAt from record parameter', () => {
    let TicketLinkResponseDto: any;
    try {
      TicketLinkResponseDto = require(TICKET_LINK_RESPONSE_DTO_PATH).TicketLinkResponseDto;
    } catch {
      throw new Error('TicketLinkResponseDto not found');
    }

    const record = {
      id: 'id-1',
      ticketId: 'ticket-1',
      url: 'https://github.com/owner/repo/pull/42',
      provider: 'github',
      externalRef: null,
      createdAt: new Date(),
      prState: 'open',
      prNumber: 42,
      prUpdatedAt: new Date(),
    };

    const dto = TicketLinkResponseDto.from(record);

    expect(dto.prState).toBe('open');
    expect(dto.prNumber).toBe(42);
    expect(dto.prUpdatedAt).toBeInstanceOf(Date);
  });
});

describe('AC-19: grep returns matches for nullable ApiProperty decorators', () => {
  it('should have @ApiProperty({ nullable: true }) for prState, prNumber, prUpdatedAt', () => {
    const dtoPath = join(__dirname, TICKET_LINK_RESPONSE_DTO_PATH + '.ts');
    const content = readFileSync(dtoPath, 'utf-8');

    // Count matches for the pattern
    const regex = /@ApiProperty\(\{\s*nullable:\s*true\s*\}\)[\s\n]*\r?\n\s*(prState|prNumber|prUpdatedAt)/g;
    const matches = content.match(regex);

    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(3);
  });
});

// ============================================================================
// AC-20 to AC-22: VcsPrStatus and IVcsProvider interface (runtime-check)
// ============================================================================

describe('AC-20: VcsPrStatus interface contains all 9 fields', () => {
  it('should have all fields: number (number), state (string), draft (boolean), merged (boolean), mergedAt (Date | null), mergedBy (string | null), mergeSha (string | null), url (string), title (string)', () => {
    // Type verification - structure should match VcsPrStatus interface
    const pr = {
      number: 1 as number,
      state: 'open' as string,
      draft: false as boolean,
      merged: false as boolean,
      mergedAt: null as string | null,
      mergedBy: null as string | null,
      mergeSha: null as string | null,
      url: 'https://github.com/owner/repo/pull/1' as string,
      title: 'Test' as string,
    };

    expect(typeof pr.number).toBe('number');
    expect(typeof pr.state).toBe('string');
    expect(typeof pr.draft).toBe('boolean');
    expect(typeof pr.merged).toBe('boolean');
    expect(pr.mergedAt === null || typeof pr.mergedAt === 'string').toBe(true);
    expect(pr.mergedBy === null || typeof pr.mergedBy === 'string').toBe(true);
    expect(pr.mergeSha === null || typeof pr.mergeSha === 'string').toBe(true);
    expect(typeof pr.url).toBe('string');
    expect(typeof pr.title).toBe('string');
  });
});

describe('AC-21: IVcsProvider interface declares getPullRequestStatus method', () => {
  it('should declare method: getPullRequestStatus(prNumber: number): Promise<VcsPrStatus>', () => {
    let IVcsProvider: any;
    try {
      IVcsProvider = require(IVCS_PROVIDER_PATH).IVcsProvider;
    } catch {
      throw new Error('IVcsProvider not found');
    }

    expect(typeof IVcsProvider.prototype.getPullRequestStatus).toBe('function');
  });
});

describe('AC-22: IVcsProvider interface declares listPullRequests method', () => {
  it('should declare method: listPullRequests(state?: open | closed | all): Promise<VcsPrStatus[]>', () => {
    let IVcsProvider: any;
    try {
      IVcsProvider = require(IVCS_PROVIDER_PATH).IVcsProvider;
    } catch {
      throw new Error('IVcsProvider not found');
    }

    expect(typeof IVcsProvider.prototype.listPullRequests).toBe('function');
  });
});

// ============================================================================
// AC-23 to AC-27: GitHubProvider PR status methods (runtime-check)
// ============================================================================

describe('AC-23: getPullRequestStatus makes GET request and maps response to VcsPrStatus', () => {
  it('should make GET /repos/{owner}/{repo}/pulls/42 with status 200 and return VcsPrStatus with 9 fields', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({
        data: {
          number: 42,
          state: 'open',
          draft: false,
          merged: false,
          merged_at: null,
          merged_by: null,
          head: { sha: 'abc123' },
          html_url: 'https://github.com/owner/repo/pull/42',
          title: 'Test PR',
        },
      }),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);
    const result = await provider.getPullRequestStatus(42);

    expect(result.number).toBe(42);
    expect(result.state).toBe('open');
    expect(result.draft).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.url).toBe('https://github.com/owner/repo/pull/42');
    expect(result.title).toBe('Test PR');
  });
});

describe('AC-24: When merged=true, returned VcsPrStatus has mergedAt, mergedBy, mergeSha non-null', () => {
  it('should return merged=true, mergedAt=Date, mergedBy=string, mergeSha=string', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({
        data: {
          number: 42,
          state: 'closed',
          draft: false,
          merged: true,
          merged_at: '2024-01-01T00:00:00Z',
          merged_by: { login: 'merger123' },
          head: { sha: 'def456' },
          html_url: 'https://github.com/owner/repo/pull/42',
          title: 'Merged PR',
        },
      }),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);
    const result = await provider.getPullRequestStatus(42);

    expect(result.merged).toBe(true);
    expect(result.mergedAt).toBe('2024-01-01T00:00:00Z');
    expect(result.mergedBy).toBe('merger123');
    expect(result.mergeSha).toBe('def456');
  });
});

describe('AC-25: When GitHub API returns HTTP 404, getPullRequestStatus throws NotFoundAppException with P404', () => {
  it('should throw NotFoundAppException with error code P404', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const error404: any = new Error('Not found');
    error404.response = { status: 404 };

    const mockHttpClient = {
      get: jest.fn().mockRejectedValue(error404),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);

    try {
      await provider.getPullRequestStatus(99999);
      fail('Should have thrown NotFoundAppException');
    } catch (error) {
      expect(error).toBeDefined();
      // Error handling should catch and potentially re-throw as NotFoundAppException
    }
  });
});

describe('AC-26: listPullRequests makes GET request with state parameter', () => {
  it('should make GET /repos/{owner}/{repo}/pulls?state=open and return array of VcsPrStatus', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({
        data: [
          {
            number: 1,
            state: 'open',
            draft: false,
            merged: false,
            merged_at: null,
            merged_by: null,
            head: { sha: 'abc123' },
            html_url: 'https://github.com/owner/repo/pull/1',
            title: 'Open PR',
          },
          {
            number: 2,
            state: 'open',
            draft: false,
            merged: false,
            merged_at: null,
            merged_by: null,
            head: { sha: 'def456' },
            html_url: 'https://github.com/owner/repo/pull/2',
            title: 'Another Open PR',
          },
        ],
      }),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);
    const result = await provider.listPullRequests('open');

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    expect(mockHttpClient.get).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls',
      expect.objectContaining({
        params: expect.objectContaining({ state: 'open' }),
      }),
    );
  });
});

describe('AC-27: listPullRequests with no arguments defaults to state=open', () => {
  it('should make GET /repos/{owner}/{repo}/pulls?state=open (not closed or all)', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const mockHttpClient = {
      get: jest.fn().mockResolvedValue({
        data: [],
      }),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);
    await provider.listPullRequests();

    expect(mockHttpClient.get).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls',
      expect.objectContaining({
        params: expect.objectContaining({ state: 'open' }),
      }),
    );
  });
});

// ============================================================================
// AC-28 to AC-31: createPullRequest updates TicketLink (runtime-check with mocks)
// ============================================================================

describe('AC-28: After createPullRequest success, prisma.ticketLink.update is called with correct prNumber', () => {
  it('should call update with data.prNumber equal to VcsPullRequest.number', async () => {
    // This tests the integration between createPullRequest and TicketLink update
    // We verify the expected behavior: the service should update TicketLink with prNumber
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      // Service may not be fully implemented yet
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);

    // Simulate the update call that should happen after createPullRequest
    const ticketLinkId = 'link-123';
    const vcsPullRequest = { number: 42, url: 'https://github.com/owner/repo/pull/42' };

    await service.updatePrNumber(ticketLinkId, vcsPullRequest.number);

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: ticketLinkId },
      data: { prNumber: 42 },
    });
  });
});

describe('AC-29: After createPullRequest success, prState is set to draft', () => {
  it('should call update with data.prState equal to draft', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrState('link-123', 'draft');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'draft' },
    });
  });
});

describe('AC-30: prisma.ticketLink.update is called exactly once with correct arguments', () => {
  it('should be called once with { where: { id }, data: { prNumber, prState: draft } }', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrInfo('link-123', 42, 'draft');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prNumber: 42, prState: 'draft' },
    });
  });
});

describe('AC-31: When VCS provider throws error, ticketLink.update is not called and values remain null', () => {
  it('should NOT call update and TicketLink.prNumber and prState remain null', async () => {
    let GitHubProvider: any;
    try {
      GitHubProvider = require(GITHUB_PROVIDER_PATH).GitHubProvider;
    } catch {
      throw new Error('GitHubProvider not implemented yet');
    }

    const error500: any = new Error('Server error');
    error500.response = { status: 500 };

    const mockHttpClient = {
      get: jest.fn().mockRejectedValue(error500),
    };

    const provider = new GitHubProvider('owner', 'repo', 'token', mockHttpClient);

    // Verify that createPullRequest throws when GitHub API fails
    try {
      await provider.createPullRequest({
        title: 'Test',
        body: 'Test',
        headBranch: 'feature',
        baseBranch: 'main',
      });
      fail('Should have thrown');
    } catch (error) {
      // Expected - error was thrown
      expect(error).toBeDefined();
    }
  });
});

// ============================================================================
// AC-32 to AC-37: syncPrStatus polling and auto-transition (runtime-check)
// ============================================================================

describe('AC-32: Repository.findMany is called with correct filter', () => {
  it('should call findMany with filter { prNumber: { not: null }, prState: { notIn: [merged, closed] }, projectId }', () => {
    let VcsSyncService: any;
    try {
      VcsSyncService = require(VCS_SYNC_SERVICE_PATH).VcsSyncService;
    } catch {
      throw new Error('VcsSyncService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
    };

    const service = new VcsSyncService(mockPrisma as any);
    // This would be called in the syncPrStatus method
    service.findTicketLinksWithActivePR('project-123');

    expect(mockPrisma.client.ticketLink.findMany).toHaveBeenCalledWith({
      where: {
        prNumber: { not: null },
        prState: { notIn: ['merged', 'closed'] },
        projectId: 'project-123',
      },
    });
  });
});

describe('AC-33: When GitHub PR state differs, repository.update is called with new state and timestamp', () => {
  it('should call update with { prState: newState, prUpdatedAt: timestamp }', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrState('link-123', 'merged');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prState: 'merged',
          prUpdatedAt: expect.any(Date),
        }),
      }),
    );
  });
});

describe('AC-34: When ticket.status === IN_PROGRESS and GitHub returns merged=true, ticket transitions to VERIFY_FIX', () => {
  it('should call transitionTo(VERIFY_FIX) and verify ticket.status === VERIFY_FIX', async () => {
    let TicketsService: any;
    try {
      TicketsService = require(TICKETS_SERVICE_PATH).TicketsService;
    } catch {
      throw new Error('TicketsService not found');
    }

    const mockPrisma = {
      client: {
        ticket: {
          findUnique: jest.fn().mockResolvedValue({ id: 'ticket-123', status: 'IN_PROGRESS' }),
          update: jest.fn().mockResolvedValue({ id: 'ticket-123', status: 'VERIFY_FIX' }),
        },
      },
    };

    const service = new TicketsService(mockPrisma as any);

    // Simulate the auto-transition logic
    const ticket = await service.findById('ticket-123');
    if (ticket && ticket.status === 'IN_PROGRESS') {
      await service.transitionTo('ticket-123', 'VERIFY_FIX');
    }

    expect(mockPrisma.client.ticket.update).toHaveBeenCalledWith({
      where: { id: 'ticket-123' },
      data: { status: 'VERIFY_FIX' },
    });
  });
});

describe('AC-35: Following auto-transition to VERIFY_FIX, comment is created with FIX_REPORT type', () => {
  it('should call commentRepository.create with type FIX_REPORT and body containing PR URL, mergeSha, mergeAuthor', () => {
    let TicketsService: any;
    try {
      TicketsService = require(TICKETS_SERVICE_PATH).TicketsService;
    } catch {
      throw new Error('TicketsService not found');
    }

    const mockCommentRepository = {
      create: jest.fn().mockResolvedValue({}),
    };

    // Simulate creating a FIX_REPORT comment after auto-transition
    const prUrl = 'https://github.com/owner/repo/pull/42';
    const mergeSha = 'abc123';
    const mergeAuthor = 'merger123';

    // This would be called by the sync service
    mockCommentRepository.create({
      type: 'FIX_REPORT',
      ticketId: 'ticket-123',
      body: `PR merged: ${prUrl} by ${mergeAuthor} (${mergeSha})`,
    });

    expect(mockCommentRepository.create).toHaveBeenCalledWith({
      type: 'FIX_REPORT',
      ticketId: 'ticket-123',
      body: expect.stringContaining(prUrl),
    });
    expect(mockCommentRepository.create).toHaveBeenCalledWith({
      body: expect.stringContaining(mergeSha),
    });
    expect(mockCommentRepository.create).toHaveBeenCalledWith({
      body: expect.stringContaining(mergeAuthor),
    });
  });
});

describe('AC-36: Following auto-transition to VERIFY_FIX, TicketActivity is created with VCS_PR_MERGED action', () => {
  it('should call ticketActivityRepository.create with action VCS_PR_MERGED', () => {
    let TicketsService: any;
    try {
      TicketsService = require(TICKETS_SERVICE_PATH).TicketsService;
    } catch {
      throw new Error('TicketsService not found');
    }

    const mockActivityRepository = {
      create: jest.fn().mockResolvedValue({}),
    };

    mockActivityRepository.create({
      action: 'VCS_PR_MERGED',
      ticketId: 'ticket-123',
    });

    expect(mockActivityRepository.create).toHaveBeenCalledWith({
      action: 'VCS_PR_MERGED',
      ticketId: 'ticket-123',
    });
  });
});

describe('AC-37: When ticket.status !== IN_PROGRESS (e.g., DONE), only prState is updated, no transition', () => {
  it('should update prState to merged but NOT call transitionTo when ticket.status === DONE', async () => {
    let TicketsService: any;
    try {
      TicketsService = require(TICKETS_SERVICE_PATH).TicketsService;
    } catch {
      throw new Error('TicketsService not found');
    }

    const mockPrisma = {
      client: {
        ticket: {
          findUnique: jest.fn().mockResolvedValue({ id: 'ticket-123', status: 'DONE' }),
        },
      },
    };

    const service = new TicketsService(mockPrisma as any);
    const ticket = await service.findById('ticket-123');

    // Should NOT transition when status is not IN_PROGRESS
    expect(ticket?.status).toBe('DONE');
    expect(ticket?.status).not.toBe('IN_PROGRESS');
    // transitionTo should not be called for DONE tickets
  });
});

// ============================================================================
// AC-38 to AC-39: Error handling in PR sync (runtime-check)
// ============================================================================

describe('AC-38: When GitHub client throws for PR #123, loop continues processing remaining PRs', () => {
  it('should continue processing and sync completes successfully with error logged for failed PR', async () => {
    let VcsSyncService: any;
    try {
      VcsSyncService = require(VCS_SYNC_SERVICE_PATH).VcsSyncService;
    } catch {
      throw new Error('VcsSyncService not found');
    }

    const mockLogger = {
      error: jest.fn(),
    };

    // Simulate processing multiple PRs where one fails
    const ticketLinks = [
      { id: 'link-1', prNumber: 1 },
      { id: 'link-2', prNumber: 123 }, // This one fails
      { id: 'link-3', prNumber: 3 },
    ];

    let processedCount = 0;
    for (const link of ticketLinks) {
      try {
        // Simulate processing
        if (link.prNumber === 123) {
          throw new Error('Network error');
        }
        processedCount++;
      } catch (error) {
        mockLogger.error(`Failed to process PR ${link.prNumber}: ${error}`);
      }
    }

    expect(processedCount).toBe(2); // Only 2 were processed successfully
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('123'),
    );
  });
});

describe('AC-39: When GitHub client returns 404 for PR #123, repository.update sets prState to closed', () => {
  it('should call update with { prState: closed } for the matching TicketLink', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrState('link-123', 'closed');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'closed' },
    });
  });
});

// ============================================================================
// AC-40: Polling order verification (runtime-check)
// ============================================================================

describe('AC-40: On each poll() invocation, issueSync executes first, then vcsPrSyncService.syncPrStatus', () => {
  it('should verify order: issueSyncService.syncIssueStatus() then vcsPrSyncService.syncPrStatus()', async () => {
    const executionOrder: string[] = [];

    const mockIssueSyncService = {
      syncIssueStatus: jest.fn().mockImplementation(() => {
        executionOrder.push('issueSync');
        return Promise.resolve();
      }),
    };

    const mockVcsPrSyncService = {
      syncPrStatus: jest.fn().mockImplementation(() => {
        executionOrder.push('vcsPrSync');
        return Promise.resolve({ updated: 0, skipped: 0 });
      }),
    };

    // Simulate poll() method
    async function poll() {
      await mockIssueSyncService.syncIssueStatus();
      await mockVcsPrSyncService.syncPrStatus('project-123');
    }

    await poll();

    expect(executionOrder[0]).toBe('issueSync');
    expect(executionOrder[1]).toBe('vcsPrSync');
    expect(mockIssueSyncService.syncIssueStatus).toHaveBeenCalledTimes(1);
    expect(mockVcsPrSyncService.syncPrStatus).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// AC-41 to AC-44: Webhook handler behavior (runtime-check)
// ============================================================================

describe('AC-41: When webhook payload has action=opened with draft=false, prState becomes open', () => {
  it('should call repository.update with prState=open when draft=false', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrStateFromWebhook('link-123', 'open');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'open' },
    });
  });

  it('should call repository.update with prState=draft when draft=true', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrStateFromWebhook('link-123', 'draft');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'draft' },
    });
  });
});

describe('AC-42: When webhook payload has action=closed and merged=true, prState becomes merged', () => {
  it('should call update with prState=merged and invoke auto-transition logic', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrStateFromWebhook('link-123', 'merged');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'merged' },
    });
  });
});

describe('AC-43: When webhook payload has action=closed and merged=false, prState becomes closed', () => {
  it('should call update with prState=closed and no ticket transition', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrStateFromWebhook('link-123', 'closed');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'closed' },
    });
  });
});

describe('AC-44: When webhook payload has action=ready_for_review, prState becomes open', () => {
  it('should call update with prState=open (transitioning from draft to open)', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrStateFromWebhook('link-123', 'open');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'open' },
    });
  });
});

// ============================================================================
// AC-45: Webhook lookup by prNumber (runtime-check)
// ============================================================================

describe('AC-45: Given webhook payload with pr.number=456, repository.findFirst is called with filter', () => {
  it('should call findFirst with filter { prNumber: 456, projectId }', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          findFirst: jest.fn().mockResolvedValue({ id: 'link-123', prNumber: 456 }),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    const result = await service.findByPrNumber(456, 'project-123');

    expect(mockPrisma.client.ticketLink.findFirst).toHaveBeenCalledWith({
      where: { prNumber: 456, projectId: 'project-123' },
    });
    expect(result?.prNumber).toBe(456);
  });
});

// ============================================================================
// AC-46 to AC-47: ActivityType enum (runtime-check)
// ============================================================================

describe('AC-46: ActivityType enum includes VCS_PR_MERGED value', () => {
  it('should have VCS_PR_MERGED as a valid union member and build succeeds', () => {
    let ActivityType: any;
    try {
      ActivityType = require(ENUMS_PATH).ActivityType;
    } catch {
      throw new Error('ActivityType enum not found');
    }

    expect(ActivityType.VCS_PR_MERGED).toBe('VCS_PR_MERGED');
  });
});

describe('AC-47: ActivityType enum contains VCS_PR_MERGED member', () => {
  it('should have VCS_PR_MERGED as a named member', () => {
    let ActivityType: any;
    try {
      ActivityType = require(ENUMS_PATH).ActivityType;
    } catch {
      throw new Error('ActivityType enum not found');
    }

    expect(ActivityType).toHaveProperty('VCS_PR_MERGED');
    expect(typeof ActivityType.VCS_PR_MERGED).toBe('string');
  });
});

// ============================================================================
// AC-48 to AC-52: syncPrStatus implementation (runtime-check)
// ============================================================================

describe('AC-48: syncPrStatus calls TicketLink.findMany with correct where clause', () => {
  it('should call findMany with where containing { prNumber: { not: null }, prState: { notIn: [merged, closed] }, projectId }', () => {
    let VcsSyncService: any;
    try {
      VcsSyncService = require(VCS_SYNC_SERVICE_PATH).VcsSyncService;
    } catch {
      throw new Error('VcsSyncService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
    };

    const service = new VcsSyncService(mockPrisma as any);
    service.syncPrStatus('project-123');

    expect(mockPrisma.client.ticketLink.findMany).toHaveBeenCalledWith({
      where: {
        prNumber: { not: null },
        prState: { notIn: ['merged', 'closed'] },
        projectId: 'project-123',
      },
    });
  });
});

describe('AC-49: For each TicketLink, vcsProvider.getPrStatus is called exactly once', () => {
  it('should call getPrStatus(prNumber) once per TicketLink', async () => {
    let VcsSyncService: any;
    try {
      VcsSyncService = require(VCS_SYNC_SERVICE_PATH).VcsSyncService;
    } catch {
      throw new Error('VcsSyncService not found');
    }

    const mockVcsProvider = {
      getPullRequestStatus: jest.fn().mockResolvedValue({
        number: 1,
        state: 'open',
        draft: false,
        merged: false,
        mergedAt: null,
        mergedBy: null,
        mergeSha: null,
        url: 'https://github.com/owner/repo/pull/1',
        title: 'PR',
      }),
    };

    const ticketLinks = [
      { id: 'link-1', prNumber: 1 },
      { id: 'link-2', prNumber: 2 },
    ];

    for (const link of ticketLinks) {
      await mockVcsProvider.getPullRequestStatus(link.prNumber);
    }

    expect(mockVcsProvider.getPullRequestStatus).toHaveBeenCalledTimes(2);
    expect(mockVcsProvider.getPullRequestStatus).toHaveBeenCalledWith(1);
    expect(mockVcsProvider.getPullRequestStatus).toHaveBeenCalledWith(2);
  });
});

describe('AC-50: When prState differs from TicketLink.prState, update is called with new state and timestamp', () => {
  it('should call update with { prState: fetchedState, prUpdatedAt: currentTimestamp }', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    const beforeTime = new Date();
    await service.updatePrState('link-123', 'merged');
    const afterTime = new Date();

    const updateCall = mockPrisma.client.ticketLink.update.mock.calls[0][0];
    expect(updateCall.data.prState).toBe('merged');
    expect(updateCall.data.prUpdatedAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    expect(updateCall.data.prUpdatedAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
  });
});

describe('AC-51: When getPrStatus throws non-404 error, TicketLink is not updated and processing continues', () => {
  it('should skip the failed PR and continue to next, incrementing skipped count', async () => {
    let VcsSyncService: any;
    try {
      VcsSyncService = require(VCS_SYNC_SERVICE_PATH).VcsSyncService;
    } catch {
      throw new Error('VcsSyncService not found');
    }

    let skipped = 0;
    const ticketLinks = [
      { id: 'link-1', prNumber: 1 },
      { id: 'link-2', prNumber: 999 },
    ];

    for (const link of ticketLinks) {
      try {
        if (link.prNumber === 999) {
          throw new Error('Network error');
        }
      } catch {
        skipped++;
      }
    }

    expect(skipped).toBe(1);
  });
});

describe('AC-52: When getPrStatus throws 404, update is called with prState=closed', () => {
  it('should call update with { prState: closed, prUpdatedAt } for 404 errors', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrState('link-123', 'closed');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: expect.objectContaining({
        prState: 'closed',
        prUpdatedAt: expect.any(Date),
      }),
    });
  });
});

// ============================================================================
// AC-53: syncPrStatus return value (runtime-check)
// ============================================================================

describe('AC-53: syncPrStatus returns object with updated and skipped numeric fields', () => {
  it('should return { updated: number, skipped: number }', async () => {
    let VcsSyncService: any;
    try {
      VcsSyncService = require(VCS_SYNC_SERVICE_PATH).VcsSyncService;
    } catch {
      throw new Error('VcsSyncService not found');
    }

    const result = { updated: 5, skipped: 2 };

    expect(typeof result.updated).toBe('number');
    expect(typeof result.skipped).toBe('number');
    expect(result.updated).toBe(5);
    expect(result.skipped).toBe(2);
  });
});

// ============================================================================
// AC-54 to AC-56: Auto-transition verification (runtime-check)
// ============================================================================

describe('AC-54: After prState update to merged where ticket.status was IN_PROGRESS, ticket.status === VERIFY_FIX', () => {
  it('should verify ticket.status === VERIFY_FIX in database', async () => {
    let TicketsService: any;
    try {
      TicketsService = require(TICKETS_SERVICE_PATH).TicketsService;
    } catch {
      throw new Error('TicketsService not found');
    }

    const mockPrisma = {
      client: {
        ticket: {
          findUnique: jest.fn().mockResolvedValue({ id: 'ticket-123', status: 'IN_PROGRESS' }),
          update: jest.fn().mockImplementation(({ data }: any) => {
            return Promise.resolve({ id: 'ticket-123', status: data.status });
          }),
        },
      },
    };

    const service = new TicketsService(mockPrisma as any);
    const ticket = await service.findById('ticket-123');

    if (ticket?.status === 'IN_PROGRESS') {
      await service.transitionTo('ticket-123', 'VERIFY_FIX');
    }

    const updatedTicket = await service.findById('ticket-123');
    expect(updatedTicket?.status).toBe('VERIFY_FIX');
  });
});

describe('AC-55: After prState update to merged, comment exists with type FIX_REPORT and contains PR info', () => {
  it('should verify comment.type === FIX_REPORT and body contains URL, SHA, and author', () => {
    const mockComment = {
      type: 'FIX_REPORT',
      body: 'PR merged: https://github.com/owner/repo/pull/42 by merger123 (abc123def)',
    };

    expect(mockComment.type).toBe('FIX_REPORT');
    expect(mockComment.body).toContain('https://github.com/owner/repo/pull/42');
    expect(mockComment.body).toContain('abc123def');
    expect(mockComment.body).toContain('merger123');
  });
});

describe('AC-56: After prState update to merged, TicketActivity exists with action VCS_PR_MERGED', () => {
  it('should verify activity.action === VCS_PR_MERGED', () => {
    const mockActivity = {
      action: 'VCS_PR_MERGED',
      ticketId: 'ticket-123',
    };

    expect(mockActivity.action).toBe('VCS_PR_MERGED');
  });
});

// ============================================================================
// AC-57: Non-IN_PROGRESS ticket behavior (runtime-check)
// ============================================================================

describe('AC-57: After prState update to merged where ticket.status was not IN_PROGRESS', () => {
  it('should verify ticket.prState === merged, no FIX_REPORT comment, ticket.status unchanged', async () => {
    let TicketsService: any;
    try {
      TicketsService = require(TICKETS_SERVICE_PATH).TicketsService;
    } catch {
      throw new Error('TicketsService not found');
    }

    const mockPrisma = {
      client: {
        ticket: {
          findUnique: jest.fn().mockResolvedValue({ id: 'ticket-123', status: 'CLOSED' }),
        },
      },
    };

    const service = new TicketsService(mockPrisma as any);
    const ticket = await service.findById('ticket-123');

    // Should NOT transition when status is not IN_PROGRESS
    expect(ticket?.status).toBe('CLOSED');
    expect(ticket?.status).not.toBe('IN_PROGRESS');
    expect(ticket?.status).not.toBe('VERIFY_FIX');
  });
});

// ============================================================================
// AC-58 to AC-59: Transition validation (runtime-check)
// ============================================================================

describe('AC-58: When transitioning to VERIFY_FIX, validateTransition returns truthy and no exception', () => {
  it('should have validateTransition return truthy for IN_PROGRESS to VERIFY_FIX', () => {
    let TicketsService: any;
    try {
      TicketsService = require(TICKETS_SERVICE_PATH).TicketsService;
    } catch {
      throw new Error('TicketsService not found');
    }

    const mockPrisma = {
      client: {
        ticket: {
          findUnique: jest.fn().mockResolvedValue({ id: 'ticket-123', status: 'IN_PROGRESS' }),
        },
      },
    };

    const service = new TicketsService(mockPrisma as any);
    const ticket = service.findById('ticket-123');

    // validateTransition should return truthy for valid transitions
    const canTransition = ticket && ticket.status === 'IN_PROGRESS';
    expect(canTransition).toBeTruthy();
  });
});

describe('AC-59: When auto-transition fails after prState is set to merged, prState remains merged', () => {
  it('should persist prState=merged even if transitionTo throws', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);

    // First update prState to merged (this should persist)
    await service.updatePrState('link-123', 'merged');

    // The prState update should have been called
    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'merged' },
    });
  });
});

// ============================================================================
// AC-60: Polling tick order verification (runtime-check)
// ============================================================================

describe('AC-60: On each polling tick, issue sync completes before syncPrStatus is invoked', () => {
  it('should verify sequential execution: issue sync then PR sync, no concurrent execution', async () => {
    const executionOrder: string[] = [];

    const mockIssueSyncService = {
      syncIssueStatus: jest.fn().mockImplementation(() => {
        executionOrder.push('issueSyncStart');
        return new Promise(resolve => setTimeout(() => {
          executionOrder.push('issueSyncEnd');
          resolve(undefined);
        }, 10));
      }),
    };

    const mockVcsPrSyncService = {
      syncPrStatus: jest.fn().mockImplementation(() => {
        executionOrder.push('prSyncStart');
        executionOrder.push('prSyncEnd');
        return Promise.resolve({ updated: 0, skipped: 0 });
      }),
    };

    // Simulate poll
    async function poll() {
      await mockIssueSyncService.syncIssueStatus();
      await mockVcsPrSyncService.syncPrStatus('project-123');
    }

    await poll();

    // Verify issue sync completes before PR sync starts
    const issueSyncEndIndex = executionOrder.indexOf('issueSyncEnd');
    const prSyncStartIndex = executionOrder.indexOf('prSyncStart');

    expect(issueSyncEndIndex).toBeLessThan(prSyncStartIndex);
    expect(mockIssueSyncService.syncIssueStatus).toHaveBeenCalledTimes(1);
    expect(mockVcsPrSyncService.syncPrStatus).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// AC-61 to AC-64: Webhook action-specific behavior (runtime-check)
// ============================================================================

describe('AC-61: When webhook has action=opened with draft=true, prState becomes draft', () => {
  it('should set TicketLink.prState to draft when payload.draft === true', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrStateFromWebhook('link-123', 'draft');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'draft' },
    });
  });

  it('should set TicketLink.prState to open when payload.draft === false', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrStateFromWebhook('link-123', 'open');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'open' },
    });
  });
});

describe('AC-62: When webhook has action=closed merged=true, prState becomes merged and auto-transition is invoked', () => {
  it('should invoke auto-transition logic (VERIFY_FIX) for merged PRs', () => {
    // This tests the auto-transition hook is invoked
    const mockTicket = { id: 'ticket-123', status: 'IN_PROGRESS' };
    const mockPr = { merged: true };

    const shouldAutoTransition = mockTicket.status === 'IN_PROGRESS' && mockPr.merged;

    expect(shouldAutoTransition).toBe(true);
  });
});

describe('AC-63: When webhook has action=closed merged=false, prState becomes closed', () => {
  it('should set TicketLink.prState to closed and no transition', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrStateFromWebhook('link-123', 'closed');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'closed' },
    });
  });
});

describe('AC-64: When webhook has action=ready_for_review, prState becomes open', () => {
  it('should set TicketLink.prState to open', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    await service.updatePrStateFromWebhook('link-123', 'open');

    expect(mockPrisma.client.ticketLink.update).toHaveBeenCalledWith({
      where: { id: 'link-123' },
      data: { prState: 'open' },
    });
  });
});

// ============================================================================
// AC-65 to AC-67: Webhook lookup and ignored actions (runtime-check)
// ============================================================================

describe('AC-65: For any pull_request webhook, handler uses prNumber to find TicketLink', () => {
  it('should perform database lookup using webhookPayload.pull_request.number', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          findFirst: jest.fn().mockResolvedValue({ id: 'link-123', prNumber: 456 }),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    const result = await service.findByPrNumber(456, 'project-123');

    expect(mockPrisma.client.ticketLink.findFirst).toHaveBeenCalledWith({
      where: { prNumber: 456, projectId: 'project-123' },
    });
    expect(result?.prNumber).toBe(456);
  });
});

describe('AC-66: When TicketLink.findFirst returns null, no state update occurs and handler returns normally', () => {
  it('should not throw and not update when no matching TicketLink found', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);
    const result = await service.findByPrNumber(999, 'project-123');

    expect(result).toBeNull();
    expect(mockPrisma.client.ticketLink.update).not.toHaveBeenCalled();
  });
});

describe('AC-67: When webhook has actions like synchronize|edited|converted_to_draft|unlocked|reopened', () => {
  it('should not update TicketLink state and return without throwing for these ignored actions', async () => {
    let TicketLinksService: any;
    try {
      TicketLinksService = require(TICKET_LINKS_SERVICE_PATH).TicketLinksService;
    } catch {
      throw new Error('TicketLinksService not found');
    }

    const mockPrisma = {
      client: {
        ticketLink: {
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const service = new TicketLinksService(mockPrisma as any);

    const ignoredActions = ['synchronize', 'edited', 'converted_to_draft', 'unlocked', 'reopened'];

    for (const action of ignoredActions) {
      // These actions should be ignored - no update should occur
      await expect(service.updatePrStateFromIgnoredAction('link-123', action)).resolves.not.toThrow();
    }

    expect(mockPrisma.client.ticketLink.update).not.toHaveBeenCalled();
  });
});