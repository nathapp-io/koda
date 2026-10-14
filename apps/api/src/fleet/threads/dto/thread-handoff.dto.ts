import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { BashMode } from '../../common/protocol';

export class PlanThreadDto {
  @ApiPropertyOptional({ type: [String], maxItems: 8 })
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(64, { each: true })
  profiles?: string[];

  @ApiPropertyOptional({ minimum: 0.0001, maximum: 10_000, description: 'USD, > 0, at most 4 decimals' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(10_000)
  maxCostUsd?: number;
}

export class RunThreadDto {
  @ApiPropertyOptional({ type: [String], maxItems: 8 })
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(64, { each: true })
  profiles?: string[];

  @ApiPropertyOptional({ minimum: 0.0001, maximum: 10_000, description: 'USD, > 0, at most 4 decimals' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(10_000)
  maxCostUsd?: number;

  @ApiPropertyOptional({ enum: ['raw', 'gated', 'escalate'], default: 'raw', description: 'gated/escalate relay bash asks to the approvals inbox. Needs a runner with the approval relay.' })
  @IsOptional() @IsIn(['raw', 'gated', 'escalate']) bashMode?: BashMode;
}
