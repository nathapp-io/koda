/**
 * Fleet S5b: the in-process events that trigger knowledge index passes.
 *
 * The PR-state refresher (a merged fleet PR) and the bundle ingest (a RUN's outcomes stored) emit these on
 * `EventEmitter2`; `KnowledgeIndexQueue` subscribes. The emitters never import the knowledge module, so
 * `FleetTicketsModule` and `IngestModule` stay free of it and `KnowledgeModule` may depend on them instead.
 *
 * Delivery is synchronous and best-effort, like the queue it feeds. Nest attaches the listener at application
 * bootstrap and removes it at shutdown; an event emitted outside that window, or with the knowledge module not
 * loaded, is dropped. A dropped merge pass is recovered by the next head poll (GitHub repositories only), a
 * dropped outcome pass only by a manual ingest re-run (`POST fleet/ingest/rerun-outdated`, or per job). The
 * ingest sweeper therefore waits for the emitter's readiness, and an unheard run-ingested event is logged.
 */

/** A fleet PR was merged into this repository: its docs changed, so the repository is re-indexed. */
export const KNOWLEDGE_REPO_MERGED = 'fleet.knowledge.repo-merged';

/** A RUN job's bundle ingest committed: its outcome rows are indexed. */
export const KNOWLEDGE_RUN_INGESTED = 'fleet.knowledge.run-ingested';

export interface KnowledgeRepoMergedEvent {
  readonly repoId: string;
}

export interface KnowledgeRunIngestedEvent {
  readonly jobId: string;
}
