import type { ThreadSession, ThreadWriteResult } from '../domain/chat-thread.domain';
import type { ThreadLine } from './thread-line';

/** Distinct paths the thread keeps since the last publish (fleet S5a §4). Further paths are not recorded. */
export const WRITTEN_PATHS_MAX = 200;

/** The write-path lines the fold applies: the five C1 types. */
export type WriteLine = Extract<ThreadLine, { type: 'write_doc' | 'published' | 'publish_failed' | 'discarded' | 'discard_failed' }>;

/** The `ChatThread` fields a write-path line reads. */
export interface WriteFoldState {
  writtenPaths: string[];
  session: ThreadSession | null;
}

/** The `ChatThread` fields one write-path line changes; keys it does not change are absent. */
export interface WriteFoldPatch {
  writtenPaths?: string[];
  publishedSha?: string;
  specPublished?: boolean;
  lastWrite?: ThreadWriteResult;
  session?: ThreadSession;
}

/**
 * Pure: the `ChatThread` patch one write-path line implies. `at` is the line's own `at` when it has one, else the
 * fold's clock (`ctx.at`); `jobId` is the batch's job.
 */
export function writeLinePatch(state: WriteFoldState, line: WriteLine, ctx: { jobId: string; at: string }): WriteFoldPatch {
  const at = line.at ?? ctx.at;
  const jobId = ctx.jobId;
  switch (line.type) {
    case 'write_doc': {
      if (state.writtenPaths.includes(line.path) || state.writtenPaths.length >= WRITTEN_PATHS_MAX) return {};
      return { writtenPaths: [...state.writtenPaths, line.path] };
    }
    case 'published':
      return {
        publishedSha: line.sha,
        specPublished: line.specPresent,
        writtenPaths: [],
        lastWrite: { kind: 'published', jobId, at, sha: line.sha, paths: line.paths, ignored: line.ignored },
      };
    case 'publish_failed':
      return { lastWrite: { kind: 'publish_failed', jobId, at, reason: line.reason } };
    case 'discarded': {
      const patch: WriteFoldPatch = {
        writtenPaths: [],
        lastWrite: { kind: 'discarded', jobId, at, sha: line.tipSha },
      };
      if (state.session && 'stale' in state.session) {
        const { stale: _stale, ...rest } = state.session;
        patch.session = rest;
      }
      return patch;
    }
    case 'discard_failed':
      return { lastWrite: { kind: 'discard_failed', jobId, at, reason: line.reason } };
  }
}
