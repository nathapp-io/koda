/** D28: an in-memory FIFO per repository key; held from the start of `prepare` to the end of cleanup. */
export class RepoMutex {
  private readonly tails = new Map<string, Promise<void>>();

  acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    let released = false;
    return previous.then(() => () => {
      if (released) return;
      released = true;
      open();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}
