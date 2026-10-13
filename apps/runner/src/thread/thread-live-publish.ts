import type { RepoMutex } from '../supervisor/repo-mutex';
import type { ThreadPublishInput, ThreadPublishResult } from './thread-job-run';
import type { ThreadEventWriter } from './thread-event-writer';

export interface ThreadLivePublishOptions {
  readonly publish: (input: ThreadPublishInput) => Promise<ThreadPublishResult>;
  readonly input: ThreadPublishInput;
  readonly writer: () => ThreadEventWriter | null;
  readonly turnRunning: () => boolean;
  readonly stopped: () => boolean;
  readonly stopIdle: () => void;
  readonly armIdle: () => void;
}

/** Owns the single in-flight publish and serializes its result with session close and input. */
export class ThreadLivePublish {
  private pending: Promise<void> | null = null;
  constructor(private readonly options: ThreadLivePublishOptions) {}

  command(): { result: 'ok' | 'rejected'; detail?: string } {
    if (this.options.turnRunning()) return { result: 'rejected', detail: 'turn_running' };
    if (this.pending !== null) return { result: 'rejected', detail: 'publishing' };
    this.options.stopIdle();
    // Defer execute so `pending` is installed before calling host code. `publish` may throw
    // synchronously, in which case execute's finally block must not be overwritten afterwards.
    const pending = Promise.resolve().then(() => this.execute());
    this.pending = pending;
    return { result: 'ok' };
  }

  get publishing(): boolean { return this.pending !== null; }
  async wait(): Promise<void> { await this.pending; }

  private async execute(): Promise<void> {
    try {
      let result: ThreadPublishResult;
      try { result = await this.options.publish(this.options.input); }
      catch { result = { ok: false, reason: 'git_error' }; }
      if (this.options.stopped()) return;
      const writer = this.options.writer();
      if (writer !== null) {
        if (result.ok) writer.published(result);
        else writer.publishFailed(result.reason);
      }
    } finally {
      this.pending = null;
      if (!this.options.stopped()) this.options.armIdle();
    }
  }
}

export function publishInputMutex(mutex: Pick<RepoMutex, 'acquire'> & Partial<Pick<RepoMutex, 'isLocked'>>): Pick<RepoMutex, 'acquire' | 'isLocked'> {
  return { acquire: (key) => mutex.acquire(key), isLocked: (key) => mutex.isLocked ? mutex.isLocked(key) : false };
}
