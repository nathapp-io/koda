import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

const CUID_PATTERN = /^c[a-z0-9]+$/;

export class AssignTicketDto {
  @ApiPropertyOptional({ description: 'User ID (CUID) to assign the ticket to' })
  @IsOptional()
  @IsString()
  @Matches(CUID_PATTERN, { message: 'userId must be a valid CUID' })
  userId?: string;

  @ApiPropertyOptional({ description: 'Agent ID (CUID) to assign the ticket to' })
  @IsOptional()
  @IsString()
  @Matches(CUID_PATTERN, { message: 'agentId must be a valid CUID' })
  agentId?: string;
}