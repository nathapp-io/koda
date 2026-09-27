import { IsString, IsNotEmpty, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * US-003 — canonical CreateAgentDto. The slug must be kebab-case lowercase
 * alphanumeric: `^[a-z0-9]+(-[a-z0-9]+)*$`. Roles and capabilities are
 * optional here and become required after US-005 wires this DTO into the HTTP
 * route.
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
}
