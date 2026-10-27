import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';

export class ListApprovalPoliciesQuery extends KodaPageQuery {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  permissionPattern?: string;
}
