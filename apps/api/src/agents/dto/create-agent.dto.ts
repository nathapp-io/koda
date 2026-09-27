import { IsString, IsNotEmpty, IsOptional, IsArray, IsNumber, IsIn, Min, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AGENT_ROLES } from '../../common/enums';

/**
 * US-005 — canonical CreateAgentDto. The slug must be kebab-case lowercase
 * alphanumeric: `^[a-z0-9]+(-[a-z0-9]+)*$`. Roles and capabilities are
 * optional here.
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

  @ApiProperty({ description: 'Agent roles (e.g. DEVELOPER, REVIEWER)', example: ['DEVELOPER', 'REVIEWER'], required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn([...AGENT_ROLES], { each: true })
  roles?: string[];

  @ApiProperty({ description: 'Agent capabilities (e.g. typescript, nestjs)', example: ['typescript', 'nestjs'], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capabilities?: string[];
}
