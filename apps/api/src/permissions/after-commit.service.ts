import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

/** One unit of work that must run once the transaction which produced it has committed. */
export type AfterCommitTask = () => Promise<void>;

/**
 * Permissions P1a: runs a deferred task after the outermost transaction committed.
 *
 * `txManager.run` joins an open transaction, so a `MembershipService` write called from inside another
 * service's transaction cannot tell when its rows become visible. Invalidating the permission cache
 * before that commit is unsafe: a concurrent request inside the window recomputes the effective keys
 * from the pre-commit state and caches them under the new cache generation, and nothing invalidates
 * again after the commit — every later `can` call then answers from those stale entries until the 60 s
 * TTL expires.
 *
 * The owner of the transaction wraps it in `scope` (`MembershipService.afterCommit`). Everything
 * deferred inside runs when the scope resolves, which is after that transaction ended. A rollback
 * drops the pending tasks: nothing was stored, so the cache still describes the database.
 *
 * The queue lives in an `AsyncLocalStorage`, so concurrent requests never see each other's tasks.
 */
@Injectable()
export class AfterCommitService {
  private readonly als = new AsyncLocalStorage<AfterCommitTask[]>();

  /**
   * Runs `fn` and then the tasks it deferred. A nested call joins the outermost scope, so the flush
   * happens exactly once, at the outermost commit.
   */
  async scope<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore() !== undefined) return fn();
    const pending: AfterCommitTask[] = [];
    const value = await this.als.run(pending, fn);
    for (const task of pending) await task();
    return value;
  }

  /**
   * Queues `task` for the enclosing scope. False when there is none: the caller is then either outside
   * every transaction — and can run the task itself — or inside one nobody owns, which is a bug in the
   * caller rather than something this service can repair.
   */
  defer(task: AfterCommitTask): boolean {
    const pending = this.als.getStore();
    if (pending === undefined) return false;
    pending.push(task);
    return true;
  }
}
