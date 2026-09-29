import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, Matches } from 'class-validator';

export const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export class CreateEnrollmentDto {
  @ApiPropertyOptional({ type: [String], description: 'Labels preset on the runner that enrolls with this token' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @Matches(LABEL_PATTERN, { each: true })
  labels?: string[];
}
