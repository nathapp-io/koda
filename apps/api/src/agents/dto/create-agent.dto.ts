import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAgentDto {
  @ApiProperty({ description: 'Agent name' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ description: 'Agent slug (unique identifier)' })
  @IsString()
  @IsNotEmpty()
  slug!: string;
}
