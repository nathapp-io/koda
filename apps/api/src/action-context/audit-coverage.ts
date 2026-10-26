import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { resolveWriteGuardMode, type WriteGuardMode } from './contextless-write';
import { UNAUDITED_SURFACES } from './audit-coverage.allowlist';
import { BOOKKEEPING_REASONS, type BookkeepingReason } from './audit-coverage.reasons';

/**
 * Permissions P2l US-001 — the entry-point audit scope, the unit of audit coverage.
 *
 * A scope is one entry point's tally: every write it made that changed a row, and the entries it
 * recorded. When its work succeeds, `assertAuditCoverage` holds it to the rule "wrote nothing it
 * counts, or recorded at least one entry" — the check the context guard (`contextless-write.ts`)
 * leaves open, since it only refuses a write with no actor at all.
 *
 * `ActionContextInterceptor`, `runAsSystem` and `runAsSystemWriter` open scopes; raw context and
 * fixture helpers do not. The Prisma write guard counts successful row-changing writes into them.
 *
 * The scope lives in its own `AsyncLocalStorage`, separate from the action context's, so
 * `runWithActionContext` copies nothing. Every use of the `action-context.ts` ↔
 * `contextless-write.ts` cycle here is inside a function body, so module evaluation order does not
 * matter.
 */

export class UnauditedWriteError extends Error {
  readonly name = 'UnauditedWriteError';

  constructor(readonly surface: string, readonly writes: readonly string[]) {
    super(`unaudited write: ${surface} wrote ${writes.join(', ')} and recorded no audit entry`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A read-only view of one entry point's tally; only audit-coverage.ts changes it, through noteAuditWrite / noteAuditEntry. */
export interface AuditScope {
  readonly surface: string;
  readonly parent: AuditScope | undefined;
  /** Every counted write label, in order. */
  readonly writes: readonly string[];
  readonly entries: number;
}

/** The mutable shape behind `AuditScope`; never handed out as anything writable. */
interface ScopeState extends AuditScope {
  readonly parent: ScopeState | undefined;
  readonly writes: string[];
  entries: number;
  /** Set once the scope's work has settled; late notes and tally flushes targeting it are ignored. */
  closed: boolean;
  /**
   * Opened with `{ detached: true }`, or nested inside a scope that was: no entry point owns this
   * scope's outcome, so a transaction outside it never buffers its work.
   */
  readonly detached: boolean;
}

const logger = new Logger(UnauditedWriteError.name);
const scopeStorage = new AsyncLocalStorage<ScopeState>();
const bookkeepingStorage = new AsyncLocalStorage<BookkeepingReason>();

interface TransactionTally {
  /** The scope that owns this transaction's outcome, captured when the tally opened. */
  readonly scope: ScopeState | undefined;
  /** The tally enclosing this one lexically, if any; its work travels into it on fulfilment. */
  readonly parent: TransactionTally | undefined;
  readonly writes: string[];
  entries: number;
}
const tallyStorage = new AsyncLocalStorage<TransactionTally>();

/** The scope of the current entry point, or undefined outside any scope. */
export function currentAuditScope(): AuditScope | undefined {
  return scopeStorage.getStore();
}

/**
 * Runs fn with a new child scope of the current one as current; does not check it. A detached scope
 * has no parent: its entries count only in itself, so nothing it records can satisfy the entry point
 * that started it. The caller owns the scope's lifetime and closes it with `closeAuditScope` when its
 * work settles; `runInAuditScope` does that for the usual case.
 */
export function openAuditScope<T>(
  surface: string,
  fn: (scope: AuditScope) => T,
  opts?: { detached?: boolean },
): T {
  const detachedRoot = opts?.detached === true;
  const parent = detachedRoot ? undefined : scopeStorage.getStore();
  const scope: ScopeState = {
    surface,
    parent,
    writes: [],
    entries: 0,
    closed: false,
    // A scope nested in a detached one belongs to the same detached boundary: no entry point owns it.
    detached: detachedRoot || parent?.detached === true,
  };

  return scopeStorage.run(scope, () => fn(scope));
}

/**
 * Marks the scope closed: its work has settled, so nothing counted afterwards belongs to it. A
 * callback that inherits the scope's async context (a timer or an unawaited promise started inside
 * it) and a transaction that flushes after the entry point returned are ignored instead of changing
 * a scope that already passed or failed its check. Closing is idempotent.
 */
export function closeAuditScope(scope: AuditScope): void {
  (scope as ScopeState).closed = true;
}

/**
 * openAuditScope, then assertAuditCoverage after fn's promise fulfils (immediately for a non-thenable).
 * The scope closes on every outcome — fulfilment, rejection and a synchronous throw — so the check is
 * the last thing that reads it.
 */
export function runInAuditScope<T>(surface: string, fn: () => T, opts?: { detached?: boolean }): T {
  return openAuditScope<T>(surface, (scope) => {
    let result: T;
    try {
      result = fn();
    } catch (error) {
      closeAuditScope(scope);
      throw error;
    }

    // Prisma promises are lazy: the query runs when the promise is awaited, so the check waits for
    // a thenable result inside this scope's storage. A plain value is checked at once and returned
    // as it is.
    if (!isThenable(result)) {
      try {
        assertAuditCoverage(scope);
      } finally {
        closeAuditScope(scope);
      }
      return result;
    }

    return (async () => {
      try {
        const value = await result;
        assertAuditCoverage(scope);
        return value;
      } finally {
        closeAuditScope(scope);
      }
    })() as T;
  }, opts);
}

/**
 * Holds writes and entries until fn fulfils; rejection drops both and propagates unchanged.
 * Capture the destination now: scopes opened and checked inside fn must not receive buffered work.
 * This tracks the callback outcome, not the eventual database commit outcome.
 *
 * The tally only holds work its own scope lineage made (`holdsScope`). A detached scope opened inside
 * the transaction is outside that lineage — its entry counts in itself, never in the entry point that
 * opened the transaction, so nothing detached can satisfy it (§ "Detached work opens its own scope").
 * Work that arrives after the scope that opened the transaction settled is dropped instead of being
 * handed to an enclosing transaction, whose entry point was already checked.
 */
export function withTransactionTally<T>(fn: () => Promise<T>): Promise<T> {
  const tally: TransactionTally = {
    scope: scopeStorage.getStore(),
    parent: tallyStorage.getStore(),
    writes: [],
    entries: 0,
  };

  return tallyStorage.run(tally, async () => {
    const result = await fn();
    flushTally(tally);
    return result;
  });
}

/** Adds a fulfilled tally's work to the tally or the scope that owns its outcome. */
function flushTally(tally: TransactionTally): void {
  // The scope that opened this transaction has already settled and been checked; its work is
  // reported, so nothing may travel into a tally that is still open or into the closed scope.
  if (tally.scope !== undefined && tally.scope.closed) return;

  // An enclosing callback still owns the outcome of a nested tally's successful work — as long as
  // that tally belongs to the same scope lineage. A tally a detached scope opened owns its own
  // work, which must not travel into the tally that merely encloses it lexically.
  if (tally.parent !== undefined && holdsScope(tally.parent.scope, tally.scope)) {
    tally.parent.writes.push(...tally.writes);
    tally.parent.entries += tally.entries;
    return;
  }

  const scope = tally.scope;
  if (scope === undefined) return;

  scope.writes.push(...tally.writes);
  for (let destination: ScopeState | undefined = scope; destination !== undefined; destination = destination.parent) {
    if (!destination.closed) destination.entries += tally.entries;
  }
}

/**
 * Whether a transaction tally opened in `tallyScope` holds work noted in `scope`, i.e. whether that
 * transaction owns the work's outcome: it adds the work to its captured scope on fulfilment and drops
 * it on rejection.
 *
 * A tally opened inside a scope holds the work of that scope and of the scopes nested in it, never
 * the work of a detached boundary. A tally opened outside any scope holds the ordinary work made
 * inside it — its own writes, and the scopes opened in it, which defer attribution until the callback
 * settles (US-004 AC-8) — but not detached work: a detached scope is checked on its own, so
 * swallowing its write here would let it pass unaudited (AC-12).
 */
function holdsScope(tallyScope: ScopeState | undefined, scope: ScopeState | undefined): boolean {
  if (scope === undefined) return tallyScope === undefined;
  if (tallyScope === undefined) return !scope.detached;

  return isWithin(scope, tallyScope);
}

/** Whether `scope` is `target` or one of its descendants. */
function isWithin(scope: ScopeState, target: ScopeState): boolean {
  for (let current: ScopeState | undefined = scope; current !== undefined; current = current.parent) {
    if (current === target) return true;
  }

  return false;
}

/** Runs and awaits fn with writes uncounted; rejects an unknown reason before invoking fn. */
export function bookkeeping<T>(reason: BookkeepingReason, fn: () => T | PromiseLike<T>): Promise<T> {
  if (!Object.hasOwn(BOOKKEEPING_REASONS, reason)) {
    return Promise.reject(new Error(`unknown bookkeeping reason: ${String(reason)}`));
  }

  return bookkeepingStorage.run(reason, async () => await fn());
}

/** The currently active bookkeeping reason, or undefined outside bookkeeping(). */
export function currentBookkeepingReason(): BookkeepingReason | undefined {
  return bookkeepingStorage.getStore();
}

/** Buffers in the innermost tally, otherwise counts in the innermost scope; skips bookkeeping. */
export function noteAuditWrite(label: string): void {
  if (bookkeepingStorage.getStore() !== undefined) return;

  const scope = scopeStorage.getStore();
  // A callback that outlived its scope writes into a scope that already passed or failed its check.
  if (scope !== undefined && scope.closed) return;

  const tally = tallyStorage.getStore();
  if (tally !== undefined && holdsScope(tally.scope, scope)) {
    tally.writes.push(label);
    return;
  }

  // Work outside the open transaction's scope — a detached scope — is not the entry point's to
  // buffer: it counts in the scope that made it, which is checked on its own.
  if (scope === undefined) return;

  scope.writes.push(label);
}

/**
 * Buffers in the innermost tally, otherwise counts in the innermost scope and every enclosing one.
 * An entry recorded in a nested, record-only scope therefore satisfies the tick or request that
 * opened it; an entry a detached scope records satisfies that scope alone. With neither a scope nor
 * a tally, this is a no-op.
 */
export function noteAuditEntry(): void {
  const scope = scopeStorage.getStore();
  // A late entry from a finished scope must not satisfy it or any scope that encloses it.
  if (scope !== undefined && scope.closed) return;

  const tally = tallyStorage.getStore();
  if (tally !== undefined && holdsScope(tally.scope, scope)) {
    tally.entries += 1;
    return;
  }

  for (let current = scope; current !== undefined; current = current.parent) {
    if (!current.closed) current.entries += 1;
  }
}

/**
 * Throws UnauditedWriteError (mode 'throw') or logs it (mode 'record') when the scope's writes are
 * not empty, its entries are 0 and it is not on UNAUDITED_SURFACES.
 */
export function assertAuditCoverage(scope: AuditScope, mode?: WriteGuardMode): void {
  if (scope.writes.length === 0 || scope.entries > 0) return;
  if (UNAUDITED_SURFACES.has(scope.surface)) return;

  const error = new UnauditedWriteError(scope.surface, scope.writes);
  if ((mode ?? currentGuardMode()) === 'throw') throw error;

  logger.error(error.message);
}

/** The guard's mode, read at each call so a test can stub the environment. */
function currentGuardMode(): WriteGuardMode {
  return resolveWriteGuardMode({
    ENV_NAME: process.env['ENV_NAME'],
    NODE_ENV: process.env['NODE_ENV'],
  });
}

function isThenable<T>(value: T): value is T & PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}
