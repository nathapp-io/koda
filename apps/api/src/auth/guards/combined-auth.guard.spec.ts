import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '@nathapp/nestjs-auth';
import { AuthException } from '@nathapp/nestjs-common';
import { AUTH_CFG, IAuthConfig } from '../../config/auth.config';
import { CombinedAuthGuard } from './combined-auth.guard';
import { RUNNER_ROUTE_KEY } from './runner-route.decorator';
import type { PrismaAuthRepository } from '../prisma-auth.repository';
import type { AgentAuthProvider } from '../agent-auth.provider';

function makeReflector(isPublic = false, isRunnerRoute = false): jest.Mocked<Reflector> {
  return {
    getAllAndOverride: jest.fn((key: string) => (key === IS_PUBLIC_KEY ? isPublic : key === RUNNER_ROUTE_KEY ? isRunnerRoute : undefined)),
  } as unknown as jest.Mocked<Reflector>;
}

function makeAuthRepo(agent: unknown = null, runner: unknown = null): jest.Mocked<PrismaAuthRepository> {
  return {
    findAgentByKeyHash: jest.fn().mockResolvedValue(agent),
    findRunnerByKeyHash: jest.fn().mockResolvedValue(runner),
  } as unknown as jest.Mocked<PrismaAuthRepository>;
}

function makeConfig(apiKeySecret: string | undefined = 'super-secret'): IAuthConfig {
  return {
    apiKeySecret,
    jwtSecret: undefined,
    jwtExpiresIn: '15m',
    jwtRefreshSecret: undefined,
    jwtRefreshExpiresIn: '7d',
    registrationEnabled: false,
  };
}

function makeAgentAuthProvider(principal = { actorType: 'agent', id: 'agent-1' }): jest.Mocked<AgentAuthProvider> {
  return {
    buildPrincipal: jest.fn().mockResolvedValue(principal),
  } as unknown as jest.Mocked<AgentAuthProvider>;
}

function buildRequest(authHeader: string): Record<string, unknown> {
  return {
    headers: { authorization: authHeader },
    user: undefined,
  };
}

function buildContext(request: Record<string, unknown>, isPublic = false): ExecutionContext {
  const handler = function myHandler() {};
  const clazz = class MyController {};
  return {
    getHandler: () => handler,
    getClass: () => clazz,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('CombinedAuthGuard', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('public routes', () => {
    it('returns true for routes marked @Public()', async () => {
      const reflector = makeReflector(true);
      const guard = new CombinedAuthGuard(
        reflector,
        makeAuthRepo(),
        makeConfig(),
        makeAgentAuthProvider(),
      );

      const ctx = buildContext(buildRequest(''));
      reflector.getAllAndOverride.mockReturnValue(true);

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
    });
  });

  describe('API key authentication', () => {
    it('returns true when a valid non-JWT Bearer token matches an active agent', async () => {
      const mockAgent = { id: 'agent-1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'somehash' };
      const authRepo = makeAuthRepo(mockAgent);
      const agentAuth = makeAgentAuthProvider();
      const reflector = makeReflector(false);

      const guard = new CombinedAuthGuard(reflector, authRepo, makeConfig(), agentAuth);

      // Patch super.canActivate so it doesn't actually run JWT logic
      jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate').mockResolvedValue(true);

      const request = buildRequest('Bearer not-a-jwt-token');
      const ctx = buildContext(request);

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(agentAuth.buildPrincipal).toHaveBeenCalledWith(mockAgent);
      expect(request['user']).toBeDefined();
    });

    it('skips API key path for JWT-shaped tokens (3 dots)', async () => {
      const authRepo = makeAuthRepo(null);
      const reflector = makeReflector(false);
      const guard = new CombinedAuthGuard(reflector, authRepo, makeConfig(), makeAgentAuthProvider());

      const jwtToken = 'header.payload.signature';

      // Mock the parent JWT canActivate to return true to avoid real JWT validation
      jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate').mockResolvedValue(true);

      const request = buildRequest(`Bearer ${jwtToken}`);
      const ctx = buildContext(request);

      await guard.canActivate(ctx);

      // Agent lookup should not have been called for a JWT-shaped token
      expect(authRepo.findAgentByKeyHash).not.toHaveBeenCalled();
    });

    it('returns false for API key when agent has OFFLINE status', async () => {
      const offlineAgent = { id: 'agent-2', slug: 'bot', status: 'OFFLINE', apiKeyHash: 'hash' };
      const authRepo = makeAuthRepo(offlineAgent);
      const reflector = makeReflector(false);
      const guard = new CombinedAuthGuard(reflector, authRepo, makeConfig(), makeAgentAuthProvider());

      // Falls back to JWT after API key fails
      jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate').mockResolvedValue(true);

      const request = buildRequest('Bearer not-a-jwt');
      const ctx = buildContext(request);

      await guard.canActivate(ctx);

      // user should NOT have been set by agent auth (because OFFLINE)
      // The JWT fallback ran instead (mocked to true)
      expect(request['user']).toBeUndefined();
    });

    it('falls back to JWT when no agent found for key', async () => {
      const authRepo = makeAuthRepo(null);
      const reflector = makeReflector(false);
      const guard = new CombinedAuthGuard(reflector, authRepo, makeConfig(), makeAgentAuthProvider());

      const jwtCanActivate = jest
        .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
        .mockResolvedValue(true);

      const ctx = buildContext(buildRequest('Bearer not-a-jwt'));

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(jwtCanActivate).toHaveBeenCalled();
    });

    it('returns false for empty Bearer token', async () => {
      const authRepo = makeAuthRepo(null);
      const reflector = makeReflector(false);
      const guard = new CombinedAuthGuard(reflector, authRepo, makeConfig(), makeAgentAuthProvider());

      jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate').mockResolvedValue(true);

      const request = buildRequest('Bearer ');
      const ctx = buildContext(request);

      await guard.canActivate(ctx);

      // Empty key should skip API key check and go to JWT
      expect(authRepo.findAgentByKeyHash).not.toHaveBeenCalled();
    });

    it('falls back to JWT when apiKeySecret is not configured', async () => {
      const config = makeConfig(undefined);
      const authRepo = makeAuthRepo();
      const reflector = makeReflector(false);
      const guard = new CombinedAuthGuard(reflector, authRepo, config, makeAgentAuthProvider());

      const jwtCanActivate = jest
        .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
        .mockResolvedValue(true);

      const ctx = buildContext(buildRequest('Bearer somekey'));

      await guard.canActivate(ctx);

      expect(jwtCanActivate).toHaveBeenCalled();
    });
  });

  describe('JWT fallback', () => {
    it('rethrows exceptions from JWT canActivate', async () => {
      const reflector = makeReflector(false);
      const guard = new CombinedAuthGuard(reflector, makeAuthRepo(null), makeConfig(), makeAgentAuthProvider());

      const jwtError = Object.assign(new Error('Unauthorized'), { status: 401 });
      jest
        .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
        .mockRejectedValue(jwtError);

      const ctx = buildContext(buildRequest('Bearer not.a.jwt'));

      await expect(guard.canActivate(ctx)).rejects.toThrow('Unauthorized');
    });
  });

  describe('runner keys (fleet)', () => {
    const runnerRow = { id: 'run-1', name: 'mac-1', labels: ['darwin'], enabled: true };
    const superSpy = (guard: CombinedAuthGuard) =>
      jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate').mockResolvedValue(true);

    it('authenticates a kr_ key on a runner route and sets the runner principal', async () => {
      const repo = makeAuthRepo(null, runnerRow);
      const guard = new CombinedAuthGuard(makeReflector(false, true), repo, makeConfig(), makeAgentAuthProvider());
      const jwt = superSpy(guard);
      const request = buildRequest('Bearer kr_' + 'a'.repeat(64));

      await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
      expect(request['user']).toEqual(expect.objectContaining({ actorType: 'runner', id: 'run-1', runnerName: 'mac-1', enabled: true }));
      expect(repo.findAgentByKeyHash).not.toHaveBeenCalled();
      expect(jwt).not.toHaveBeenCalled();
    });

    it('keeps a disabled runner authenticated (drain) and marks it', async () => {
      const guard = new CombinedAuthGuard(makeReflector(false, true), makeAuthRepo(null, { ...runnerRow, enabled: false }), makeConfig(), makeAgentAuthProvider());
      const request = buildRequest('Bearer kr_' + 'b'.repeat(64));
      await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
      expect(request['user']).toEqual(expect.objectContaining({ enabled: false, blacklisted: false }));
    });

    it('rejects an unknown kr_ key on a runner route with 401', async () => {
      const guard = new CombinedAuthGuard(makeReflector(false, true), makeAuthRepo(null, null), makeConfig(), makeAgentAuthProvider());
      await expect(guard.canActivate(buildContext(buildRequest('Bearer kr_nope')))).rejects.toBeInstanceOf(AuthException);
    });

    it('rejects a kr_ key on a non-runner route without an agent lookup or JWT fallback', async () => {
      const repo = makeAuthRepo({ id: 'agent-1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'x' }, runnerRow);
      const guard = new CombinedAuthGuard(makeReflector(false, false), repo, makeConfig(), makeAgentAuthProvider());
      const jwt = superSpy(guard);
      await expect(guard.canActivate(buildContext(buildRequest('Bearer kr_' + 'c'.repeat(64))))).rejects.toBeInstanceOf(AuthException);
      expect(repo.findAgentByKeyHash).not.toHaveBeenCalled();
      expect(repo.findRunnerByKeyHash).not.toHaveBeenCalled();
      expect(jwt).not.toHaveBeenCalled();
    });

    it.each([
      ['a JWT', 'Bearer aaa.bbb.ccc'],
      ['an agent key', 'Bearer ' + 'd'.repeat(64)],
      ['no credentials', ''],
    ])('rejects %s on a runner route with 401', async (_label, header) => {
      const repo = makeAuthRepo({ id: 'agent-1', slug: 'bot', status: 'ACTIVE', apiKeyHash: 'x' }, runnerRow);
      const guard = new CombinedAuthGuard(makeReflector(false, true), repo, makeConfig(), makeAgentAuthProvider());
      const jwt = superSpy(guard);
      await expect(guard.canActivate(buildContext(buildRequest(header)))).rejects.toBeInstanceOf(AuthException);
      expect(repo.findAgentByKeyHash).not.toHaveBeenCalled();
      expect(jwt).not.toHaveBeenCalled();
    });

    it('fails closed on a kr_ key when API_KEY_SECRET is not configured', async () => {
      const guard = new CombinedAuthGuard(makeReflector(false, true), makeAuthRepo(null, runnerRow), makeConfig(''), makeAgentAuthProvider());
      await expect(guard.canActivate(buildContext(buildRequest('Bearer kr_' + 'e'.repeat(64))))).rejects.toBeInstanceOf(AuthException);
    });

    it('still allows public routes marked as runner routes (enroll)', async () => {
      const guard = new CombinedAuthGuard(makeReflector(true, true), makeAuthRepo(), makeConfig(), makeAgentAuthProvider());
      await expect(guard.canActivate(buildContext(buildRequest('')))).resolves.toBe(true);
    });
  });
});
