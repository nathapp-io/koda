/** Plan D311: FIFO critical sections per key, in-process (single API instance). */
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
