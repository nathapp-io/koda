/**
 * US-001 AC-6 .. AC-8 — the global interceptor puts the request's principal into the action context.
 *
 * The context has to be active for the *subscription* of the handler's Observable, not just for the
 * `next.handle()` call: the handler body runs when RxJS subscribes, and wrapping only the call would
 * leave it outside (the spec's handler reads `currentActor()` at subscribe time for that reason).
 */
import { firstValueFrom, Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { currentActor, type ActionActor } from './action-context';
import { ActionContextInterceptor } from './action-context.interceptor';

const requestWith = (user?: KodaPrincipal): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

/** A handler whose body — the `subscribe` callback — reads the context, as a real handler at runtime. */
const handlerRecordingActor = (): CallHandler => ({
  handle: () =>
    new Observable<ActionActor | undefined>((subscriber) => {
      subscriber.next(currentActor());
      subscriber.complete();
    }),
});

const emittedActor = async (user?: KodaPrincipal): Promise<ActionActor | undefined> =>
  firstValueFrom(new ActionContextInterceptor().intercept(requestWith(user), handlerRecordingActor()));

const AGENT = { actorType: 'agent', id: 'a1', slug: 'a1', status: 'ACTIVE', agentRoles: [], capabilities: [] } as unknown as KodaPrincipal;
const USER = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u1@koda.test' } as KodaPrincipal;
const RUNNER = { actorType: 'runner', id: 'r1', runnerName: 'r1', labels: [], enabled: true, capacity: 1 } as unknown as KodaPrincipal;

describe('ActionContextInterceptor', () => {
  it('AC-6: runs an agent request in the context of that agent', async () => {
    await expect(emittedActor(AGENT)).resolves.toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('AC-6: leaves no actor behind once the handler has finished', async () => {
    await emittedActor(AGENT);

    expect(currentActor()).toBeUndefined();
  });

  it('runs a user request in the context of that user', async () => {
    await expect(emittedActor(USER)).resolves.toEqual({ type: 'USER', id: 'u1' });
  });

  it('AC-7: gives a runner request no actor', async () => {
    await expect(emittedActor(RUNNER)).resolves.toBeUndefined();
  });

  it('AC-8: gives a request with no user no actor', async () => {
    await expect(emittedActor(undefined)).resolves.toBeUndefined();
  });
});
