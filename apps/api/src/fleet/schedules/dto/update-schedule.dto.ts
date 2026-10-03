import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsString, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { BashMode } from '../../common/protocol';
import { whenProvided, whenSet } from '../../budgets/dto/create-budget-policy.dto';
import { LABEL_PATTERN } from '../../runners/dto/create-enrollment.dto';
import { MAX_NO_PROGRESS_LIMIT } from './create-schedule.dto';

/** Plan D203: the repo and the feature are fixed. An omitted field is unchanged; `pinnedRunnerId: null` unpins. */
export class UpdateScheduleDto {
  @ApiPropertyOptional() @ValidateIf(whenProvided) @IsString() @Length(1, 80) @Matches(/\S/) name?: string;
  @ApiPropertyOptional({ description: 'Five-field cron' }) @ValidateIf(whenProvided) @IsString() @Length(9, 100) cron?: string;
  @ApiPropertyOptional({ description: 'IANA timezone' }) @ValidateIf(whenProvided) @IsString() @Length(1, 64) timezone?: string;
  @ApiPropertyOptional() @ValidateIf(whenProvided) @IsString() @Length(1, 255) ref?: string;
  @ApiPropertyOptional({ type: [String], description: 'Replaces the profile chain; [] clears it' })
  @ValidateIf(whenProvided) @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(64, { each: true }) profiles?: string[];
  @ApiPropertyOptional({ description: 'USD, > 0, at most 4 decimals' })
  @ValidateIf(whenProvided) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(10_000) maxCostUsd?: number;
  @ApiPropertyOptional({ enum: ['raw', 'gated', 'escalate'], description: 'S1.5: gated/escalate relay bash asks to the approvals inbox. RUN only; needs a runner with the approval relay.' })
  @ValidateIf(whenProvided) @IsIn(['raw', 'gated', 'escalate']) bashMode?: BashMode;
  @ApiPropertyOptional({ minimum: 30, maximum: 3600, description: 'Seconds a bash ask waits for a decision before nax denies it. Used only when bashMode is not raw.' })
  @ValidateIf(whenProvided) @IsInt() @Min(30) @Max(3600) approvalTimeoutSec?: number;
  @ApiPropertyOptional({ type: [String], description: 'Replaces the selector labels; [] clears them' })
  @ValidateIf(whenProvided) @IsArray() @ArrayMaxSize(16) @Matches(LABEL_PATTERN, { each: true }) selectorLabels?: string[];
  @ApiPropertyOptional({ type: String, nullable: true, description: 'null unpins' })
  @ValidateIf(whenSet) @IsString() @Length(1, 64) pinnedRunnerId?: string | null;
  @ApiPropertyOptional({ description: '1-20' }) @ValidateIf(whenProvided) @IsInt() @Min(1) @Max(MAX_NO_PROGRESS_LIMIT) noProgressLimit?: number;
}
