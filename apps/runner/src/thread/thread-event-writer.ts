import { appendFileSync, statSync } from 'node:fs';
import { THREAD_STREAM_LIMITS, type ThreadBackend } from '@nathapp/fleet-protocol';
import { redactSecrets, type SessionEvent } from '@nathapp/nax-agent';
import { TUNING } from '../daemon/tuning';
import { errorMessage } from '../errors';
import { PathError } from '../paths/safe-segment';
import { systemNow, systemSleep, type Now, type Sleep } from '../time';

const LINE_MAX_BYTES = THREAD_STREAM_LIMITS.lineMaxBytes;
const DEFAULT_STREAM_MAX_BYTES = THREAD_STREAM_LIMITS.streamMaxBytes;
/** B3-R11: how much raw delta text stays unwritten, so a secret split across two deltas is redacted whole. */
const HOLD_BACK_CHARS = 256;
/** B3-R11: with no whitespace to cut on, a buffer past this many characters is cut anyway. */
const FORCED_CUT_CHARS = 4096;
/** The room left below `streamMaxBytes` for the runner's own lines (`started`, `closed`, `failed`). */
const CAP_RESERVE_BYTES = 4096;
const WHITESPACE = /\s/;
const HIGH_SURROGATE = /[\uD800-\uDBFF]/;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;

/** What the writer needs from the runner-wide log shipper. */
export interface ThreadWakeSink {
  wake(jobId: string, leaseEpoch: number): void;
}

/** The `session_started` line's payload. */
export interface ThreadSessionStart {
  readonly resumed: boolean;
  readonly backend: ThreadBackend;
  readonly skillShas: string[];
}

/**
 * A session line as the writer consumes it. nax-agent's `SessionEvent` carries `sessionId`,
 * `turnId`, `at` and `metadata`; a line that arrives with fewer or more fields is streamed as it
 * came, so the writer never drops a field it does not know about.
 */
export interface ThreadSessionRecord {
  readonly type: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly at?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly round?: number;
  readonly text?: string;
  readonly output?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly [key: string]: unknown;
}

export type ThreadSessionEvent = SessionEvent | ThreadSessionRecord;

export interface ThreadEventWriterOptions {
  /** The stream file: created with mode 0600 when absent, appended to when present. */
  readonly path?: string;
  /** The same file under the fleet spec's name; `path` wins when both are given. */
  readonly filePath?: string;
  readonly jobId: string;
  readonly leaseEpoch: number;
  /** Woken after an append, paced by `wakeGapMs`. */
  readonly logs: ThreadWakeSink;
  /** Defaults to `TUNING.threadWakeGapMs`. */
  readonly wakeGapMs?: number;
  readonly now?: Now;
  readonly sleep?: Sleep;
  /** Defaults to `THREAD_STREAM_LIMITS.streamMaxBytes`. */
  readonly streamMaxBytes?: number;
  /** Called once, when a session line no longer fits below the stream cap. */
  readonly onCap?: () => void;
  /** A line that had to be dropped or shortened. */
  readonly onWarn?: (message: string) => void;
}

/** One round's raw delta text, with the line template its chunks are written from. */
interface HeldDelta {
  readonly line: ThreadSessionRecord;
  readonly text: string;
}

function lineBytes(line: Record<string, unknown>): number {
  const json = JSON.stringify(line);
  return json === undefined ? 0 : Buffer.byteLength(`${json}\n`, 'utf8');
}

/**
 * B3-R11: where the writable prefix of `text` ends. It ends at the last whitespace that sits at
 * least `HOLD_BACK_CHARS` characters before the buffer's end — a secret never contains whitespace,
 * so a cut there cannot split one. With no such whitespace, a buffer past `FORCED_CUT_CHARS` is cut
 * `HOLD_BACK_CHARS` characters before its end anyway, and a shorter one stays wholly unwritten.
 *
 * At a session-line boundary (`boundary`) a buffer no longer than the hold-back has no tail left to
 * protect, so all of it goes out — redacted whole — before the next line.
 */
function writablePrefixEnd(text: string, boundary: boolean): number {
  if (boundary && text.length <= HOLD_BACK_CHARS) return text.length;
  for (let index = text.length - HOLD_BACK_CHARS; index >= 0; index -= 1) {
    if (WHITESPACE.test(text[index])) return index + 1;
  }
  return text.length > FORCED_CUT_CHARS ? text.length - HOLD_BACK_CHARS : 0;
}

/** The longest prefix of `text` whose UTF-8 encoding fits in `budget` bytes, cut on a code point. */
function byteCut(text: string, budget: number): number {
  let used = 0;
  let cut = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > budget) break;
    used += size;
    cut += char.length;
  }
  return cut;
}

/** `index` moved back off a low surrogate, so a cut never halves a code point. */
function codePointCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  return HIGH_SURROGATE.test(text[index - 1]) && LOW_SURROGATE.test(text[index]) ? index - 1 : index;
}

function roundKey(line: ThreadSessionRecord): string {
  return `${line.turnId ?? ''}\u0000${String(line.round)}`;
}

function errorValue(value: unknown): { readonly code?: string; readonly message?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as { readonly code?: string; readonly message?: string };
}

/**
 * S5a slice B3: the thread stream writer. It serializes one JSON object per line — nax-agent's
 * session events interleaved with the runner's own lifecycle lines — into an append-only file,
 * redacting every free-text field and never exceeding the line or stream cap.
 */
export class ThreadEventWriter {
  private readonly path: string;
  private readonly jobId: string;
  private readonly leaseEpoch: number;
  private readonly logs: ThreadWakeSink;
  private readonly wakeGapMs: number;
  private readonly now: Now;
  private readonly sleep: Sleep;
  private readonly streamMaxBytes: number;
  private readonly onCap: () => void;
  private readonly onWarn: (message: string) => void;

  /** Raw delta text not yet written, keyed by (turnId, round). */
  private readonly held = new Map<string, HeldDelta>();
  private written: number;
  private capped = false;
  private lastWakeAt: number | null = null;
  private trailingWake = false;

  constructor(options: ThreadEventWriterOptions) {
    const path = options.path ?? options.filePath;
    if (path === undefined) throw new PathError('invalid thread stream path');
    this.path = path;
    this.jobId = options.jobId;
    this.leaseEpoch = options.leaseEpoch;
    this.logs = options.logs;
    this.wakeGapMs = options.wakeGapMs ?? TUNING.threadWakeGapMs;
    this.now = options.now ?? systemNow;
    this.sleep = options.sleep ?? systemSleep;
    this.streamMaxBytes = options.streamMaxBytes ?? DEFAULT_STREAM_MAX_BYTES;
    this.onCap = options.onCap ?? (() => undefined);
    this.onWarn = options.onWarn ?? (() => undefined);
    this.written = fileSizeOf(path, this.onWarn);
  }

  /** The stream file's size, including whatever a previous writer left in it. */
  bytes(): number {
    return this.written;
  }

  event(e: ThreadSessionEvent): void {
    if (typeof e !== 'object' || e === null) {
      // A session iterator that yields junk must not take the job down with it.
      this.onWarn('dropped a malformed session event');
      return;
    }
    const line = e as ThreadSessionRecord;
    if (line.type === 'text_delta') this.onTextDelta(line);
    else if (line.type === 'stream_reset') this.onStreamReset(line);
    else if (line.type === 'turn_end') this.onTurnEnd(line);
    else this.onSessionLine(line);
    this.paceWake();
  }

  started(start: ThreadSessionStart): void {
    this.releaseAll();
    this.appendRunner({ type: 'session_started', at: this.now().toISOString(), resumed: start.resumed, backend: start.backend, skillShas: start.skillShas });
  }

  inputConsumed(messageId: string): void {
    this.releaseAll();
    this.appendRunner({ type: 'input_consumed', at: this.now().toISOString(), messageId });
  }

  closed(reason: string): void {
    this.releaseAll();
    this.appendRunner({ type: 'session_closed', at: this.now().toISOString(), reason });
  }

  failed(reason: string): void {
    this.releaseAll();
    this.appendRunner({ type: 'session_failed', at: this.now().toISOString(), reason });
  }

  /** Writes every held delta, so nothing raw is lost when the session ends. */
  flush(): void {
    const held = this.held.size > 0;
    this.releaseAll();
    if (held) this.paceWake();
  }

  private onTextDelta(line: ThreadSessionRecord): void {
    const text: unknown = line.text;
    if (typeof text !== 'string') {
      // A delta without text is not a delta: held text goes out first, then the line as it came.
      this.releasePrefixes();
      this.writeSessionObject(line);
      return;
    }
    if (text === '') return;
    const key = roundKey(line);
    this.releasePrefixes(key);   // B3-R11: another round's held text goes out before this round's line
    const held = this.held.get(key);
    this.held.set(key, { line, text: `${held?.text ?? ''}${text}` });
    this.releasePrefix(key, false);
  }

  private onStreamReset(line: ThreadSessionRecord): void {
    this.held.delete(roundKey(line));
    this.releasePrefixes();
    this.writeSessionObject(line);
  }

  private onTurnEnd(line: ThreadSessionRecord): void {
    this.releaseAll();
    this.writeTurnEnd(line);
  }

  private onSessionLine(line: ThreadSessionRecord): void {
    this.releasePrefixes();
    if (line.type !== 'thinking_delta' || typeof line.text !== 'string') {
      this.writeSessionObject(line);
      return;
    }
    this.writeChunks(line, 'text', redactSecrets(line.text));
  }

  /** Writes the part of one round's held text that may leave the buffer now; the rest stays raw. */
  private releasePrefix(key: string, boundary: boolean): void {
    const held = this.held.get(key);
    if (held === undefined || held.text === '') return;
    const end = writablePrefixEnd(held.text, boundary);
    if (end <= 0) return;
    const rest = held.text.slice(end);
    if (rest === '') this.held.delete(key);
    else this.held.set(key, { line: held.line, text: rest });
    this.writeChunks(held.line, 'text', redactSecrets(held.text.slice(0, end)));
  }

  /**
   * B3-R11: before any other line, each round's held text goes out ahead of it. `keep` skips one
   * round — the one whose own `text_delta` is arriving, which releases its prefix right after.
   */
  private releasePrefixes(keep?: string): void {
    for (const key of [...this.held.keys()]) {
      if (key !== keep) this.releasePrefix(key, true);
    }
  }

  /**
   * Writes every held delta whole — the point at which a secret split across deltas is redacted at once.
   * A line the stream cap refuses, or a write that fails, is dropped and reported through `onWarn`: the
   * cap is permanent and the bundle carries the full text, so the writer keeps no retry buffer.
   */
  private releaseAll(): void {
    const held = [...this.held.values()];
    this.held.clear();
    for (const delta of held) {
      if (delta.text !== '') this.writeChunks(delta.line, 'text', redactSecrets(delta.text));
    }
  }

  private writeTurnEnd(line: ThreadSessionRecord): void {
    const full: Record<string, unknown> = { ...line };
    if (typeof line.output === 'string') full.output = redactSecrets(line.output);
    const error = errorValue(line.error);
    if (error !== undefined && typeof error.message === 'string') {
      // B3-R11: the message is redacted whole; the rest of the error line is kept as produced.
      full.error = { ...error, message: redactSecrets(error.message) };
    }
    const wrapped: Record<string, unknown> = { type: 'session_event', event: full };
    if (lineBytes(wrapped) <= LINE_MAX_BYTES) {
      this.writeSessionObject(wrapped);
      return;
    }
    const truncated: Record<string, unknown> = { ...full, output: '', outputTruncated: true };
    const wrappedTruncated: Record<string, unknown> = { type: 'session_event', event: truncated };
    if (lineBytes(wrappedTruncated) <= LINE_MAX_BYTES) {
      this.writeSessionObject(wrappedTruncated);
      return;
    }
    this.onWarn(`dropped an oversized turn_end line (${LINE_MAX_BYTES}-byte line limit)`);
  }

  /** Writes `text` as one or more lines of `field`, none longer than the line limit. */
  private writeChunks(base: ThreadSessionRecord, field: string, text: string): void {
    let rest = text;
    while (rest !== '') {
      const chunk = this.takeChunk(base, field, rest);
      if (chunk === '') {
        this.onWarn(`dropped a ${base.type} line that cannot fit the ${LINE_MAX_BYTES}-byte line limit`);
        return;
      }
      rest = rest.slice(chunk.length);
      if (!this.writeSessionObject({ ...base, [field]: chunk })) return;
    }
  }

  /** The longest prefix of `text` that keeps the serialized line within the line limit. */
  private takeChunk(base: ThreadSessionRecord, field: string, text: string): string {
    if (lineBytes({ ...base, [field]: text }) <= LINE_MAX_BYTES) return text;
    const budget = LINE_MAX_BYTES - lineBytes({ ...base, [field]: '' });
    let low = 1;
    let high = Math.min(text.length, byteCut(text, Math.max(0, budget)));
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const end = codePointCut(text, middle);
      if (end > 0 && lineBytes({ ...base, [field]: text.slice(0, end) }) <= LINE_MAX_BYTES) {
        best = end;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return text.slice(0, best);
  }

  /** One session line, unless the line or stream cap refuses it. False stops the rest of its event. */
  private writeSessionObject(line: Record<string, unknown>): boolean {
    const bytes = lineBytes(line);
    if (bytes > LINE_MAX_BYTES) {
      this.onWarn(`dropped an oversized ${String(line.type)} line (${LINE_MAX_BYTES}-byte line limit)`);
      return false;
    }
    if (this.bytes() + bytes > this.streamMaxBytes - CAP_RESERVE_BYTES) {
      this.reachCap();
      return false;
    }
    this.append(line);
    return true;
  }

  private reachCap(): void {
    if (this.capped) return;
    this.capped = true;
    this.onCap();
  }

  /** A runner line is always written: it is what tells the server the session started or ended. */
  private appendRunner(line: Record<string, unknown>): void {
    this.append(line);
    this.paceWake();
  }

  private append(line: Record<string, unknown>): void {
    const json = JSON.stringify(line);
    if (json === undefined) return;
    const body = `${json}\n`;
    try {
      // mode applies when the file is created; an existing stream keeps its own mode.
      appendFileSync(this.path, body, { mode: 0o600 });
      this.written += Buffer.byteLength(body, 'utf8');
    } catch (error) {
      this.onWarn(`thread stream write failed: ${errorMessage(error)}`);
    }
  }

  /** Wakes the shipper at most once per `wakeGapMs`, plus one trailing wake after the gap. */
  private paceWake(): void {
    const at = this.now().getTime();
    if (!this.trailingWake && (this.lastWakeAt === null || at - this.lastWakeAt >= this.wakeGapMs)) {
      this.lastWakeAt = at;
      this.logs.wake(this.jobId, this.leaseEpoch);
      return;
    }
    if (this.trailingWake) return;
    this.trailingWake = true;
    void this.sleep(this.wakeGapMs).then(
      () => this.trailingWakeFired(),
      (error: unknown) => {
        // A sleep that rejects must not strand the flag: every later wake would be suppressed.
        this.onWarn(`thread wake sleep failed: ${errorMessage(error)}`);
        this.trailingWakeFired();
      },
    );
  }

  /** The gap elapsed: the appends that arrived inside it are reported now. */
  private trailingWakeFired(): void {
    this.trailingWake = false;
    this.lastWakeAt = this.now().getTime();
    this.logs.wake(this.jobId, this.leaseEpoch);
  }
}

function fileSizeOf(path: string, onWarn: (message: string) => void): number {
  try {
    return statSync(path).size;
  } catch (error) {
    // A file that is absent is empty; any other failure (EACCES, ENOTDIR) is reported and read the
    // same way, because a stream the runner cannot size must not take the job down — the appends that
    // follow report their own failure through the same warning.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      onWarn(`cannot read the thread stream size: ${errorMessage(error)}`);
    }
    return 0;
  }
}
