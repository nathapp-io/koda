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
 * Nothing opens a scope yet: `ActionContextInterceptor`, `runAsSystem` and `runAsSystemWriter` do
 * in US-010 and US-011, and the Prisma write guard counts into it in US-003.
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
}

const logger = new Logger(UnauditedWriteError.name);
const scopeStorage = new AsyncLocalStorage<ScopeState>();
const bookkeepingStorage = new AsyncLocalStorage<BookkeepingReason>();

interface TransactionTally {
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
 * that started it.
 */
export function openAuditScope<T>(
  surface: string,
  fn: (scope: AuditScope) => T,
  opts?: { detached?: boolean },
): T {
  const parent = opts?.detached === true ? undefined : scopeStorage.getStore();
  const scope: ScopeState = { surface, parent, writes: [], entries: 0 };

  return scopeStorage.run(scope, () => fn(scope));
}

/** openAuditScope, then assertAuditCoverage after fn's promise fulfils (immediately for a non-thenable). */
export function runInAuditScope<T>(surface: string, fn: () => T, opts?: { detached?: boolean }): T {
  return openAuditScope<T>(surface, (scope) => {
    const result = fn();

    // Prisma promises are lazy: the query runs when the promise is awaited, so the check waits for
    // a thenable result inside this scope's storage. A plain value is checked at once and returned
    // as it is.
    if (!isThenable(result)) {
      assertAuditCoverage(scope);
      return result;
    }

    return (async () => {
      const value = await result;
      assertAuditCoverage(scope);
      return value;
    })() as T;
  }, opts);
}

/**
 * Holds writes and entries until fn fulfils; rejection drops both and propagates unchanged.
 * Capture the destination now: scopes opened and checked inside fn must not receive buffered work.
 * This tracks the callback outcome, not the eventual database commit outcome.
 */
export function withTransactionTally<T>(fn: () => Promise<T>): Promise<T> {
  const scope = scopeStorage.getStore();
  const parent = tallyStorage.getStore();
  const tally: TransactionTally = { writes: [], entries: 0 };

  return tallyStorage.run(tally, async () => {
    const result = await fn();
    // An enclosing callback still owns the outcome of a nested tally's successful work.
    if (parent !== undefined) {
      for (const label of tally.writes) parent.writes.push(label);
      parent.entries += tally.entries;
    } else if (scope !== undefined) {
      for (const label of tally.writes) scope.writes.push(label);
      for (let destination: ScopeState | undefined = scope; destination !== undefined; destination = destination.parent) {
        destination.entries += tally.entries;
      }
    }
    return result;
  });
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

  const tally = tallyStorage.getStore();
  if (tally !== undefined) {
    tally.writes.push(label);
    return;
  }

  const scope = scopeStorage.getStore();
  if (scope === undefined) return;

  scope.writes.push(label);
}

/**
 * Buffers in the innermost tally, otherwise counts in the innermost scope and every enclosing one.
 * An entry recorded in a nested, record-only scope therefore satisfies the tick or request that
 * opened it. With neither a scope nor a tally, this is a no-op.
 */
export function noteAuditEntry(): void {
  const tally = tallyStorage.getStore();
  if (tally !== undefined) {
    tally.entries += 1;
    return;
  }

  for (let scope = scopeStorage.getStore(); scope !== undefined; scope = scope.parent) {
    scope.entries += 1;
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
