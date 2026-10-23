import { runWithContext } from '@nathapp/nestjs-logging';
import { firstValueFrom, Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { currentContext, currentActor, NO_APPROVAL } from './action-context';
import { ActionContextInterceptor } from './action-context.interceptor';

const requestWith = (user?: KodaPrincipal): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

const handlerRecordingContext = (): CallHandler => ({
  handle: () => new Observable((subscriber) => {
    subscriber.next(currentContext());
    subscriber.complete();
  }),
});

const emittedContext = async (user?: KodaPrincipal) =>
  firstValueFrom(new ActionContextInterceptor().intercept(requestWith(user), handlerRecordingContext()));

const AGENT = { actorType: 'agent', id: 'a1', slug: 'a1', status: 'ACTIVE', agentRoles: [], capabilities: [] } as unknown as KodaPrincipal;
const USER = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u1@koda.test' } as KodaPrincipal;
const RUNNER = { actorType: 'runner', id: 'r1', runnerName: 'r1', labels: [], enabled: true, capacity: 1 } as unknown as KodaPrincipal;

describe('ActionContextInterceptor', () => {
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
});
