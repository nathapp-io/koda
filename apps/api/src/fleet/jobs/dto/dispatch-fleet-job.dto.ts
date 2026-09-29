import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
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
  @ApiPropertyOptional({ enum: ['raw'], description: 'Only raw until S1.5' }) @IsOptional() @IsIn(['raw']) bashMode?: 'raw';
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(16) @Matches(LABEL_PATTERN, { each: true }) selectorLabels?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) pinnedRunnerId?: string;
}
