import { IsString, IsNotEmpty, IsOptional, IsArray, IsNumber, Min, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * US-005 — canonical CreateAgentDto. The slug must be kebab-case lowercase
 * alphanumeric: `^[a-z0-9]+(-[a-z0-9]+)*$`. Capabilities are optional here.
 *
 * Permissions P1l (US-005): an agent's roles are role bindings, not an `AgentRoleEntry` list, so the
 * create carries no `roles` field — `POST /role-bindings` grants them afterwards.
 */
export class CreateAgentDto {
  @ApiProperty({ description: 'Agent name' })
  @IsString({ message: '$t(common.validation.isString)' })
  @IsNotEmpty({ message: '$t(common.validation.required)' })
  name!: string;

  @ApiProperty({
    description: 'Agent slug (unique identifier, lowercase alphanumeric with hyphens)',
    example: 'good-slug-1',
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
  })
  @IsString({ message: '$t(common.validation.isString)' })
  @IsNotEmpty({ message: '$t(common.validation.required)' })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: '$t(common.validation.slugInvalid)',
  })
  slug!: string;

  @ApiProperty({ description: 'Maximum concurrent tickets the agent can handle', required: false, minimum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxConcurrentTickets?: number;

  @ApiProperty({ description: 'Agent capabilities (e.g. typescript, nestjs)', example: ['typescript', 'nestjs'], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capabilities?: string[];
}
