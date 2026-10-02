/**
 * Fleet S1b slice 3b: the API calls the schedules e2e makes outside the browser (cleanup, reading the dispatched job,
 * firing through the test-only hook, plan D213).
 */
import { call } from './fleet-budgets-api';

export interface ScheduleRow {
  id: string;
  name: string;
  enabled: boolean;
  disabledReason: string | null;
  lastJobId: string | null;
  nextFireAt: string | null;
}

export const listSchedules = (token: string, slug: string): Promise<ScheduleRow[]> =>
  call<ScheduleRow[]>('GET', `/projects/${slug}/fleet/schedules`, token);

export const getSchedule = (token: string, slug: string, id: string): Promise<ScheduleRow> =>
  call<ScheduleRow>('GET', `/projects/${slug}/fleet/schedules/${id}`, token);

/** Deletes every schedule of the project; their jobs are kept (3a D194). */
export async function deleteSchedules(token: string, slug: string): Promise<void> {
  for (const row of await listSchedules(token, slug)) {
    await call<void>('DELETE', `/projects/${slug}/fleet/schedules/${row.id}`, token);
  }
}

/** Runs one ticker round at the schedule's next fire (global admin token). */
export const fireSchedule = (token: string, id: string): Promise<{ firedAt: string; result: { dispatched: number } }> =>
  // `call` always sends Content-Type: application/json; fastify refuses an empty JSON body (FST_ERR_CTP_EMPTY_JSON_BODY).
  call('POST', `/fleet/test-hooks/schedules/${id}/fire`, token, {});
