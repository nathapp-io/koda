import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { LABEL_PATTERN } from '../../runners/dto/create-enrollment.dto';

export const MAX_NO_PROGRESS_LIMIT = 20;

export class CreateScheduleDto {
  @ApiProperty({ description: 'Display name' }) @IsString() @Length(1, 80) @Matches(/\S/) declare name: string;
  @ApiProperty({ description: 'Fleet repo id of this project' }) @IsString() @Length(1, 64) declare repoId: string;
  @ApiProperty({ description: 'nax feature name; fixed after create' }) @IsString() @MaxLength(128) declare feature: string;
  @ApiProperty({ description: 'Five-field cron, for example "0 9 * * 1-5"; consecutive fires at least 15 minutes apart' })
  @IsString() @Length(9, 100) declare cron: string;
  @ApiProperty({ description: 'IANA timezone the cron is read in, for example Asia/Singapore' }) @IsString() @Length(1, 64) declare timezone: string;
  @ApiPropertyOptional({ description: 'Git ref to check out detached; defaults to the repo default branch at create time' })
  @IsOptional() @IsString() @MaxLength(255) ref?: string;
  @ApiPropertyOptional({ type: [String], description: 'nax profile chain, later wins' })
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(64, { each: true }) profiles?: string[];
  @ApiProperty({ description: 'Budget of each run in USD, > 0, at most 4 decimals' })
  @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(10_000) declare maxCostUsd: number;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(16) @Matches(LABEL_PATTERN, { each: true }) selectorLabels?: string[];
  @ApiPropertyOptional({ description: 'Run on this runner only' }) @IsOptional() @IsString() @Length(1, 64) pinnedRunnerId?: string;
  @ApiPropertyOptional({ description: 'Disable after this many runs in a row without a newly passed story (1-20); default 3' })
  @IsOptional() @IsInt() @Min(1) @Max(MAX_NO_PROGRESS_LIMIT) noProgressLimit?: number;
}
