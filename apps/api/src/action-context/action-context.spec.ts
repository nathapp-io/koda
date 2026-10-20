/**
 * US-001 AC-1 .. AC-5 — the action context is module-level state carried by an
 * `AsyncLocalStorage`, so a service reads the current actor without a constructor parameter.
 */
import { actorTypeFor, currentActor, runWithActor } from './action-context';

const AGENT = { type: 'AGENT', id: 'a1' } as const;

describe('runWithActor / currentActor', () => {
  it('AC-1: exposes the actor to the function it runs', () => {
    expect(runWithActor(AGENT, () => currentActor())).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('AC-1: keeps the actor across an await inside the run', async () => {
    const seen = await runWithActor(AGENT, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return currentActor();
    });

    expect(seen).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('AC-2: answers undefined outside any run', () => {
    expect(currentActor()).toBeUndefined();
  });

  it('AC-2: answers undefined again once the run has returned', () => {
    runWithActor(AGENT, () => currentActor());

    expect(currentActor()).toBeUndefined();
  });

  it('replaces the actor for the extent of a nested run and restores it afterwards', () => {
    const seen = runWithActor(AGENT, () => {
      const inner = runWithActor({ type: 'USER', id: 'u9' }, () => currentActor());
      return { inner, outer: currentActor() };
    });

    expect(seen).toEqual({ inner: { type: 'USER', id: 'u9' }, outer: { type: 'AGENT', id: 'a1' } });
  });
});

describe('actorTypeFor', () => {
  it('AC-3: names the current actor as AGENT', () => {
    expect(runWithActor(AGENT, () => actorTypeFor('a1'))).toBe('AGENT');
  });

  it('AC-4: answers USER for another actor id', () => {
    expect(runWithActor(AGENT, () => actorTypeFor('u9'))).toBe('USER');
  });

  it('AC-5: answers USER outside any run', () => {
    expect(actorTypeFor('a1')).toBe('USER');
  });

  it('names the current actor as USER', () => {
    expect(runWithActor({ type: 'USER', id: 'u1' }, () => actorTypeFor('u1'))).toBe('USER');
  });
});
