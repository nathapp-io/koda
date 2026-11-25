/**
 * Plan D311: FIFO critical sections per key, in-process (Koda runs a single API instance, and the cache is
 * `CacheStrategy.MEMORY`). Two callers of `run` with the same key never overlap: the second waits for the first, then
 * runs its own section. Different keys run in parallel.
 *
 * Entries are dropped as soon as their tail settles, so the map only holds keys with an in-flight or queued section.
 * It is not a database lock: two processes still need a database constraint behind it.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  get size(): number {
    return this.tails.size;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => fn(), () => fn());
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) !== tail) return;
      this.tails.delete(key);
    });
    return result;
  }
}
