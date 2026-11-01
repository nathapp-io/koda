/** Emitted only after the ingest transaction commits newly pending review events. */
export const REVIEW_EVENTS_INGESTED = 'fleet.review.events-ingested';
export interface ReviewEventsIngestedEvent { jobId: string }
