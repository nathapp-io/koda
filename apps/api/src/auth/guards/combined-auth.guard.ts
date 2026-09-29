import { ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, JwtAuthGuard } from '@nathapp/nestjs-auth';
import { AuthException } from '@nathapp/nestjs-common';
import { createHmac } from 'crypto';
import { AgentAuthProvider } from '../agent-auth.provider';
import { PrismaAuthRepository } from '../prisma-auth.repository';
import { AUTH_CFG, IAuthConfig } from '../../config/auth.config';
import { RUNNER_KEY_PREFIX, RUNNER_ROUTE_KEY } from './runner-route.decorator';
import type { RunnerDomain } from '../domain/auth.domain';
import type { RunnerPrincipal } from '../principal/koda-principal.types';

@Injectable()
export class CombinedAuthGuard extends JwtAuthGuard {
  private readonly combinedLogger = new Logger(CombinedAuthGuard.name);

  constructor(
    private readonly myReflector: Reflector,
    private readonly authRepo: PrismaAuthRepository,
    @Inject(AUTH_CFG) private readonly authConfig: IAuthConfig,
    private readonly agentAuthProvider: AgentAuthProvider,
  ) {
    super(myReflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const clazz = context.getClass();

    const isPublic = this.myReflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, clazz]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    this.combinedLogger.debug(`canActivate: handler=${handler.name}, class=${clazz.name}`);

    // Fleet runner isolation (spec §1): fail closed in both directions, never fall back.
    const isRunnerRoute = this.myReflector.getAllAndOverride<boolean>(RUNNER_ROUTE_KEY, [handler, clazz]) === true;
    const bearer = this.bearerToken(request);
    if (bearer.startsWith(RUNNER_KEY_PREFIX)) {
      if (!isRunnerRoute) throw new AuthException({}, 'fleet.runnerAuth');
      request['user'] = await this.authenticateRunner(bearer);
      return true;
    }
    if (isRunnerRoute) throw new AuthException({}, 'fleet.runnerAuth');

    // Try API Key first (deterministic: no JWT structure = potential API key)
    try {
      const isAgent = await this.tryApiKey(context);
      this.combinedLogger.debug(`tryApiKey result: ${isAgent}`);
      if (isAgent) {
        const userId = (request['user'] as { id?: string } | undefined)?.id ?? 'unknown';
        this.combinedLogger.debug(`API key auth succeeded, userId=${userId}`);
        return true;
      }
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      this.combinedLogger.error(`API key error: ${error}`);
    }

    // Fall back to JWT
    this.combinedLogger.debug('Falling back to JWT auth...');
    try {
      const result = await super.canActivate(context);
      this.combinedLogger.debug(`JWT canActivate result: ${result}, req.user set: ${request['user'] !== undefined}`);
      return result as boolean;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const status = (error as Record<string, unknown>)?.status ?? 'unknown';
      this.combinedLogger.debug(`JWT auth threw: ${err.message} (status: ${status})`);
      // Re-throw so the original 401/403 exception propagates correctly
      throw error;
    }
  }

  private async tryApiKey(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const rawKey = this.bearerToken(request);
    if (!rawKey) return false;

    // JWTs always have exactly 3 dot-separated parts; skip them
    if (rawKey.split('.').length === 3) return false;

    const secret = this.authConfig.apiKeySecret;
    if (!secret) {
      this.combinedLogger.error('auth.apiKeySecret not configured');
      return false;
    }

    const keyHash = createHmac('sha256', secret).update(rawKey).digest('hex');

    const agent = await this.authRepo.findAgentByKeyHash(keyHash);

    if (!agent) return false;
    // OFFLINE means decommissioned — no longer allowed to authenticate.
    // PAUSED agents may still authenticate (they are operationally paused, not decommissioned).
    if (agent.status === 'OFFLINE') return false;

    request['user'] = await this.agentAuthProvider.buildPrincipal(agent);

    return true;
  }

  private bearerToken(request: Record<string, unknown>): string {
    const headers = request['headers'] as Record<string, string | string[]> | undefined;
    const value = headers?.['authorization'];
    const header = Array.isArray(value) ? value[0] : (value ?? '');
    return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  }

  private async authenticateRunner(rawKey: string): Promise<RunnerPrincipal> {
    const secret = this.authConfig.apiKeySecret;
    if (!secret) {
      this.combinedLogger.error('auth.apiKeySecret not configured');
      throw new AuthException({}, 'fleet.runnerAuth');
    }
    const keyHash = createHmac('sha256', secret).update(rawKey).digest('hex');
    const runner = await this.authRepo.findRunnerByKeyHash(keyHash);
    if (!runner) throw new AuthException({}, 'fleet.runnerAuth');
    return toRunnerPrincipal(runner);
  }
}

export function toRunnerPrincipal(runner: RunnerDomain): RunnerPrincipal {
  return {
    actorType: 'runner',
    id: runner.id,
    name: runner.name,
    runnerName: runner.name,
    labels: runner.labels,
    enabled: runner.enabled,
    blacklisted: false,
    revoked: false,
    authorities: [],
  };
}
