import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class AssignLabelDto {
  @ApiProperty({ example: 'label-123' })
  @IsString({ message: 'common.validation.isString' })
  @IsNotEmpty({ message: 'common.validation.required' })
  labelId!: string;
}
