import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, Max, Min, ValidateIf } from 'class-validator';
import { MAX_BUDGET_USD, whenProvided } from './create-budget-policy.dto';

export class ResumeBudgetPolicyDto {
  @ApiPropertyOptional({ description: 'New amount; must be above the current window spend. Omitted = keep the amount.' })
  @ValidateIf(whenProvided) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(MAX_BUDGET_USD)
  amountUsd?: number;
}
