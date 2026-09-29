import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { KodaPageQuery } from '../../../common/dto/koda-page.query';

export class ListFleetActivityQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: ['runner', 'enrollment', 'repo'] })
  @IsOptional() @IsIn(['runner', 'enrollment', 'repo'])
  entityType?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64)
  actorId?: string;
}
