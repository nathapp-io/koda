import { join } from 'node:path';
import type { SnapshotEventPayload } from '@nathapp/fleet-protocol';
import { mapStatusToSnapshot, readStatusFile } from './status-snapshot';
import { findCostRunId, findRunLog, runLogId } from './run-log';
import { featureDirFor } from '../paths/safe-segment';
import { readPrdStories, type StoryList } from './prd-stories';

export interface WatcherSink {
  snapshot(payload: SnapshotEventPayload): void;
  lifecycle(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface WatcherOptions {
  readonly outDir: string;
  readonly feature: string;
  /** D146: RUN jobs only. Stories come from `<repoDir>/.nax/features/<feature>/prd.json` (S1b §1.2). */
  readonly repoDir?: string;
  readonly onRunIds?: (ids: { naxRunId: string; logPath: string | null }) => void;
}

const UNREADABLE_STREAK = 5;

/**
 * Polls nax's status and PRD files and turns them into journal events (design §2 step 7). One tick per poll; the
 * caller sleeps. Logs are not read here: the LogShipper uploads them (S2a §2.4, plan D320).
 */
export class Watcher {
  private unreadable = 0;
  private lastKey = '';
  private lastIds = '';
  private runLogPath: string | null = null;
  /** D148: the serialized list last sent for this job and epoch (one Watcher per JobRun). */
  private lastStories = '';

  constructor(private readonly sink: WatcherSink, private readonly options: WatcherOptions) {}

  async tick(): Promise<void> {
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
    });
    const list = await this.readStories();
    // D148: a failed read keeps the last list's key, so nax caught mid-write emits nothing extra.
    const storiesKey = list ? JSON.stringify(list) : this.lastStories;
    const key = `${JSON.stringify(payload)}\n${storiesKey}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (list !== null && storiesKey !== this.lastStories) {
      this.lastStories = storiesKey;
      this.sink.snapshot({ ...payload, stories: list.stories, storiesTruncated: list.truncated });
    } else {
      this.sink.snapshot(payload);
    }
    const ids = `${status.run.id}|${this.runLogPath ?? ''}`;
    if (ids !== this.lastIds) {
      this.lastIds = ids;
      this.options.onRunIds?.({ naxRunId: status.run.id, logPath: this.runLogPath });
    }
  }

  private async readStories(): Promise<StoryList | null> {
    if (this.options.repoDir === undefined) return null;
    try {
      return await readPrdStories(join(featureDirFor(this.options.repoDir, this.options.feature), 'prd.json'));
    } catch {
      return null;   // featureDirFor refuses only a feature name the assign validator already refused
    }
  }
}
