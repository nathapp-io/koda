import type { DispatchFleetJobDto } from '../jobs/dto/dispatch-fleet-job.dto';
import type { ScheduleRecord } from './domain/schedule.domain';

export type ScheduleTemplate = Pick<
  ScheduleRecord,
  'repoId' | 'feature' | 'ref' | 'profiles' | 'maxCostUsd' | 'selectorLabels' | 'pinnedRunnerId' | 'bashMode' | 'approvalTimeoutSec'
>;

/** S1b §3.1, B4: the template as a RUN dispatch. The same dispatch rules validate it (create) and run it (tick). */
export function toDispatchDto(template: ScheduleTemplate): DispatchFleetJobDto {
  return {
    repoId: template.repoId,
    command: 'RUN',
    feature: template.feature,
    ref: template.ref,
    profiles: [...template.profiles],
    maxCostUsd: Number(template.maxCostUsd),
    selectorLabels: [...template.selectorLabels],
    bashMode: template.bashMode,
    approvalTimeoutSec: template.approvalTimeoutSec,
    ...(template.pinnedRunnerId ? { pinnedRunnerId: template.pinnedRunnerId } : {}),
  };
}
