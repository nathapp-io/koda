import type { SessionBackend } from '@nathapp/nax-agent';

type FailureStage = 'shutdown' | 'transcript';

/** A thread keeps its checkout (or scratch directory) through the last operation the backend actually owns. */
export class ThreadWorktreeLease {
  private readonly controller = new AbortController();
  private readonly backends = new Set<Promise<void>>();
  private released = false;

  constructor(private readonly free: () => void, private readonly report: (stage: FailureStage, error: unknown) => void) {}

  /** Retain the backend itself. The facade can be waiting on a turn long after the run's close budget expired. */
  backend(backend: SessionBackend, transcriptSignal?: AbortSignal): SessionBackend {
    const signal = this.controller.signal;
    return {
      kind: backend.kind,
      open: async (ctx) => {
        signal.throwIfAborted();
        const opened = backend.open({ ...ctx, openSignal: AbortSignal.any([signal, ctx.openSignal]) });
        const closed = opened.then(async (handle) => {
          if (!signal.aborted) {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          }
          try { await handle.close(); }
          catch (error) {
            // ACP reports final transcript errors after its process and MCP host have stopped.
            // Report storage failures separately. A physical shutdown failure retains the checkout.
            if (!backend.kind.startsWith('acp:') || !(error instanceof Error) ||
              !('code' in error) || error.code !== 'ACP_FINAL_TRANSCRIPT_FAILED') throw error;
            if (!transcriptSignal?.aborted || error.cause !== transcriptSignal.reason) this.report('transcript', error.cause);
          }
        }, () => {});
        this.backends.add(closed);
        // A failed physical close leaves ownership in place. No successor may assume the actor is gone.
        void closed.then(() => this.backends.delete(closed), (error: unknown) => this.report('shutdown', error));
        return opened;
      },
    };
  }

  revoke(): void {
    this.controller.abort();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.revoke();
    if (this.backends.size === 0) this.free();
    else void Promise.all(this.backends).then(this.free, () => {});
  }
}

export class ThreadWorktreeOwners {
  private readonly held = new Map<string, Promise<void>>();

  constructor(private readonly report: (threadId: string, stage: FailureStage, error: unknown) => void) {}

  activeIds(): string[] {
    return [...this.held.keys()];
  }

  pending(): Promise<void>[] {
    return [...this.held.values()];
  }

  async acquire(id: string, signal: AbortSignal): Promise<ThreadWorktreeLease | undefined> {
    while (!signal.aborted) {
      const previous = this.held.get(id);
      if (previous === undefined) {
        let release!: () => void;
        this.held.set(id, new Promise<void>((resolve) => { release = resolve; }));
        return new ThreadWorktreeLease(() => {
          this.held.delete(id);
          release();
        }, (stage, error) => this.report(id, stage, error));
      }
      let stop!: () => void;
      const stopped = new Promise<void>((resolve) => { stop = resolve; });
      signal.addEventListener('abort', stop, { once: true });
      try { await Promise.race([previous, stopped]); }
      finally { signal.removeEventListener('abort', stop); }
    }
    return undefined;
  }
}
