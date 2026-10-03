import type { ScheduleDisabledReason, ScheduleRecord } from './domain/schedule.domain';

/** The activity actor id of an automatic action (the same value as `SYSTEM_ACTOR.id` in `common/system-actor.ts`). */
export const SYSTEM_ACTOR_ID = 'system';

/**
 * FleetActivity payload of a schedule row. `FleetActivityService.record` throws on a key matching
 * /token|secret|key|password|credential/i, so none of these names may contain one.
 */
export function schedulePayload(s: ScheduleRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: s.name, repoId: s.repoId, feature: s.feature, cron: s.cron, timezone: s.timezone, ...extra };
}

/** Body of the fleet.schedule.disabled webhook (S1b §4). */
export function scheduleWebhookPayload(s: ScheduleRecord, reason: ScheduleDisabledReason): Record<string, unknown> {
  return {
    scheduleId: s.id, projectId: s.projectId, name: s.name, repoId: s.repoId, feature: s.feature, reason,
    noProgressTicks: s.noProgressTicks, noProgressLimit: s.noProgressLimit, lastPassedCount: s.lastPassedCount, lastJobId: s.lastJobId,
  };
}
