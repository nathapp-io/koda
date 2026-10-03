import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { BashMode } from '../../common/protocol';
import { SCHEDULE_DISABLED_REASONS, ScheduleDisabledReason, ScheduleRecord } from '../domain/schedule.domain';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** One schedule (S1b §3.1, §3.4). */
export class ScheduleDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty({ description: 'May name a repo that has since been deleted; the schedule is then disabled (template_invalid)' }) declare repoId: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ description: 'Five-field cron' }) declare cron: string;
  @ApiProperty({ description: 'IANA timezone the cron is read in' }) declare timezone: string;
  @ApiProperty() declare feature: string;
  @ApiProperty() declare ref: string;
  @ApiProperty({ type: [String] }) declare profiles: string[];
  @ApiProperty({ type: String, description: 'Decimal as string' }) declare maxCostUsd: string;
  @ApiProperty({ type: [String] }) declare selectorLabels: string[];
  @ApiProperty({ enum: ['raw', 'gated', 'escalate'], description: 'S1.5: gated/escalate relay bash asks to the approvals inbox. RUN only; needs a runner with the approval relay.' }) declare bashMode: BashMode;
  @ApiProperty({ description: 'Seconds a bash ask waits for a decision before nax denies it. Used only when bashMode is not raw.' }) declare approvalTimeoutSec: number;
  @ApiPropertyOptional({ type: String, nullable: true }) declare pinnedRunnerId: string | null;
  @ApiProperty() declare enabled: boolean;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Next fire; null while disabled' }) declare nextFireAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare lastFiredAt: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare lastJobId: string | null;
  @ApiProperty({ description: 'Stories passed at the last run that made progress' }) declare lastPassedCount: number;
  @ApiProperty({ description: 'Runs in a row without a newly passed story' }) declare noProgressTicks: number;
  @ApiProperty({ description: 'The schedule disables itself at this many' }) declare noProgressLimit: number;
  @ApiPropertyOptional({ enum: SCHEDULE_DISABLED_REASONS, nullable: true }) declare disabledReason: ScheduleDisabledReason | null;
  @ApiProperty({ type: String, description: 'Cost of every job this schedule dispatched, decimal as string' }) declare totalCostUsd: string;
  @ApiProperty() declare createdById: string;
  @ApiProperty() declare updatedById: string;
  @ApiProperty() declare createdAt: string;
  @ApiProperty() declare updatedAt: string;

  static from(s: ScheduleRecord, totalCostUsd: string): ScheduleDto {
    return Object.assign(new ScheduleDto(), {
      id: s.id, projectId: s.projectId, repoId: s.repoId, name: s.name, cron: s.cron, timezone: s.timezone, feature: s.feature, ref: s.ref,
      profiles: s.profiles, maxCostUsd: s.maxCostUsd, selectorLabels: s.selectorLabels, bashMode: s.bashMode, approvalTimeoutSec: s.approvalTimeoutSec,
      pinnedRunnerId: s.pinnedRunnerId, enabled: s.enabled,
      nextFireAt: s.enabled ? s.nextFireAt.toISOString() : null, lastFiredAt: iso(s.lastFiredAt), lastJobId: s.lastJobId,
      lastPassedCount: s.lastPassedCount, noProgressTicks: s.noProgressTicks, noProgressLimit: s.noProgressLimit,
      disabledReason: s.disabledReason, totalCostUsd, createdById: s.createdById, updatedById: s.updatedById,
      createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString(),
    });
  }
}
