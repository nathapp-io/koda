import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAgentDto {
  @ApiProperty({ description: 'Agent name' })
  @IsString({ message: '$t(common.validation.isString)' })
  @IsNotEmpty({ message: '$t(common.validation.required)' })
  name!: string;

  @ApiProperty({ description: 'Agent slug (unique identifier)' })
  @IsString({ message: '$t(common.validation.isString)' })
  @IsNotEmpty({ message: '$t(common.validation.required)' })
  slug!: string;
}
