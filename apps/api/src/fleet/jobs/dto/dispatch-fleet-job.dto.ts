import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { BashMode } from '../../common/protocol';
import { LABEL_PATTERN } from '../../runners/dto/create-enrollment.dto';

export class DispatchFleetJobDto {
  @ApiProperty() @IsString() @Length(1, 64) declare repoId: string;
  @ApiPropertyOptional({ description: 'Git ref to check out detached; defaults to the repo default branch' })
  @IsOptional() @IsString() @MaxLength(255) ref?: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) @IsIn(['RUN', 'PLAN']) declare command: 'RUN' | 'PLAN';
  @ApiProperty({ description: 'nax feature name' }) @IsString() @MaxLength(128) declare feature: string;
  @ApiPropertyOptional({ description: 'Repo-relative spec path, PLAN only' }) @IsOptional() @IsString() @MaxLength(512) planFrom?: string;
  @ApiPropertyOptional({ type: [String], description: 'nax profile chain, later wins' })
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(64, { each: true }) profiles?: string[];
  @ApiProperty({ description: 'USD, > 0, at most 4 decimals' })
  @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(10_000) declare maxCostUsd: number;
  @ApiPropertyOptional({ enum: ['raw', 'gated', 'escalate'], default: 'raw', description: 'S1.5: gated/escalate relay bash asks to the approvals inbox. RUN only; needs a runner with the approval relay.' })
  @IsOptional() @IsIn(['raw', 'gated', 'escalate']) bashMode?: BashMode;

  @ApiPropertyOptional({ minimum: 30, maximum: 3600, default: 600, description: 'Seconds a bash ask waits for a decision before nax denies it. Used only when bashMode is not raw.' })
  @IsOptional() @IsInt() @Min(30) @Max(3600) approvalTimeoutSec?: number;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(16) @Matches(LABEL_PATTERN, { each: true }) selectorLabels?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) pinnedRunnerId?: string;
  @ApiPropertyOptional({ type: [String], maxItems: 20, description: 'Tickets this job works on, KEY-N (fleet C9). A RUN moves CREATED/VERIFIED ones to IN_PROGRESS.' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(32, { each: true }) ticketRefs?: string[];

  @ApiPropertyOptional({ description: 'C9 follow-up (#231): proceed with a RUN even when a target ticket already has an open VCS PR. Without it the dispatch is refused so a ticket does not end up with two PRs.' })
  @IsOptional() @IsBoolean() acknowledgeOpenPr?: boolean;
}
