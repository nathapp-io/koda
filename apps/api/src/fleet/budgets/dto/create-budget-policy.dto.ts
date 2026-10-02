import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min, ValidateIf } from 'class-validator';
import {
  BUDGET_RUNNING_JOBS, BUDGET_SCOPE_TYPES, BUDGET_WINDOW_KINDS, BudgetRunningJobs, BudgetScopeType, BudgetWindowKind,
} from '../domain/budget.domain';

export const MAX_BUDGET_USD = 1_000_000;
/** Validators run only for a value that is present and not null: null means "no warn". */
export const whenSet = (_o: unknown, v: unknown): boolean => v !== undefined && v !== null;
/** Validators run for any present value, so an explicit null fails (`@IsOptional` would let it through). */
export const whenProvided = (_o: unknown, v: unknown): boolean => v !== undefined;

export class CreateBudgetPolicyDto {
  @ApiProperty({ enum: BUDGET_SCOPE_TYPES, description: 'global and runner on /fleet/budgets; project and repo on /projects/:slug/fleet/budgets' })
  @IsIn([...BUDGET_SCOPE_TYPES]) declare scopeType: BudgetScopeType;

  @ApiPropertyOptional({ description: 'Runner id (runner) or fleet repo id (repo); omitted for global and project' })
  @IsOptional() @IsString() @Length(1, 64) scopeId?: string;

  @ApiProperty({ enum: BUDGET_WINDOW_KINDS }) @IsIn([...BUDGET_WINDOW_KINDS]) declare windowKind: BudgetWindowKind;

  @ApiProperty({ description: 'USD, > 0, at most 4 decimals' })
  @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(MAX_BUDGET_USD) declare amountUsd: number;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '1-99; omitted = 80; null = no warn' })
  @ValidateIf(whenSet) @IsInt() @Min(1) @Max(99) warnPercent?: number | null;

  @ApiPropertyOptional({ description: 'Pause the scope at the amount; default true' }) @IsOptional() @IsBoolean() hardStop?: boolean;

  @ApiPropertyOptional({ enum: BUDGET_RUNNING_JOBS, description: 'What a hard stop does to running jobs; default finish' })
  @IsOptional() @IsIn([...BUDGET_RUNNING_JOBS]) runningJobs?: BudgetRunningJobs;
}
