/**
 * Permissions P1d US-001 (kept cases) and Permissions P2 US-001 — the action context is module-level
 * state carried by an `AsyncLocalStorage`, so a service reads the current actor (and, from P2, the
 * whole actor/on-behalf-of/origin/approval/correlation model) without a constructor parameter.
 *
 * `reflect-metadata` is loaded first: `@SystemWriter` writes its key through `Reflect.defineMetadata`
 * and `runAsSystemWriter` reads it back.
 */
import 'reflect-metadata';
import { runWithContext } from '@nathapp/nestjs-logging';
import { PERMISSION_CATALOG } from '../permissions/catalog';
import { SystemWriter } from '../permissions/system-writer.decorator';
import {
  actorTypeFor,
  currentActor,
  currentContext,
  NO_APPROVAL,
  runAsSystem,
  runAsSystemWriter,
  runWithActionContext,
  runWithActor,
  SYSTEM_ACTOR_IDS,
  type ActionContext,
} from './action-context';

import {
  currentAuditScope,
  noteAuditEntry,
  noteAuditWrite,
  runInAuditScope,
  UnauditedWriteError,
} from './audit-coverage';

const AGENT = { type: 'AGENT', id: 'a1' } as const;
const USER = { type: 'USER', id: 'u1' } as const;

/** A UUID v4, the shape of a generated correlation id. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The current context, or a failure: every case below runs inside a context. */
const contextNow = (): ActionContext => {
  const context = currentContext();
  if (context === undefined) throw new Error('no action context is current');
  return context;
};

@SystemWriter('system.budget.window-reset')
class BudgetWindowResetWriter {}

class Plain {}

@SystemWriter('system.schedule.dispatch')
class ScheduleTicker {}

describe('system audit scopes', () => {
  beforeEach(() => { vi.stubEnv('ENV_NAME', 'test'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('coverage AC-1: opens system:budget and restores the enclosing scope', () => {
    expect(runAsSystem('budget', () => currentAuditScope()?.surface)).toBe('system:budget');
    expect(currentAuditScope()).toBeUndefined();
  });

  it('coverage AC-2: rejects successful async work that wrote without recording', async () => {
    const result = runAsSystem('budget', async () => { noteAuditWrite('BudgetPause.create'); });
    await expect(result).rejects.toBeInstanceOf(UnauditedWriteError);
    await expect(result).rejects.toMatchObject({ surface: 'system:budget', writes: ['BudgetPause.create'] });
  });

  it('coverage AC-3: labels the writer scope and keeps its SYSTEM actor', () => {
    expect(runAsSystemWriter(new ScheduleTicker(), () => ({
      surface: currentAuditScope()?.surface, actor: currentActor(),
    }))).toEqual({ surface: 'writer:ScheduleTicker', actor: { type: 'SYSTEM', id: 'schedule' } });
  });

  it('coverage AC-4: returns a plain value synchronously', () => {
    expect(runAsSystem('budget', () => 7)).toBe(7);
  });

  it('counts nested record-only scopes in the enclosing system scope', () => {
    runAsSystem('budget', () => {
      const outer = currentAuditScope();
      noteAuditWrite('BudgetPause.create');
      runAsSystem('schedule', () => {
        expect(currentAuditScope()?.parent).toBe(outer);
        noteAuditEntry();
        expect(currentAuditScope()?.writes).toEqual([]);
      });
      expect(currentAuditScope()).toBe(outer);
      expect(outer?.entries).toBe(1);
    });
  });

  it('does not let detached entries satisfy the enclosing scope', () => {
    expect(() => runAsSystem('budget', () => {
      noteAuditWrite('BudgetPause.create');
      runInAuditScope('task:detached', () => noteAuditEntry(), { detached: true });
    })).toThrow(UnauditedWriteError);
  });

  it('preserves original synchronous throws and async rejections without checking coverage', async () => {
    const failure = new Error('original failure');
    expect(() => runAsSystem('budget', () => {
      noteAuditWrite('BudgetPause.create');
      throw failure;
    })).toThrow(failure);
    await expect(runAsSystem('budget', async () => {
      noteAuditWrite('BudgetPause.create');
      throw failure;
    })).rejects.toBe(failure);
  });

  it('awaits lazy thenables inside both the actor and the audit scope', async () => {
    const lazy: PromiseLike<number> = {
      then(resolve, reject) {
        expect(currentActor()).toEqual({ type: 'SYSTEM', id: 'budget' });
        expect(currentAuditScope()?.surface).toBe('system:budget');
        noteAuditWrite('BudgetPause.create');
        noteAuditEntry();
        return Promise.resolve(9).then(resolve, reject);
      },
    };
    await expect(runAsSystem('budget', () => lazy)).resolves.toBe(9);
  });

  it('does not open scopes through the raw action-context or compatibility helpers', () => {
    expect(runWithActionContext({ actor: USER, origin: 'rest' }, currentAuditScope)).toBeUndefined();
    expect(runWithActor(USER, currentAuditScope)).toBeUndefined();
  });
});

describe('runWithActor / currentActor', () => {
  it('P1d AC-1: exposes the actor to the function it runs', () => {
    expect(runWithActor(AGENT, () => currentActor())).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('P1d AC-1: keeps the actor across an await inside the run', async () => {
    const seen = await runWithActor(AGENT, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return currentActor();
    });

    expect(seen).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('P1d AC-2: answers undefined outside any run', () => {
    expect(currentActor()).toBeUndefined();
  });

  it('P1d AC-2: answers undefined again once the run has returned', () => {
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
  it('P1d AC-3: names the current actor as AGENT', () => {
    expect(runWithActor(AGENT, () => actorTypeFor('a1'))).toBe('AGENT');
  });

  it('P1d AC-4: answers USER for another actor id', () => {
    expect(runWithActor(AGENT, () => actorTypeFor('u9'))).toBe('USER');
  });

  it('P1d AC-5: answers USER outside any run', () => {
    expect(actorTypeFor('a1')).toBe('USER');
  });

  it('names the current actor as USER', () => {
    expect(runWithActor({ type: 'USER', id: 'u1' }, () => actorTypeFor('u1'))).toBe('USER');
  });
});

describe('runWithActionContext / currentContext', () => {
  it('AC-1: exposes the actor to the function it runs', () => {
    const context = runWithActionContext({ actor: { type: 'AGENT', id: 'a1' }, origin: 'rest' }, () => contextNow());

    expect(context.actor).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('AC-1: answers undefined outside any run', () => {
    runWithActionContext({ actor: AGENT, origin: 'rest' }, () => contextNow());

    expect(currentContext()).toBeUndefined();
  });

  it('AC-2: fills an absent approval with NO_APPROVAL', () => {
    const context = runWithActionContext({ actor: AGENT, origin: 'rest' }, () => contextNow());

    expect(context.approval).toEqual(NO_APPROVAL);
    expect(context.approval).toEqual({ requiredMode: 'none', satisfiedBy: 'none' });
  });

  it('AC-2: keeps an approval the caller supplies', () => {
    const approval = { requiredMode: 'human', satisfiedBy: 'self', approverType: 'USER', approverId: 'u1' } as const;

    const context = runWithActionContext({ actor: USER, origin: 'rest', approval }, () => contextNow());

    expect(context.approval).toBe(approval);
  });

  it('AC-3: takes the correlation id from the logging request context', () => {
    let seen: string | undefined;

    runWithContext({ requestId: 'req-1' }, () => {
      seen = runWithActionContext({ actor: AGENT, origin: 'rest' }, () => contextNow().correlationId);
    });

    expect(seen).toBe('req-1');
  });

  it('AC-4: generates a new correlation id with no enclosing context and no request id', () => {
    const first = runWithActionContext({ actor: AGENT, origin: 'rest' }, () => contextNow().correlationId);
    const second = runWithActionContext({ actor: AGENT, origin: 'rest' }, () => contextNow().correlationId);

    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  it('AC-4: keeps a correlation id the caller supplies', () => {
    const context = runWithActionContext({ actor: AGENT, origin: 'rest', correlationId: 'given' }, () => contextNow());

    expect(context.correlationId).toBe('given');
  });

  it('AC-4: ignores an empty logging request id and generates one', () => {
    let seen: string | undefined;

    runWithContext({ requestId: '' }, () => {
      seen = runWithActionContext({ actor: AGENT, origin: 'rest' }, () => contextNow().correlationId);
    });

    expect(seen).toMatch(UUID_V4);
  });

  it('AC-12: propagates a rejection unchanged and ends the context with fn', async () => {
    const failure = new Error('tool exploded');

    await expect(
      runWithActionContext({ actor: AGENT, origin: 'rest' }, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(currentContext()).toBeUndefined();
  });

  it('AC-12: ends the context with fn even when fn throws synchronously', () => {
    expect(() =>
      runWithActionContext({ actor: AGENT, origin: 'rest' }, () => {
        throw new Error('sync failure');
      }),
    ).toThrow('sync failure');
    expect(currentContext()).toBeUndefined();
  });
});

describe('runAsSystem', () => {
  it('AC-5: inherits the enclosing correlation id', () => {
    const seen = runWithActionContext({ actor: AGENT, origin: 'rest', correlationId: 'c-1' }, () =>
      runAsSystem('outbox', () => contextNow().correlationId),
    );

    expect(seen).toBe('c-1');
  });

  it('AC-5: takes a correlation id from opts over the enclosing one', () => {
    const seen = runWithActionContext({ actor: AGENT, origin: 'rest', correlationId: 'c-1' }, () =>
      runAsSystem('outbox', () => contextNow().correlationId, { correlationId: 'c-2' }),
    );

    expect(seen).toBe('c-2');
  });

  it('AC-6: runs as the SYSTEM actor of that component, origin system', () => {
    const context = runAsSystem('schedule', () => contextNow());

    expect(context.actor).toEqual({ type: 'SYSTEM', id: 'schedule' });
    expect(context.origin).toBe('system');
  });

  it('AC-7: carries the on-behalf-of actor', () => {
    const context = runAsSystem('schedule', () => contextNow(), { onBehalfOf: { type: 'AGENT', id: 'a1' } });

    expect(context.onBehalfOf).toEqual({ type: 'AGENT', id: 'a1' });
    expect(context.actor).toEqual({ type: 'SYSTEM', id: 'schedule' });
  });

  it('AC-8: refuses an unknown component id before running fn', () => {
    const fn = vi.fn(() => 'ran');

    expect(() => runAsSystem('no-such-component', fn)).toThrow(new Error('unknown system actor id: no-such-component'));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('SYSTEM_ACTOR_IDS', () => {
  it('AC-9: is the second segment of every system key plus the ids that own no key family', () => {
    const families = PERMISSION_CATALOG.filter((entry) => entry.access === 'system').map(
      (entry) => entry.key.split('.')[1],
    );
    const expected = new Set([...families, 'assistant', 'outbox', 'anonymous', 'seed', 'unknown']);

    expect([...SYSTEM_ACTOR_IDS].sort()).toEqual([...expected].sort());
  });

  it('AC-9: names one id per system key family', () => {
    expect(SYSTEM_ACTOR_IDS.has('schedule')).toBe(true);
    expect(SYSTEM_ACTOR_IDS.has('budget')).toBe(true);
    expect(SYSTEM_ACTOR_IDS.has('outbox')).toBe(true);
    expect(SYSTEM_ACTOR_IDS.has('scheduler')).toBe(false);
  });
});

describe('runAsSystemWriter', () => {
  it('AC-10: runs as the SYSTEM actor named by the class key family', () => {
    const context = runAsSystemWriter(new BudgetWindowResetWriter(), () => contextNow());

    expect(context.actor).toEqual({ type: 'SYSTEM', id: 'budget' });
    expect(context.origin).toBe('system');
  });

  it('AC-11: refuses an instance whose class carries no @SystemWriter key, before running fn', () => {
    const fn = vi.fn(() => 'ran');

    expect(() => runAsSystemWriter(new Plain(), fn)).toThrow(
      new Error('runAsSystemWriter needs a @SystemWriter class, got Plain'),
    );
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('actorTypeFor inside a system context', () => {
  it('AC-13: answers the on-behalf-of actor type', () => {
    const seen = runAsSystem('assistant', () => actorTypeFor('a1'), { onBehalfOf: { type: 'AGENT', id: 'a1' } });

    expect(seen).toBe('AGENT');
  });

  it('AC-13: answers USER for a user on-behalf-of actor', () => {
    const seen = runAsSystem('assistant', () => actorTypeFor('u1'), { onBehalfOf: { type: 'USER', id: 'u1' } });

    expect(seen).toBe('USER');
  });

  it('AC-13: answers USER for a SYSTEM actor id, which is not a principal', () => {
    expect(runAsSystem('outbox', () => actorTypeFor('outbox'))).toBe('USER');
  });

  it('AC-14: runWithActor marks the origin rest', () => {
    expect(runWithActor({ type: 'USER', id: 'u1' }, () => contextNow().origin)).toBe('rest');
  });

  it('AC-14: runWithActor fills the rest of the context, and a nested run replaces it', () => {
    const context = runWithActor({ type: 'USER', id: 'u1' }, () => contextNow());

    expect(context.actor).toEqual({ type: 'USER', id: 'u1' });
    expect(context.approval).toEqual(NO_APPROVAL);
    expect(context.correlationId).toMatch(UUID_V4);

    const nested = runWithActor(AGENT, () =>
      runAsSystem('outbox', () => {
        const inner = contextNow();
        const restored = runWithActor(USER, () => currentActor());
        return { inner, restored };
      }),
    );

    expect(nested.inner.actor).toEqual({ type: 'SYSTEM', id: 'outbox' });
    expect(nested.restored).toEqual({ type: 'USER', id: 'u1' });
  });
});
