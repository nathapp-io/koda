import type { FleetActorType } from '../../common/enums';

/** The actor an automatic action records; the same value for jobs, budgets and approvals. */
export interface TransitionActorRef {
  type: FleetActorType;
  id: string;
}

/**
 * A leaf module on purpose. Jobs, budgets and approvals all stamp automatic activity with this actor,
 * and §2.4 has the jobs module closing an approval — so a constant that only the jobs module owned would
 * make `approvals -> jobs` and `jobs -> approvals` a file-level cycle. It carries no imports beyond a
 * type, so nothing can close a cycle through it. `job-transitions.service` re-exports it, so existing
 * importers are unchanged. `schedules/schedule-payloads.ts` keeps its own `SYSTEM_ACTOR_ID` for the same
 * reason: nothing may import a service to read a constant.
 */
export const SYSTEM_ACTOR: TransitionActorRef = Object.freeze({ type: 'SYSTEM', id: 'system' });
