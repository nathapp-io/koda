import { AsyncLocalStorage } from 'node:async_hooks';

const effects = new AsyncLocalStorage<Array<() => void>>();

/**
 * The transaction OWNER wraps its complete run(), not its callback. Nested fleet run() calls join
 * that transaction; their live publications and runner wakes must join this queue too. A rejected
 * callback or commit drops the queue. Outside an owning scope, existing post-run effects stay direct.
 * Like the in-process live buses, this is best-effort, not a durable outbox.
 */
export async function withCommittedEffects<T>(transaction: () => Promise<T>): Promise<T> {
  if (effects.getStore()) return transaction();
  const pending: Array<() => void> = [];
  const value = await effects.run(pending, transaction);
  for (const effect of pending) effect();
  return value;
}

/** Used only for non-persistent live effects, never domain writes or request settlement. */
export function committedEffect(effect: () => void): void {
  const pending = effects.getStore();
  if (pending) pending.push(effect);
  else effect();
}
