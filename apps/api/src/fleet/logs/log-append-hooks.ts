import { Injectable } from '@nestjs/common';

export interface LogAppendEvent {
  jobId: string;
  leaseEpoch: number;
  stream: string;
}

export type LogAppendHook = (e: LogAppendEvent) => Promise<void>;

/**
 * Fleet S5a: post-append extension point. A hook runs after the upload's write lock is released, so it may take
 * the same stream lock. `run` awaits the hooks of the event's stream in registration order and rejects on the
 * first failure; LogUploadService logs that failure and keeps the upload result.
 */
@Injectable()
export class LogAppendHooks {
  private readonly hooks = new Map<string, LogAppendHook[]>();

  register(stream: string, hook: LogAppendHook): void {
    this.hooks.set(stream, [...(this.hooks.get(stream) ?? []), hook]);
  }

  async run(e: LogAppendEvent): Promise<void> {
    for (const hook of this.hooks.get(e.stream) ?? []) {
      await hook(e);
    }
  }
}
