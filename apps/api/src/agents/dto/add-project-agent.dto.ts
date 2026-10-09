import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** S4c US-003 (D530): body of POST /projects/:slug/agents — an existing agent's slug. */
export class AddProjectAgentDto {
  @ApiProperty({ description: 'Slug of an existing agent', example: 'bot-1' })
  @IsString()
  @IsNotEmpty()
  declare agentSlug: string;
}
