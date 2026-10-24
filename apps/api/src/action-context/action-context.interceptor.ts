import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  isAgentPrincipal,
  isRunnerPrincipal,
  type KodaPrincipal,
} from '../auth/principal/koda-principal.types';
import { runWithActionContext } from './action-context';

/**
 * Permissions P1d US-001: runs every request handler inside the action context of its principal.
 *
 * Registered globally by `ActionContextModule`, so it runs on every route without a per-route
 * decorator. Guards run before interceptors, so `request.user` is already the combined-auth
 * principal when this runs.
 *
 * Every request gets a context, including runner requests and public routes without a principal.
 */
@Injectable()
export class ActionContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const principal = ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user;
    const actor = !principal
      ? { type: 'SYSTEM' as const, id: 'anonymous' }
      : isRunnerPrincipal(principal)
        ? { type: 'RUNNER' as const, id: principal.id }
        : { type: isAgentPrincipal(principal) ? 'AGENT' as const : 'USER' as const, id: principal.id };
    const origin = principal !== undefined && isRunnerPrincipal(principal) ? 'runner' as const : 'rest' as const;

    // The handler body is the Observable's subscribe callback, so the context must wrap the
    // subscription — wrapping `next.handle()` alone would leave the handler outside it.
    return new Observable((subscriber) =>
      runWithActionContext({ actor, origin }, () => next.handle().subscribe(subscriber)),
    );
  }
}
