import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BUDGET_RUNNING_JOBS, BUDGET_SCOPE_TYPES, BUDGET_WINDOW_KINDS, BudgetPolicyRecord, BudgetRunningJobs, BudgetScopeType, BudgetWindowKind,
} from '../domain/budget.domain';

/** One policy with its live window state (S1b §2.4 list rows). */
export class BudgetPolicyDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ enum: BUDGET_SCOPE_TYPES }) declare scopeType: BudgetScopeType;
  @ApiPropertyOptional({ type: String, nullable: true }) declare scopeId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Owning project (project and repo scopes)' }) declare projectId: string | null;
  @ApiProperty({ enum: BUDGET_WINDOW_KINDS }) declare windowKind: BudgetWindowKind;
  @ApiProperty({ type: String, description: 'Decimal as string' }) declare amountUsd: string;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '1-99; null = no warn' }) declare warnPercent: number | null;
  @ApiProperty() declare hardStop: boolean;
  @ApiProperty({ enum: BUDGET_RUNNING_JOBS }) declare runningJobs: BudgetRunningJobs;
  @ApiProperty({ description: 'Effectively paused now (S1b §2.3)' }) declare paused: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) declare pausedAt: string | null;
  @ApiProperty({ description: 'Start of the current window; the epoch for lifetime' }) declare windowStart: string;
  @ApiProperty({ type: String, description: 'Current window spend, decimal as string' }) declare spentUsd: string;
  @ApiProperty({ description: 'Spend is at or past the warn threshold' }) declare warnReached: boolean;
  @ApiProperty() declare updatedById: string;
  @ApiProperty() declare createdAt: string;
  @ApiProperty() declare updatedAt: string;

  static from(p: BudgetPolicyRecord, state: { spentUsd: string; windowStart: Date; paused: boolean; warnReached: boolean }): BudgetPolicyDto {
    return Object.assign(new BudgetPolicyDto(), {
      id: p.id, scopeType: p.scopeType, scopeId: p.scopeId, projectId: p.projectId, windowKind: p.windowKind,
      amountUsd: p.amountUsd, warnPercent: p.warnPercent, hardStop: p.hardStop, runningJobs: p.runningJobs,
      paused: state.paused, pausedAt: p.pausedAt ? p.pausedAt.toISOString() : null, windowStart: state.windowStart.toISOString(),
      spentUsd: state.spentUsd, warnReached: state.warnReached, updatedById: p.updatedById,
      createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
    });
  }
}
