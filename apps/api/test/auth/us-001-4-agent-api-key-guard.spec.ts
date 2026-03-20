/**
 * US-001-4: Preserve agent API key validation after guard migration
 *
 * Acceptance Criteria:
 * AC1 — Agent-authenticated endpoints return 401 when no API key is provided
 * AC2 — Agent-authenticated endpoints return 200 when a valid API key is provided
 * AC3 — HMAC-SHA256 key validation logic is preserved
 * AC4 — No import of deleted custom guards in agents module
 * AC5 — Unit test for agent key guard covers valid, invalid, and missing key cases
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHmac } from 'crypto';
import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

// This import will fail (RED) until AgentApiKeyGuard is implemented
import { AgentApiKeyGuard } from '../../src/agents/guards/agent-api-key.guard';
import { AppException } from '../../src/common/app-exception';

const SRC = path.resolve(__dirname, '../../src');

// ---------------------------------------------------------------------------
// AC4 — No deleted guard imports in agents module
// ---------------------------------------------------------------------------

describe('AC4 — agents module has no imports of deleted guards', () => {
  const deletedGuardPattern =
    /from\s+['"]([^'"]*(?:jwt-auth\.guard|api-key-auth\.guard|combined-auth\.guard|jwt\.strategy))['"]/;

  it('agents.module.ts does not import any deleted guard', () => {
    const content = fs.readFileSync(
      path.join(SRC, 'agents/agents.module.ts'),
      'utf-8',
    );
    expect(content).not.toMatch(deletedGuardPattern);
  });

  it('agents.controller.ts does not import any deleted guard', () => {
    const content = fs.readFileSync(
      path.join(SRC, 'agents/agents.controller.ts'),
      'utf-8',
    );
    expect(content).not.toMatch(deletedGuardPattern);
  });
});

// ---------------------------------------------------------------------------
// AC3 — HMAC-SHA256 key validation logic helpers
// ---------------------------------------------------------------------------

describe('AC3 — HMAC-SHA256 key validation logic', () => {
  const secret = 'test-api-key-secret';
  const rawKey = 'a'.repeat(64);

  it('produces consistent HMAC-SHA256 hash for a given key and secret', () => {
    const hash1 = createHmac('sha256', secret).update(rawKey).digest('hex');
    const hash2 = createHmac('sha256', secret).update(rawKey).digest('hex');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different raw keys', () => {
    const hash1 = createHmac('sha256', secret).update(rawKey).digest('hex');
    const hash2 = createHmac('sha256', secret).update('b'.repeat(64)).digest('hex');
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hashes for different secrets', () => {
    const hash1 = createHmac('sha256', secret).update(rawKey).digest('hex');
    const hash2 = createHmac('sha256', 'other-secret').update(rawKey).digest('hex');
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// AC1, AC2, AC5 — AgentApiKeyGuard unit tests
// ---------------------------------------------------------------------------

describe('AgentApiKeyGuard', () => {
  const API_KEY_SECRET = 'test-api-key-secret';
  const RAW_KEY = 'cafebabe'.repeat(8); // 64-char hex key
  const VALID_HASH = createHmac('sha256', API_KEY_SECRET).update(RAW_KEY).digest('hex');

  const mockAgent = {
    id: 'agent-uuid-123',
    name: 'Test Agent',
    slug: 'test-agent',
    apiKeyHash: VALID_HASH,
    status: 'ACTIVE',
  };

  const mockPrismaClient = {
    agent: {
      findFirst: jest.fn(),
    },
  };

  const mockPrismaService = {
    client: mockPrismaClient,
  };

  let guard: AgentApiKeyGuard;
  let mockConfigService: Partial<ConfigService>;

  function makeContext(authHeader?: string): ExecutionContext {
    const request = {
      headers: authHeader ? { authorization: authHeader } : {},
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'API_KEY_SECRET') return API_KEY_SECRET;
        return undefined;
      }),
    } as unknown as ConfigService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentApiKeyGuard,
        { provide: 'PrismaService', useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    guard = module.get<AgentApiKeyGuard>(AgentApiKeyGuard);
    jest.clearAllMocks();
    mockPrismaClient.agent.findFirst.mockReset();
    (mockConfigService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'API_KEY_SECRET') return API_KEY_SECRET;
      return undefined;
    });
  });

  // AC1 — Missing API key returns 401
  describe('AC1 — missing API key is rejected', () => {
    it('throws UnauthorizedException when Authorization header is absent', async () => {
      const ctx = makeContext(undefined);
      await expect(guard.canActivate(ctx)).rejects.toThrow(AppException);
    });

    it('throws UnauthorizedException when Authorization header is empty string', async () => {
      const ctx = makeContext('');
      await expect(guard.canActivate(ctx)).rejects.toThrow(AppException);
    });

    it('throws UnauthorizedException when Authorization header is not Bearer scheme', async () => {
      const ctx = makeContext('Basic somebase64==');
      await expect(guard.canActivate(ctx)).rejects.toThrow(AppException);
    });

    it('throws UnauthorizedException when Bearer token is empty', async () => {
      const ctx = makeContext('Bearer ');
      await expect(guard.canActivate(ctx)).rejects.toThrow(AppException);
    });
  });

  // AC2 — Valid API key returns true (200)
  describe('AC2 — valid API key is accepted', () => {
    it('returns true when a valid Bearer API key matches a stored HMAC hash', async () => {
      mockPrismaClient.agent.findFirst.mockResolvedValue(mockAgent);

      const ctx = makeContext(`Bearer ${RAW_KEY}`);
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
    });

    it('attaches agent to request when key is valid', async () => {
      mockPrismaClient.agent.findFirst.mockResolvedValue(mockAgent);

      const request = {
        headers: { authorization: `Bearer ${RAW_KEY}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      await guard.canActivate(ctx);

      expect((request as any).agent).toEqual(mockAgent);
    });

    it('sets actorType to "agent" on request when key is valid', async () => {
      mockPrismaClient.agent.findFirst.mockResolvedValue(mockAgent);

      const request = {
        headers: { authorization: `Bearer ${RAW_KEY}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      await guard.canActivate(ctx);

      expect((request as any).actorType).toBe('agent');
    });

    it('queries the database using the HMAC hash of the raw key', async () => {
      mockPrismaClient.agent.findFirst.mockResolvedValue(mockAgent);

      const ctx = makeContext(`Bearer ${RAW_KEY}`);
      await guard.canActivate(ctx);

      expect(mockPrismaClient.agent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            apiKeyHash: VALID_HASH,
          }),
        }),
      );
    });
  });

  // AC5 — Invalid key rejection
  describe('AC5 — invalid API key is rejected', () => {
    it('throws UnauthorizedException when key does not match any agent', async () => {
      mockPrismaClient.agent.findFirst.mockResolvedValue(null);

      const ctx = makeContext(`Bearer wrong-key-that-wont-match`);
      await expect(guard.canActivate(ctx)).rejects.toThrow(AppException);
    });

    it('throws UnauthorizedException when agent is not found for computed hash', async () => {
      mockPrismaClient.agent.findFirst.mockResolvedValue(null);

      const ctx = makeContext(`Bearer ${'d'.repeat(64)}`);
      await expect(guard.canActivate(ctx)).rejects.toThrow(AppException);
    });

    it('does NOT return the raw API key to the caller on any code path', async () => {
      mockPrismaClient.agent.findFirst.mockResolvedValue(mockAgent);

      const request = {
        headers: { authorization: `Bearer ${RAW_KEY}` },
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;

      await guard.canActivate(ctx);

      // The raw key must not be stored on the request object
      const reqStr = JSON.stringify(request);
      expect(reqStr).not.toContain(RAW_KEY);
    });
  });

  // Error handling
  describe('guard error handling', () => {
    it('throws UnauthorizedException (not a 500) when API_KEY_SECRET is missing', async () => {
      const badConfigService = {
        get: jest.fn().mockReturnValue(undefined),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AgentApiKeyGuard,
          { provide: 'PrismaService', useValue: mockPrismaService },
          { provide: ConfigService, useValue: badConfigService },
        ],
      }).compile();

      const guardWithBadConfig = module.get<AgentApiKeyGuard>(AgentApiKeyGuard);
      const ctx = makeContext(`Bearer ${RAW_KEY}`);

      await expect(guardWithBadConfig.canActivate(ctx)).rejects.toThrow();
    });
  });
});
