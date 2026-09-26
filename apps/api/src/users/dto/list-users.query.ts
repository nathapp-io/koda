import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';

export class ListUsersQuery extends KodaPageQuery {
  @ApiPropertyOptional({ description: 'Case-insensitive substring match on email' })
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;
}
