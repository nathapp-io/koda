import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { MAX_BUDGET_USD, whenProvided } from '../../budgets/dto/create-budget-policy.dto';
import { APPROVAL_DECISIONS, ApprovalDecision, MAX_REQUEUE_CANDIDATES } from '../domain/approval.domain';

export class DecideApprovalDto {
  @ApiProperty({ enum: APPROVAL_DECISIONS }) @IsIn(APPROVAL_DECISIONS)
  declare decision: ApprovalDecision;

  @ApiPropertyOptional({ description: 'raise_budget_and_resume: the new amount, above the window spend' })
  @ValidateIf(whenProvided) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(MAX_BUDGET_USD)
  amountUsd?: number;

  @ApiPropertyOptional({ type: [String], description: 'raise_budget_and_resume: candidate job ids to re-queue; omitted = none (plan D231)' })
  @ValidateIf(whenProvided) @IsArray() @ArrayMaxSize(MAX_REQUEUE_CANDIDATES) @IsString({ each: true }) @MaxLength(64, { each: true })
  requeueJobIds?: string[];

  @ApiPropertyOptional({ maxLength: 1000 }) @ValidateIf(whenProvided) @IsString() @MaxLength(1000)
  comment?: string;
}
