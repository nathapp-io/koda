import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { MemoryItem } from './memory-item-repository';

/** What an upsert wrote: the new item and the active item it superseded, if any. */
export interface MemoryWritten {
  item: MemoryItem;
  superseded: MemoryItem | null;
}

/** The keys a memory write records: the entry point that wrote it. */
export type MemoryAuditKey = 'memory.create' | 'memory.extract' | 'memory.decision.record' | 'system.memory.extract-from-event' | 'system.review.decision';

/** The audit resource every memory entry names. */
const RESOURCE_TYPE = 'memory-item';

/**
 * `created <KIND>`, or `created <KIND>, superseded <id>`; never the subject, predicate or object.
 *
 * Permissions P2 US-002: subject, predicate and object are user-written text — a memory key can name a
 * private fact — so an entry carries the kind and, for a replacement, the id of the item it replaced.
 */
export function memoryWriteSummary(written: MemoryWritten): string {
  const created = `created ${written.item.kind}`;
  return written.superseded === null ? created : `${created}, superseded ${written.superseded.id}`;
}

/**
 * An `onWritten` hook that records `key` on the new item, inside the upsert's transaction.
 *
 * The repository awaits the answer before its transaction commits, so a refused `record` rolls the write
 * back: the new item never exists and the item it superseded stays active. Each entry point passes the key
 * it writes under, so a replacement is an entry of the route that made it, not a key of its own.
 */
export function memoryAuditHook(
  audit: AuditRecorder,
  key: MemoryAuditKey,
): (written: MemoryWritten) => Promise<void> {
  return async (written: MemoryWritten): Promise<void> => {
    await audit.record({
      key,
      resourceType: RESOURCE_TYPE,
      resourceId: written.item.id,
      projectId: written.item.projectId,
      summary: memoryWriteSummary(written),
    });
  };
}
