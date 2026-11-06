/** Emitted only after the ingest transaction that applied a published line commits. */
export const THREAD_SPEC_PUBLISHED = 'thread.spec.published';

export interface ThreadSpecPublishedEvent {
  threadId: string;
  sha: string;
  paths: string[];
}
