import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsNumber, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

/**
 * `@IsOptional()` would also skip validation when the field is explicitly `null`, and the service then
 * spreads `null` as profiles (TypeError) or stores the string `'null'` in the Decimal column. Skipping
 * only `undefined` keeps "omitted" meaning "keep the stored value" while an explicit `null` fails
 * validation with a 400.
 */
const isPresent = (_object: unknown, value: unknown): boolean => value !== undefined;

export class UpdateAutoReviewDto {
  @ApiProperty() @IsBoolean() declare enabled: boolean;
  @ApiPropertyOptional({ type: [String], maxItems: 8 })
  @ValidateIf(isPresent) @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(64, { each: true }) profiles?: string[];
  @ApiPropertyOptional({ minimum: 0.0001, maximum: 10000, description: 'USD, at most 4 decimals' })
  @ValidateIf(isPresent) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(10_000) maxCostUsd?: number;
}
