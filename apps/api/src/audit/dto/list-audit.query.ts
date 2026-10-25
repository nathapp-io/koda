import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { ActionActorType } from '../../action-context/action-context';
import { KodaPageQuery } from '../../common/dto/koda-page.query';

export class ListAuditQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: ['USER', 'AGENT', 'RUNNER', 'SYSTEM'] })
  @IsOptional() @IsIn(['USER', 'AGENT', 'RUNNER', 'SYSTEM'])
  actorType?: ActionActorType;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128)
  key?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128)
  actorId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128)
  approverId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128)
  projectId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128)
  resourceType?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128)
  resourceId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128)
  correlationId?: string;

  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z)?$/, { message: 'use a date (YYYY-MM-DD) or a UTC instant ending in Z' })
  from?: string;

  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z)?$/, { message: 'use a date (YYYY-MM-DD) or a UTC instant ending in Z' })
  to?: string;
}
