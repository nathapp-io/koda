import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class PlanThreadDto {
  @ApiPropertyOptional({ type: [String], maxItems: 8 })
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(64, { each: true })
  profiles?: string[];

  @ApiPropertyOptional({ minimum: 0.0001, maximum: 10_000, description: 'USD, > 0, at most 4 decimals' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(10_000)
  maxCostUsd?: number;
}
