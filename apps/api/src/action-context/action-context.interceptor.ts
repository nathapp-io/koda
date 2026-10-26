import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  isAgentPrincipal,
  isRunnerPrincipal,
  type KodaPrincipal,
} from '../auth/principal/koda-principal.types';
import { routeSurface } from '../permissions/route-surface';
import { assertAuditCoverage, closeAuditScope, openAuditScope, type AuditScope } from './audit-coverage';
import { runWithActionContext } from './action-context';

/**
 * Permissions P1d US-001: runs every request handler inside the action context of its principal.
 *
 * Registered globally by `ActionContextModule`, so it runs on every route without a per-route
 * decorator. Guards run before interceptors, so `request.user` is already the combined-auth
 * principal when this runs.
 *
 * Every request gets a context, including runner requests and public routes without a principal.
 *
 * Permissions P2l US-010: a routed handler also runs inside an audit scope labelled with its route
 * surface (`POST /me/notifications/read-all`, the string `UNAUDITED_SURFACES` matches). The scope is
 * checked once, when the handler's observable completes and before the completion is forwarded, so
 * an unaudited request answers 500 in development and test instead of returning its last value. A
 * handler that errors skips the check: the caller already sees an error.
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
    const surface = routeSurface(ctx.getClass(), ctx.getHandler());

    // The handler body is the Observable's subscribe callback, so the context (and the audit scope)
    // must wrap the subscription — wrapping `next.handle()` alone would leave the handler outside it.
    return new Observable((subscriber) =>
      runWithActionContext({ actor, origin }, () => {
        // A method Nest never routed (`<METHOD>` metadata absent) has no surface to label, so the
        // request runs exactly as it did before the guard existed.
        if (surface === undefined) return next.handle().subscribe(subscriber);

        let scope: AuditScope | undefined;
        const subscription = openAuditScope(surface, (opened) => {
          scope = opened;

          return next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (error) => {
              closeAuditScope(opened);
              subscriber.error(error);
            },
            complete: () => completeChecked(subscriber, opened),
          });
        });

        // A cancelled request (the client disconnected or the stream was unsubscribed before
        // completion) closes the scope too: nothing may be counted in a request that stopped.
        return () => {
          if (scope !== undefined) closeAuditScope(scope);
          subscription.unsubscribe();
        };
      }),
    );
  }
}

/**
 * Forwards the completion, unless the scope wrote and recorded nothing. The check's error replaces
 * the completion: Nest answers a route with the observable's last value only on completion, so an
 * unaudited request answers 500 in `throw` mode. The scope closes either way — its work has settled.
 */
function completeChecked(
  subscriber: { complete: () => void; error: (error: unknown) => void },
  scope: AuditScope,
): void {
  try {
    assertAuditCoverage(scope);
  } catch (error) {
    subscriber.error(error);
    return;
  } finally {
    closeAuditScope(scope);
  }

  subscriber.complete();
}
