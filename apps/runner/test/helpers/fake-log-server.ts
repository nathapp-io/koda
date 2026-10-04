import type { LogStreamName, LogTransport, PutLogAnswer, PutLogArgs } from '../../src/logs/types';

export interface LogCall {
  readonly key: string;
  readonly stream: LogStreamName;
  readonly offset: number;
  readonly text: string;
  readonly final: boolean;
}

/** One scripted answer for the next PUT: an answer, 'hold' (wait for release() or the abort), or 'network' (reject). */
export type LogOverride = PutLogAnswer | 'hold' | 'network';

/**
 * The slice 1a upload rules in memory (exact-offset append, duplicate, offset, final only at the end, complete is
 * sticky), keyed `<jobId>:<leaseEpoch>:<stream>`. Overrides are taken in order, one per PUT.
 */
export function fakeLogServer() {
  const files = new Map<string, Buffer>();
  const complete = new Set<string>();
  const calls: LogCall[] = [];
  const overrides: LogOverride[] = [];
  let held: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const answer = (key: string, bytes: Buffer, offset: number, final: boolean): PutLogAnswer => {
    const current = files.get(key) ?? Buffer.alloc(0);
    if (complete.has(key)) return { status: 200, outcome: 'complete', size: current.length };
    let size = current.length;
    let outcome: 'appended' | 'duplicate' = 'duplicate';
    if (bytes.length > 0) {
      if (offset === current.length) {
        files.set(key, Buffer.concat([current, bytes]));
        size += bytes.length;
        outcome = 'appended';
      } else if (offset + bytes.length > current.length) {
        return { status: 200, outcome: 'offset', size };
      }
    } else if (offset !== current.length) {
      return { status: 200, outcome: 'offset', size };
    }
    if (final) {
      if (size !== offset + bytes.length) return { status: 200, outcome: 'offset', size };
      complete.add(key);
      return { status: 200, outcome: 'complete', size };
    }
    return { status: 200, outcome, size };
  };

  const transport: LogTransport = {
    async putLog(args: PutLogArgs): Promise<PutLogAnswer> {
      const key = `${args.jobId}:${args.leaseEpoch}:${args.stream}`;
      const bytes = Buffer.from(args.bytes);
      calls.push({ key, stream: args.stream, offset: args.offset, text: bytes.toString('utf8'), final: args.final });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const next = overrides.shift();
        if (next === 'network') throw new Error('connect ECONNREFUSED');
        if (next === 'hold') {
          await new Promise<void>((resolve, reject) => {
            const abort = (): void => reject(new Error('aborted'));
            if (args.signal?.aborted) abort();
            args.signal?.addEventListener('abort', abort, { once: true });
            held = [...held, resolve];
          });
        } else if (next !== undefined) {
          return next;
        }
        return answer(key, bytes, args.offset, args.final);
      } finally {
        inFlight -= 1;
      }
    },
  };

  return {
    transport,
    calls,
    overrides,
    /** Lets every held PUT go on to the normal answer. */
    release(): void {
      const waiting = held;
      held = [];
      for (const resolve of waiting) resolve();
    },
    get maxInFlight(): number { return maxInFlight; },
    get inFlight(): number { return inFlight; },
    stored: (key: string): string => (files.get(key) ?? Buffer.alloc(0)).toString('utf8'),
    isComplete: (key: string): boolean => complete.has(key),
    /** Pretends a previous daemon already uploaded these bytes (re-adopt). */
    seed: (key: string, text: string): void => { files.set(key, Buffer.from(text)); },
  };
}
