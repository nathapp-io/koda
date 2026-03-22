import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class UpdateLabelDto {
  @ApiProperty({ example: 'typescript', required: false })
  @IsString({ message: '$t(common.validation.isString)' })
  @IsOptional()
  name?: string;

  @ApiProperty({ example: '#0066CC', required: false })
  @IsString({ message: '$t(common.validation.isString)' })
  @IsOptional()
  color?: string;
}
