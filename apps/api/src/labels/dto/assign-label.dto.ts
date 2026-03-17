import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class AssignLabelDto {
  @ApiProperty({ example: 'label-123' })
  @IsString()
  @IsNotEmpty()
  labelId!: string;
}
