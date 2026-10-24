/**
 * Permissions P2 US-004 — the helpers a DB-backed spec uses once the API's Prisma client refuses a
 * context-less write (design §5, spec "Test helpers (US-004)").
 *
 * The guard is a Prisma client extension on the client underneath `AppModule`, so a fixture that
 * writes through `app.get(PrismaService).client` with no action context throws. These four helpers
 * make that legal in exactly the two ways a converted spec needs:
 *
 * - `fixtureDb(app)` — seed data as `SYSTEM/seed`, the id the boot-time seeders use;
 * - `withTestActor(actor, fn)` / `asTestActor(service, actor)` — take the place of the request, runner
 *   or system component production runs a direct call under;
 * - `expectGuardActive(app)` — the sentinel that proves the guard is on, so a converted spec cannot
 *   pass by writing through a client that does not refuse anything.
 *
 * **Prisma promises are lazy.** A Prisma call returns a `PrismaPromise` that runs its query when it is
 * awaited, in the async context of the *awaiter* — not where it was created. So every helper here
 * awaits the call inside its context (`runAsSystem('seed', async () => await …)`); returning the
 * promise out of the context would run the query with no context at all.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import {
  runAsSystem,
  runWithActionContext,
  type ActionActor,
  type ActionOrigin,
} from '../../src/action-context/action-context';
import { ContextlessWriteError } from '../../src/action-context/contextless-write';
import type { PrismaClient } from '../../src/generated/prisma/client';

/** The system component a fixture writes as: the id `seed` boot-time seeders use. */
const SEED_COMPONENT = 'seed';

/** Awaited when the probe resolves instead of refusing: the client under test carries no guard. */
const NO_GUARD_MESSAGE = 'the application Prisma client does not refuse context-less writes';

/**
 * Client methods whose own call runs the statement — the raw executes and the transaction entry. The
 * model delegates are wrapped separately, because the statement runs on the delegate's method.
 */
const SEEDED_CLIENT_METHODS: ReadonlySet<string> = new Set([
  '$transaction',
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
]);

/**
 * The part of a Nest container these helpers use: `get`, with the `{ strict }` option a converted
 * spec needs (`.nax` context: repositories are module-private, so a spec resolves `PrismaService` with
 * `{ strict: false }`). `INestApplicationContext` itself would exclude every caller the feature names:
 * the specs boot a `NathApplication` (a wrapper class that has no `registerRequestByContextId`) and
 * US-009 resolves the client from a `TestingModule`; both have `get` and nothing else this needs.
 */
export type PrismaAppContext = Pick<INestApplicationContext, 'get'>;

/** The entry point each principal type reaches a write through. */
const ORIGIN_BY_ACTOR_TYPE: Readonly<Record<Exclude<ActionActor['type'], 'SYSTEM'>, ActionOrigin>> = {
  USER: 'rest',
  AGENT: 'rest',
  RUNNER: 'runner',
};

/** Runs `fn` inside a context with `actor` and awaits it there (Prisma promises are lazy). */
export async function withTestActor<T>(actor: ActionActor, fn: () => T | PromiseLike<T>): Promise<T> {
  if (actor.type === 'SYSTEM') {
    // `runAsSystem` refuses an id outside SYSTEM_ACTOR_IDS before it runs fn, so a typo names itself
    // (thrown inside this async function, so the caller sees a rejection).
    return await runAsSystem(actor.id, async () => await fn());
  }

  const origin = ORIGIN_BY_ACTOR_TYPE[actor.type];
  return await runWithActionContext({ actor, origin }, async () => await fn());
}

/** A view of `target` whose function properties run through `withTestActor(actor, …)`. */
export function asTestActor<T extends object>(target: T, actor: ActionActor): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      // Symbols belong to inspection and iteration, not to the target's API.
      if (typeof property === 'symbol') return Reflect.get(object, property, receiver);

      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;

      return actorBoundMethod(object, value, actor);
    },
  });
}

/**
 * The app's Prisma client; every model and raw call is awaited inside `runAsSystem('seed', …)`.
 *
 * The array form `$transaction([…])` is deliberately unsupported — the wrapped calls return started
 * promises rather than Prisma promises. The interactive form works, and its callback runs inside the
 * `seed` context because the transaction is entered (and the callback awaited) from inside it.
 *
 * A model delegate is resolved from the client on *every* read and cached per delegate object, so the
 * view follows `PrismaService.client`: `patchWithTransactionProxy` swaps in the transaction client's
 * delegate while a transaction is active. That swap lives in the library's async-local store, which only
 * `PrismaTransactionManager.run` enters — a raw `client.$transaction(async (tx) => …)` callback still sees
 * the root client, so write through its `tx` argument when the write must be transactional.
 */
export function fixtureDb(app: PrismaAppContext): PrismaClient {
  const client = prismaClientOf(app);
  // Keyed by the delegate object read from the client, never by property name alone: `PrismaService.client`
  // is the transaction proxy, so while a transaction is active `client.user` is the *transaction* client's
  // delegate and otherwise the root one. A view captured for one delegate must not serve a call made under
  // the other, which would then run outside the transaction (or on a closed one).
  const delegates = new WeakMap<object, object>();

  return new Proxy(client, {
    get(target, property, receiver) {
      if (typeof property === 'symbol') return Reflect.get(target, property, receiver);

      const value: unknown = Reflect.get(target, property, receiver);
      if (SEEDED_CLIENT_METHODS.has(property) && typeof value === 'function') {
        return seededMethod(target, value);
      }
      // `$connect`, `$disconnect`, `$extends`, `$on` and the client's `_`-prefixed internals run no
      // model statement; only a model delegate (`user`, `fleetJob`) owns the calls that do.
      if (property.startsWith('$') || property.startsWith('_')) return value;
      if (typeof value !== 'object' || value === null) return value;

      // A model delegate; one cached view per delegate object, so two reads of `db.user` outside a
      // transaction are the same object, while the transaction's own delegate gets its own view.
      const cached = delegates.get(value);
      if (cached !== undefined) return cached;
      const delegate = seededDelegate(value);
      delegates.set(value, delegate);
      return delegate;
    },
  });
}

/**
 * Resolves when the app's Prisma client refuses a context-less write; rejects otherwise.
 *
 * The probe is a raw `SELECT 1`: it writes nothing, yet `$executeRaw` is a guarded operation, so the
 * client under test rejects it before it reaches the database when it carries the guard.
 */
export async function expectGuardActive(app: PrismaAppContext): Promise<void> {
  const client = prismaClientOf(app);

  try {
    await client.$executeRaw`SELECT 1`;
  } catch (error) {
    if (error instanceof ContextlessWriteError) return;
    // The probe failed for another reason (a closed pool, a missing database): say so, keep the cause.
    throw new Error(NO_GUARD_MESSAGE, { cause: error });
  }

  throw new Error(NO_GUARD_MESSAGE);
}

/** The client every repository, transaction and request of `app` writes through. */
function prismaClientOf(app: PrismaAppContext): PrismaClient {
  return app.get<PrismaService<PrismaClient>>(PrismaService, { strict: false }).client;
}

/** Awaits `call` inside `SYSTEM/seed`, so the statement runs under that context. */
function asSeed<T>(call: () => T | PromiseLike<T>): Promise<T> {
  return runAsSystem(SEED_COMPONENT, async () => await call());
}

/** Wraps a function-valued property so its call happens inside `withTestActor(actor, …)`. */
function actorBoundMethod(
  owner: object,
  value: unknown,
  actor: ActionActor,
): (...args: unknown[]) => Promise<unknown> {
  const method = value as (...args: unknown[]) => unknown;
  return (...args: unknown[]) => withTestActor(actor, async () => await method.apply(owner, args));
}

/** Wraps one of the client's own statement-running methods so its call is awaited as `seed`. */
function seededMethod(owner: object, value: unknown): (...args: unknown[]) => Promise<unknown> {
  const method = value as (...args: unknown[]) => unknown;
  return (...args: unknown[]) => asSeed(async () => await method.apply(owner, args));
}

/** A view of a model delegate whose methods are awaited as `seed` (writes and reads alike). */
function seededDelegate(delegate: object): object {
  const methods = new Map<string, unknown>();

  return new Proxy(delegate, {
    get(target, property, receiver) {
      if (typeof property === 'symbol') return Reflect.get(target, property, receiver);

      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;

      const cached = methods.get(property);
      if (cached !== undefined) return cached;
      const wrapped = seededMethod(target, value);
      methods.set(property, wrapped);
      return wrapped;
    },
  });
}
