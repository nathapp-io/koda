import { IsString, IsOptional, IsNumber, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateAgentDto {
  @ApiProperty({ description: 'Agent name', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: 'Agent status (ACTIVE, PAUSED, OFFLINE)', required: false })
  @IsOptional()
  @IsIn(['ACTIVE', 'PAUSED', 'OFFLINE'])
  status?: string;

  @ApiProperty({ description: 'Max concurrent tickets agent can handle', required: false })
  @IsOptional()
  @IsNumber()
  maxConcurrentTickets?: number;
}
