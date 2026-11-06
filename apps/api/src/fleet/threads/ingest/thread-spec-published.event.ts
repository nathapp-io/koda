/** Emitted only after the ingest transaction that applied a published line commits. */
export const THREAD_SPEC_PUBLISHED = 'thread.spec.published';

export interface ThreadSpecPublishedEvent {
  threadId: string;
  sha: string;
  paths: string[];
  /**
   * Publication snapshot immediately before this line was applied, captured under the thread lock.
   * Missing on legacy events; null when the thread had no prior publication. Consumers must re-ask
   * rather than carry approval across an unknown or skipped predecessor.
   */
  previousSha?: string | null;
}
