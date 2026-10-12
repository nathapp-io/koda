import type { ThreadLiveEvent } from '../../../../live/thread-event-bus';
import type { ThreadLine } from '../thread-line';

export const THREAD_INGEST_REPOSITORY: unique symbol = Symbol('THREAD_INGEST_REPOSITORY');
export const THREAD_UNFOLDED_STREAM_SOURCE: unique symbol = Symbol('THREAD_UNFOLDED_STREAM_SOURCE');

export interface ThreadIngestBatch {
  jobId: string;
  leaseEpoch: number;
  lines: Array<{ line: ThreadLine | { bad: true }; endOffset: number }>;
  endOffset: number;
  badLines: number;
}

export interface FoldResult {
  costChanged: boolean;
  events: readonly ThreadLiveEvent[];
}

export interface ThreadIngestRepository {
  readCursor(jobId: string, leaseEpoch: number): Promise<{ offset: number; skippedLines: number }>;
  fold(batch: ThreadIngestBatch): Promise<FoldResult>;
}

/** One THREAD job attempt whose `thread` stream holds bytes past its fold cursor. */
export interface UnfoldedStream {
  jobId: string;
  leaseEpoch: number;
}

export interface UnfoldedStreamSource {
  /** Attempts still to fold: non-terminal or finished within 24 hours, at most 200, oldest job first. */
  findUnfolded(): Promise<UnfoldedStream[]>;
}
