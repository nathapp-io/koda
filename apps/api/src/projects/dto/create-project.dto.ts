import { IsString, MinLength, Matches, IsOptional, IsUrl, IsBoolean, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProjectDto {
  @ApiProperty({
    description: 'Project name',
    example: 'Koda',
    minLength: 2,
  })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(2, { message: '$t(common.validation.minLength)' })
  name!: string;

  @ApiProperty({
    description: 'Project slug - lowercase alphanumeric with hyphens',
    example: 'koda',
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
  })
  @IsString({ message: '$t(common.validation.isString)' })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: '$t(projects.slugInvalid)',
  })
  slug!: string;

  @ApiProperty({
    description: 'Project key - 2-6 uppercase alphanumeric characters for ticket references',
    example: 'KODA',
    pattern: '^[A-Z0-9]{2,6}$',
  })
  @IsString({ message: '$t(common.validation.isString)' })
  @Matches(/^[A-Z0-9]{2,6}$/, {
    message: '$t(projects.keyInvalid)',
  })
  key!: string;

  @ApiProperty({
    description: 'Project description',
    example: 'Dev ticket tracker',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  description?: string;

  @ApiProperty({
    description: 'Git remote repository URL',
    example: 'https://github.com/nathapp-io/koda',
    required: false,
  })
  @IsOptional()
  @IsUrl({}, { message: '$t(common.validation.isUrl)' })
  gitRemoteUrl?: string;

  @ApiProperty({
    description: 'Automatically index commits on ticket close',
    example: true,
    required: false,
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: '$t(common.validation.isBoolean)' })
  autoIndexOnClose?: boolean;

  @ApiProperty({
    description: 'Auto-assign mode for tickets: OFF, SUGGEST, or AUTO',
    example: 'OFF',
    required: false,
    default: 'OFF',
    enum: ['OFF', 'SUGGEST', 'AUTO'],
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @IsIn(['OFF', 'SUGGEST', 'AUTO'], { message: '$t(common.validation.isIn)' })
  autoAssign?: string;
}
