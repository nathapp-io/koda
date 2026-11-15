import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsNotEmpty } from 'class-validator';

export class CreateLabelDto {
  @ApiProperty({ example: 'typescript' })
  @IsString({ message: 'common.validation.isString' })
  @IsNotEmpty({ message: 'common.validation.required' })
  name!: string;

  @ApiProperty({ example: '#0066CC', required: false })
  @IsString({ message: 'common.validation.isString' })
  @IsOptional()
  color?: string;
}
