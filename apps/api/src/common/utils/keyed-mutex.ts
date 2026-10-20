/**
 * Plan D311: FIFO critical sections per key, in-process (Koda runs a single API instance, and the cache is
 * `CacheStrategy.MEMORY`). Two callers of `run` with the same key never overlap: the second waits for the first, then
 * runs its own section. Different keys run in parallel.
 *
 * Entries are dropped as soon as their tail settles, so the map only holds keys with an in-flight or queued section.
 * It is not a database lock: two processes still need a database constraint behind it.
 */
export class KeyedMutex {
  private tails: ReadonlyMap<string, Promise<unknown>> = new Map();

  get size(): number {
    return this.tails.size;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => fn(), () => fn());
    const tail = result.then(() => undefined, () => undefined);
    this.tails = new Map([...this.tails, [key, tail]]);
    void tail.then(() => {
      if (this.tails.get(key) !== tail) return;
      const next = new Map(this.tails);
      next.delete(key);
      this.tails = next;
    });
    return result;
  }
}
