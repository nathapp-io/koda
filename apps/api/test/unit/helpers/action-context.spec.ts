/**
 * Permissions P2 US-004 — the actor helpers a converted DB spec writes fixtures through.
 *
 * These are unit tests: no database, no Nest application. The lazy thenable is the point of the
 * file — a Prisma call returns a `PrismaPromise` that runs its query when it is awaited, in the
 * async context of the awaiter, so a helper that returned the promise out of its context would
 * pass a naive test and fail on a real guarded client.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentContext, type ActionContext } from '../../../src/action-context/action-context';
import { currentAuditScope, noteAuditWrite } from '../../../src/action-context/audit-coverage';
import { asTestActor, fixtureDb, withTestActor, type PrismaAppContext } from '../../helpers/action-context';

/** A thenable that records `currentContext()` only when it is awaited — a lazy Prisma promise. */
class LazyThenable<T> implements PromiseLike<T> {
  readonly contexts: (ActionContext | undefined)[] = [];

  constructor(private readonly value: T) {}

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.contexts.push(currentContext());
    return Promise.resolve(this.value).then(onfulfilled, onrejected);
  }
}

/** The context `fn` observed, asserted after the run: the context is gone once `withTestActor` returns. */
function actorSeenBy(fn: () => void): { actor?: ActionContext['actor']; origin?: ActionContext['origin'] } {
  const seen: { actor?: ActionContext['actor']; origin?: ActionContext['origin'] } = {};
  fn();
  const context = currentContext();
  if (context !== undefined) {
    seen.actor = context.actor;
    seen.origin = context.origin;
  }
  return seen;
}

describe('withTestActor', () => {
  it('coverage AC-5: awaits a SYSTEM fixture without an audit scope', async () => {
    const lazy: PromiseLike<number> = {
      then(resolve, reject) {
        expect(currentContext()).toMatchObject({ actor: { type: 'SYSTEM', id: 'seed' }, origin: 'system' });
        expect(currentAuditScope()).toBeUndefined();
        noteAuditWrite('User.create');
        return Promise.resolve(42).then(resolve, reject);
      },
    };
    await expect(withTestActor({ type: 'SYSTEM', id: 'seed' }, () => lazy)).resolves.toBe(42);
  });
  it('AC-1: runs fn with the USER actor in the context', async () => {
    let seen: ReturnType<typeof actorSeenBy> | undefined;

    await withTestActor({ type: 'USER', id: 'u1' }, () => {
      seen = actorSeenBy(() => undefined);
    });

    expect(seen?.actor).toEqual({ type: 'USER', id: 'u1' });
    expect(currentContext()).toBeUndefined();
  });

  it("AC-2: runs an AGENT actor's fn with origin 'rest'", async () => {
    let seen: ReturnType<typeof actorSeenBy> | undefined;

    await withTestActor({ type: 'AGENT', id: 'a1' }, () => {
      seen = actorSeenBy(() => undefined);
    });

    expect(seen?.origin).toBe('rest');
    expect(seen?.actor).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it("AC-3: runs a RUNNER actor's fn with origin 'runner'", async () => {
    let seen: ReturnType<typeof actorSeenBy> | undefined;

    await withTestActor({ type: 'RUNNER', id: 'r1' }, () => {
      seen = actorSeenBy(() => undefined);
    });

    expect(seen?.origin).toBe('runner');
    expect(seen?.actor).toEqual({ type: 'RUNNER', id: 'r1' });
  });

  it("AC-4: runs a SYSTEM actor's fn with origin 'system'", async () => {
    let seen: ReturnType<typeof actorSeenBy> | undefined;

    await withTestActor({ type: 'SYSTEM', id: 'thread' }, () => {
      seen = actorSeenBy(() => undefined);
    });

    expect(seen?.origin).toBe('system');
    expect(seen?.actor).toEqual({ type: 'SYSTEM', id: 'thread' });
  });

  it('AC-5: rejects a SYSTEM id outside SYSTEM_ACTOR_IDS with the runAsSystem error', async () => {
    const call = withTestActor({ type: 'SYSTEM', id: 'nope' }, () => undefined);

    await expect(call).rejects.toBeInstanceOf(Error);
    await expect(call).rejects.toMatchObject({ message: 'unknown system actor id: nope' });
  });

  it('AC-6: never invokes fn for a SYSTEM id outside SYSTEM_ACTOR_IDS', async () => {
    const fn = vi.fn(() => undefined);

    await expect(withTestActor({ type: 'SYSTEM', id: 'nope' }, fn)).rejects.toBeInstanceOf(Error);

    expect(fn).not.toHaveBeenCalled();
  });

  it('AC-7: awaits a lazy thenable inside the context, so its query runs as the actor', async () => {
    const lazy = new LazyThenable(42);

    const result = await withTestActor({ type: 'USER', id: 'u1' }, () => lazy);

    expect(result).toBe(42);
    expect(lazy.contexts).toHaveLength(1);
    expect(lazy.contexts[0]?.actor).toEqual({ type: 'USER', id: 'u1' });
    expect(currentContext()).toBeUndefined();
  });
});

describe('fixtureDb', () => {
  it('coverage AC-7: keeps lazy fixture writes scope-free and attributed to seed', async () => {
    const row = { id: 'fixture-user', email: 'fixture@koda.test' };
    const lazy: PromiseLike<typeof row> = {
      then(resolve, reject) {
        expect(currentContext()).toMatchObject({ actor: { type: 'SYSTEM', id: 'seed' }, origin: 'system' });
        expect(currentAuditScope()).toBeUndefined();
        noteAuditWrite('User.create');
        return Promise.resolve(row).then(resolve, reject);
      },
    };
    const client = { user: { create: () => lazy } };
    const app: PrismaAppContext = { get: () => ({ client }) as never };
    await expect(fixtureDb(app).user.create({ data: { email: row.email, passwordHash: 'x' } })).resolves.toBe(row);
  });
  /**
   * Stands in for what `@nathapp/nestjs-prisma` installs on `PrismaService.client`
   * (`patchWithTransactionProxy`): a client whose properties resolve from the async-local transaction
   * client while a transaction is active, and from the root client otherwise. The delegates are
   * distinct objects, so a view cached for the root delegate must not serve a call made inside the
   * transaction — that write would run outside it.
   */
  function appWithTransactionProxy() {
    const als = new AsyncLocalStorage<object>();
    const served: string[] = [];

    const delegate = (client: string) => ({
      create: async (args: unknown) => {
        served.push(client);
        return args;
      },
    });

    const root = { user: delegate('root') };
    const transactional = { user: delegate('transaction') };
    const client = new Proxy(root, {
      get(target, property, receiver) {
        const active = als.getStore();
        return Reflect.get(active ?? target, property, receiver);
      },
    });

    const app: PrismaAppContext = { get: () => ({ client }) as never };

    return { app, served, runInTransaction: (fn: () => Promise<unknown>) => als.run(transactional, fn) };
  }

  it('resolves a model delegate from the client at call time, not from the first read', async () => {
    const { app, served, runInTransaction } = appWithTransactionProxy();
    const db = fixtureDb(app);

    // Prime the view: outside a transaction `client.user` is the root client's delegate.
    await db.user.create({ data: { email: 'outside@koda.test', passwordHash: 'not-a-real-hash' } });
    await runInTransaction(() => db.user.create({ data: { email: 'inside@koda.test', passwordHash: 'not-a-real-hash' } }));

    expect(served).toEqual(['root', 'transaction']);
  });

  it('serves two reads of the same delegate the same view', () => {
    const { app } = appWithTransactionProxy();
    const db = fixtureDb(app);

    expect(db.user).toBe(db.user);
  });
});

describe('asTestActor', () => {
  it('AC-8: a proxied method call awaits the lazy thenable as the actor', async () => {
    const lazy = new LazyThenable(7);
    const target = { label: 'x', read: (): PromiseLike<number> => lazy };

    const view = asTestActor(target, { type: 'AGENT', id: 'a1' });

    expect(view.label).toBe('x');
    await expect(view.read()).resolves.toBe(7);
    expect(lazy.contexts).toHaveLength(1);
    expect(lazy.contexts[0]?.actor).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('passes a non-function property through unchanged', () => {
    const target = { label: 'x' };

    const view = asTestActor(target, { type: 'USER', id: 'u1' });

    expect(view.label).toBe('x');
  });

  it('calls the original method with the target as this', async () => {
    const target = {
      label: 'x',
      self: function (this: { label: string }): PromiseLike<string> {
        return Promise.resolve(this.label);
      },
    };

    const view = asTestActor(target, { type: 'USER', id: 'u1' });

    await expect(view.self()).resolves.toBe('x');
  });
});
