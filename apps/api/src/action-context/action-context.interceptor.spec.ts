import { Controller, Logger, Post } from '@nestjs/common';
import { runWithContext } from '@nathapp/nestjs-logging';
import { firstValueFrom, Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { restoreEnvAfterEach } from '../common/test-helpers/restore-env';
import {
  UnauditedWriteError,
  currentAuditScope,
  noteAuditEntry,
  noteAuditWrite,
} from './audit-coverage';
import { currentContext, currentActor, NO_APPROVAL } from './action-context';
import { ActionContextInterceptor } from './action-context.interceptor';

/** A routed controller: Nest metadata, never instantiated here. */
@Controller('x')
class XController {
  @Post()
  write(): void {}
}

/** A controller whose route is on the coverage allowlist. */
@Controller('me')
class MeController {
  @Post('notifications/read-all')
  readAll(): void {}
}

/** A method with no route decorator: Nest never routes it, so it has no surface. */
class UnroutedController {
  run(): void {}
}

/** What `getClass()` and `getHandler()` answer for a request. */
interface Route {
  controller: Function;
  handler: Function;
}

const POST_X: Route = { controller: XController, handler: XController.prototype.write };
const READ_ALL: Route = { controller: MeController, handler: MeController.prototype.readAll };
const NO_ROUTE: Route = { controller: UnroutedController, handler: UnroutedController.prototype.run };

/**
 * The `ExecutionContext` Nest hands an interceptor. `getClass()` and `getHandler()` answer the
 * controller and the prototype method Nest routed, which the interceptor turns into the audit
 * scope's surface; the default answers a method Nest never routed, so the request stays unscoped.
 */
const requestWith = (user?: KodaPrincipal, route: Route = NO_ROUTE): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getClass: () => route.controller,
    getHandler: () => route.handler,
  }) as unknown as ExecutionContext;

type Emit = (subscriber: { next: (value: unknown) => void; complete: () => void; error: (error: unknown) => void }) => void;

/** A handler whose body runs on subscription, exactly as a route handler runs when Nest subscribes. */
const handlerDoing = (emit: Emit): CallHandler => ({
  handle: () => new Observable((subscriber) => emit(subscriber)),
});

const handlerRecordingContext = (): CallHandler => ({
  handle: () => new Observable((subscriber) => {
    subscriber.next(currentContext());
    subscriber.complete();
  }),
});

/** Writes a counted row, records nothing, then emits `ok` and completes. */
const handlerWritingUnrecorded = (): CallHandler =>
  handlerDoing((subscriber) => {
    noteAuditWrite('Ticket.update');
    subscriber.next('ok');
    subscriber.complete();
  });

/** The emitted context, read with a completion-observing subscription. */
const emittedContext = async (user?: KodaPrincipal, route: Route = NO_ROUTE) =>
  firstValueFrom(new ActionContextInterceptor().intercept(requestWith(user, route), handlerRecordingContext()));

interface Outcome {
  values: unknown[];
  completed: boolean;
  error: unknown;
}

/**
 * Subscribes the interceptor's observable and reports what it did. A completion-observing
 * subscription, not `firstValueFrom`: the completion and its absence are what several ACs assert.
 */
const runIntercept = (ctx: ExecutionContext, next: CallHandler): Promise<Outcome> =>
  new Promise((resolve) => {
    const outcome: Outcome = { values: [], completed: false, error: undefined };
    new ActionContextInterceptor().intercept(ctx, next).subscribe({
      next: (value) => outcome.values.push(value),
      error: (error) => {
        outcome.error = error;
        resolve(outcome);
      },
      complete: () => {
        outcome.completed = true;
        resolve(outcome);
      },
    });
  });

/** `test-setup.ts` no-ops `Logger.prototype.error` for the whole run; assert on that same spy, cleared. */
function errorLogger(): ReturnType<typeof vi.spyOn> {
  const logger = vi.spyOn(Logger.prototype, 'error');
  logger.mockClear();
  return logger;
}

const AGENT = { actorType: 'agent', id: 'a1', slug: 'a1', status: 'ACTIVE', agentRoles: [], capabilities: [] } as unknown as KodaPrincipal;
const USER = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u1@koda.test' } as KodaPrincipal;
const RUNNER = { actorType: 'runner', id: 'r1', runnerName: 'r1', labels: [], enabled: true, capacity: 1 } as unknown as KodaPrincipal;

describe('ActionContextInterceptor', () => {
  restoreEnvAfterEach();

  // Every coverage AC but AC-8 runs in the guard's `throw` mode; `.env.test` sets no `ENV_NAME`, and
  // `restoreEnvAfterEach` puts back whatever the run inherited.
  beforeEach(() => {
    delete process.env['ENV_NAME'];
  });

  it('AC-1/2: maps user to USER/rest in subscription context', async () => {
    const context = await emittedContext(USER);
    expect(context?.actor).toEqual({ type: 'USER', id: 'u1' });
    expect(context?.origin).toBe('rest');
  });

  it('AC-3: maps agent to AGENT', async () => {
    expect((await emittedContext(AGENT))?.actor).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('AC-4/5: maps runner to RUNNER/runner', async () => {
    const context = await emittedContext(RUNNER);
    expect(context?.actor).toEqual({ type: 'RUNNER', id: 'r1' });
    expect(context?.origin).toBe('runner');
  });

  it('AC-6/7: maps no principal to SYSTEM/anonymous/rest', async () => {
    const context = await emittedContext();
    expect(context?.actor).toEqual({ type: 'SYSTEM', id: 'anonymous' });
    expect(context?.origin).toBe('rest');
  });

  it('AC-8: defaults every request to NO_APPROVAL', async () => {
    expect((await emittedContext(USER))?.approval).toEqual(NO_APPROVAL);
  });

  it("AC-9: uses logging request id as correlation id", async () => {
    const observed = await runWithContext({ requestId: 'req-9' }, () => emittedContext(USER));
    expect(observed?.correlationId).toBe('req-9');
  });

  it('AC-12: propagates handler observable errors unchanged', async () => {
    const error = new Error('handler failed');
    const next: CallHandler = { handle: () => new Observable((subscriber) => subscriber.error(error)) };
    await expect(firstValueFrom(new ActionContextInterceptor().intercept(requestWith(AGENT), next))).rejects.toBe(error);
  });

  it('AC-13: leaves no context in the subscribing caller after completion', async () => {
    await emittedContext(AGENT);
    expect(currentContext()).toBeUndefined();
    expect(currentActor()).toBeUndefined();
  });

  it('AC-4: errors with an UnauditedWriteError naming the route surface', async () => {
    const outcome = await runIntercept(requestWith(USER, POST_X), handlerWritingUnrecorded());

    expect(outcome.error).toBeInstanceOf(UnauditedWriteError);
    expect((outcome.error as UnauditedWriteError).surface).toBe('POST /x');
  });

  it('AC-5: does not complete when the check fails', async () => {
    const outcome = await runIntercept(requestWith(USER, POST_X), handlerWritingUnrecorded());

    expect(outcome.completed).toBe(false);
  });

  it('AC-6: emits ok and completes when the handler recorded an entry', async () => {
    let surface: string | undefined;
    const next = handlerDoing((subscriber) => {
      surface = currentAuditScope()?.surface;
      noteAuditWrite('Ticket.update');
      noteAuditEntry();
      subscriber.next('ok');
      subscriber.complete();
    });

    const outcome = await runIntercept(requestWith(USER, POST_X), next);

    // The scope existed and its check ran: a scope that never opened would leave this undefined.
    expect(surface).toBe('POST /x');
    expect(outcome.error).toBeUndefined();
    expect(outcome.values).toEqual(['ok']);
    expect(outcome.completed).toBe(true);
  });

  it('AC-7: passes an allowlisted surface that wrote without recording', async () => {
    let surface: string | undefined;
    const next = handlerDoing((subscriber) => {
      surface = currentAuditScope()?.surface;
      noteAuditWrite('Notification.updateMany');
      subscriber.next('ok');
      subscriber.complete();
    });

    const outcome = await runIntercept(requestWith(USER, READ_ALL), next);

    // The allowlisted label is the scope's surface, so the check found it on UNAUDITED_SURFACES.
    expect(surface).toBe('POST /me/notifications/read-all');
    expect(outcome.error).toBeUndefined();
    expect(outcome.values).toEqual(['ok']);
    expect(outcome.completed).toBe(true);
  });

  it('AC-8: logs once in production mode for a multi-value stream', async () => {
    process.env['ENV_NAME'] = 'production';
    const logger = errorLogger();
    const next = handlerDoing((subscriber) => {
      noteAuditWrite('Ticket.update');
      subscriber.next(1);
      subscriber.next(2);
      subscriber.next(3);
      subscriber.complete();
    });

    const outcome = await runIntercept(requestWith(USER, POST_X), next);

    expect(outcome.values).toEqual([1, 2, 3]);
    expect(outcome.completed).toBe(true);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0]).toEqual([
      'unaudited write: POST /x wrote Ticket.update and recorded no audit entry',
    ]);
  });

  it('AC-9: errors when the handler completes without emitting after an unrecorded write', async () => {
    const next = handlerDoing((subscriber) => {
      noteAuditWrite('Ticket.update');
      subscriber.complete();
    });

    const outcome = await runIntercept(requestWith(USER, POST_X), next);

    expect(outcome.values).toEqual([]);
    expect(outcome.error).toBeInstanceOf(UnauditedWriteError);
    expect(outcome.completed).toBe(false);
  });

  it('AC-10: opens no scope for a handler with no route metadata', async () => {
    let scopeInsideHandler: unknown = 'not run';
    const next = handlerDoing((subscriber) => {
      scopeInsideHandler = currentAuditScope();
      noteAuditWrite('Ticket.update');
      subscriber.next('value');
      subscriber.complete();
    });

    const outcome = await runIntercept(requestWith(USER, NO_ROUTE), next);

    expect(scopeInsideHandler).toBeUndefined();
    expect(outcome.values).toEqual(['value']);
    expect(outcome.completed).toBe(true);
    expect(outcome.error).toBeUndefined();
  });

  it('AC-11: forwards a handler error unchanged and skips the check', async () => {
    const failure = new Error('handler failed');
    let surface: string | undefined;
    const next = handlerDoing((subscriber) => {
      surface = currentAuditScope()?.surface;
      noteAuditWrite('Ticket.update');
      subscriber.error(failure);
    });

    const outcome = await runIntercept(requestWith(USER, POST_X), next);

    // The scope opened, yet the error was forwarded rather than replaced by the check's error.
    expect(surface).toBe('POST /x');
    expect(outcome.error).toBe(failure);
    expect(outcome.completed).toBe(false);
  });
});
