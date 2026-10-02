import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, Max, Min, ValidateIf } from 'class-validator';
import { BUDGET_RUNNING_JOBS, BudgetRunningJobs } from '../domain/budget.domain';
import { MAX_BUDGET_USD, whenProvided, whenSet } from './create-budget-policy.dto';

/** Plan D161: scope and window are fixed. An omitted field is unchanged. */
export class UpdateBudgetPolicyDto {
  @ApiPropertyOptional({ description: 'USD, > 0, at most 4 decimals' })
  @ValidateIf(whenProvided) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(MAX_BUDGET_USD)
  amountUsd?: number;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '1-99; null = no warn; omitted = unchanged' })
  @ValidateIf(whenSet) @IsInt() @Min(1) @Max(99) warnPercent?: number | null;

  @ApiPropertyOptional() @ValidateIf(whenProvided) @IsBoolean() hardStop?: boolean;

  @ApiPropertyOptional({ enum: BUDGET_RUNNING_JOBS }) @ValidateIf(whenProvided) @IsIn([...BUDGET_RUNNING_JOBS]) runningJobs?: BudgetRunningJobs;
}
