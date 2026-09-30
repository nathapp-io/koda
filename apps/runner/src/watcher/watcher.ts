import { join } from 'node:path';
import type { LogEventPayload, SnapshotEventPayload } from '@nathapp/fleet-protocol';
import { mapStatusToSnapshot, readStatusFile } from './status-snapshot';
import { FileTail } from './file-tail';
import { LogBudget, chunkText } from './log-budget';
import { findCostRunId, findRunLog, runLogId } from './run-log';

export interface WatcherSink {
  snapshot(payload: SnapshotEventPayload): void;
  lifecycle(level: 'info' | 'warn' | 'error', message: string): void;
  logLine(payload: LogEventPayload): void;
}

export interface WatcherOptions {
  readonly outDir: string;
  readonly feature: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly startAtEnd: boolean;
  readonly nowMs: () => number;
  readonly onRunIds?: (ids: { naxRunId: string; logPath: string | null }) => void;
}

const UNREADABLE_STREAK = 5;

type Stream = LogEventPayload['stream'];

/** Polls nax's files and turns them into journal events (design §2 step 7). One tick per poll; the caller sleeps. */
export class Watcher {
  private readonly budget: LogBudget;
  private tails = new Map<Stream, FileTail>();
  private ticks = 0;
  private unreadable = 0;
  private lastKey = '';
  private lastIds = '';
  private runLogPath: string | null = null;

  constructor(private readonly sink: WatcherSink, private readonly options: WatcherOptions) {
    this.budget = new LogBudget(options.nowMs);
  }

  async tick(final = false): Promise<void> {
    const first = this.ticks === 0;
    this.ticks += 1;
    await this.pumpStatus();
    await this.pumpLogs(first, final);
  }

  private async pumpStatus(): Promise<void> {
    const { status, problem } = await readStatusFile(join(this.options.outDir, 'status.json'));
    if (problem === 'invalid') {
      this.unreadable += 1;
      if (this.unreadable === UNREADABLE_STREAK) this.sink.lifecycle('warn', 'status.json unreadable 5 times in a row');
      return;
    }
    if (!status) return;
    this.unreadable = 0;
    this.runLogPath ??= await findRunLog(this.options.outDir, this.options.feature);
    const payload = mapStatusToSnapshot(status, {
      logRunId: this.runLogPath ? runLogId(this.runLogPath) : null,
      costRunId: await findCostRunId(this.options.outDir),
      droppedLogs: this.budget.dropped,
    });
    const { droppedLogs: _dropped, ...stable } = payload;
    const key = JSON.stringify(stable);
    if (key === this.lastKey) return;      // lost logs ride the next snapshot that is emitted anyway (D45)
    this.lastKey = key;
    this.budget.takeDropped();
    this.sink.snapshot(payload);
    const ids = `${status.run.id}|${this.runLogPath ?? ''}`;
    if (ids !== this.lastIds) {
      this.lastIds = ids;
      this.options.onRunIds?.({ naxRunId: status.run.id, logPath: this.runLogPath });
    }
  }

  private async tailFor(stream: Stream, path: string, first: boolean): Promise<FileTail> {
    const existing = this.tails.get(stream);
    if (existing) return existing;
    const tail = this.options.startAtEnd && first ? await FileTail.fromEnd(path) : FileTail.fromStart(path);
    this.tails.set(stream, tail);
    return tail;
  }

  private async pumpLogs(first: boolean, final: boolean): Promise<void> {
    this.runLogPath ??= await findRunLog(this.options.outDir, this.options.feature);
    const sources: Array<[Stream, string | null]> = [
      ['run', this.runLogPath], ['stdout', this.options.stdoutPath], ['stderr', this.options.stderrPath],
    ];
    for (const [stream, path] of sources) {
      if (path === null) continue;
      const text = await (await this.tailFor(stream, path, first)).readNew(final);
      for (const chunk of chunkText(text)) {
        if (this.budget.take()) this.sink.logLine({ stream, text: chunk });
      }
    }
  }
}
