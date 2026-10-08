import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';

export class ListNotificationsQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'true = unread only' })
  @IsOptional()
  @IsIn(['true', 'false'])
  unread?: 'true' | 'false';
}
