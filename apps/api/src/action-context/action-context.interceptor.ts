import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  isAgentPrincipal,
  isRunnerPrincipal,
  type KodaPrincipal,
} from '../auth/principal/koda-principal.types';
import { runWithActor, type ActionActor } from './action-context';

/**
 * Permissions P1d US-001: runs every request handler inside the action context of its principal.
 *
 * Registered globally by `ActionContextModule`, so it runs on every route without a per-route
 * decorator. Guards run before interceptors, so `request.user` is already the combined-auth
 * principal when this runs.
 *
 * A runner request stays outside any context: a runner is a machine principal, and nothing it writes
 * is attributed to a user or an agent. A request with no principal (a `@Public()` route) is the same.
 */
@Injectable()
export class ActionContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const principal = ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user;
    if (!principal || isRunnerPrincipal(principal)) return next.handle();

    const actor: ActionActor = { type: isAgentPrincipal(principal) ? 'AGENT' : 'USER', id: principal.id };

    // The handler body is the Observable's subscribe callback, so the context must wrap the
    // subscription — wrapping `next.handle()` alone would leave the handler outside it.
    return new Observable((subscriber) => runWithActor(actor, () => next.handle().subscribe(subscriber)));
  }
}
