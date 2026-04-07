import { IsUrl, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTicketLinkDto {
  @ApiProperty({ example: 'https://github.com/owner/repo/pull/1' })
  @IsUrl({}, { message: 'url must be a valid URL' })
  url: string;

  @ApiProperty({ example: 'url', required: false })
  @IsOptional()
  @IsString()
  linkType?: string;
}
