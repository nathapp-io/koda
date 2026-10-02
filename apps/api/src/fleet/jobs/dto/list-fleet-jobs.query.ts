import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { KodaPageQuery } from '../../../common/dto/koda-page.query';
import { FleetJobState } from '../../../common/enums';

export class ListFleetJobsQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: Object.values(FleetJobState) }) @IsOptional() @IsIn(Object.values(FleetJobState)) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) repoId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) runnerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) requestedById?: string;
  @ApiPropertyOptional({ description: 'nax feature name (plan D10)' }) @IsOptional() @IsString() @MaxLength(128) feature?: string;
  @ApiPropertyOptional({ description: 'Only jobs dispatched by this schedule (S1b §3.4)' }) @IsOptional() @IsString() @MaxLength(64) scheduleId?: string;
}
