import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { LABEL_PATTERN } from './create-enrollment.dto';

export class UpdateRunnerDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @Matches(LABEL_PATTERN, { each: true })
  labels?: string[];

  @ApiPropertyOptional({ minimum: 1, maximum: 16 }) @IsOptional() @IsInt() @Min(1) @Max(16) capacity?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 16 }) @IsOptional() @IsInt() @Min(0) @Max(16) threadCapacity?: number;
}
