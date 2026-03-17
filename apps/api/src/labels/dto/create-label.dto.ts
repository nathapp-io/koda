import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsNotEmpty } from 'class-validator';

export class CreateLabelDto {
  @ApiProperty({ example: 'typescript' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: '#0066CC', required: false })
  @IsString()
  @IsOptional()
  color?: string;
}
