import { IsString, MinLength, Matches, IsOptional, IsUrl, IsBoolean, IsIn, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProjectDto {
  @ApiProperty({
    description: 'Project name',
    example: 'Updated Project Name',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(2, { message: '$t(common.validation.minLength)' })
  name?: string;

  @ApiProperty({
    description: 'Project slug - lowercase alphanumeric with hyphens',
    example: 'updated-project',
    required: false,
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: '$t(projects.slugInvalid)',
  })
  slug?: string;

  @ApiProperty({
    description: 'Project key - 2-6 uppercase letters',
    example: 'UPDATED',
    required: false,
    pattern: '^[A-Z]{2,6}$',
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @Matches(/^[A-Z]{2,6}$/, {
    message: '$t(projects.keyInvalid)',
  })
  key?: string;

  @ApiProperty({
    description: 'Project description',
    example: 'Updated description',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  description?: string;

  @ApiPropertyOptional({
    description: 'Curated short project brief rendered into thread instructions (at most 3000 characters)',
    example: 'Koda is a fleet platform that tracks tickets for humans and agents.',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @MaxLength(3000, { message: '$t(common.validation.maxLength)' })
  brief?: string | null;

  @ApiProperty({
    description: 'Git remote repository URL',
    example: 'https://github.com/nathapp-io/updated-repo',
    required: false,
  })
  @IsOptional()
  @IsUrl({}, { message: '$t(common.validation.isUrl)' })
  gitRemoteUrl?: string;

  @ApiProperty({
    description: 'Automatically index commits on ticket close',
    example: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean({ message: '$t(common.validation.isBoolean)' })
  autoIndexOnClose?: boolean;

  @ApiProperty({
    description: 'Auto-assign mode for tickets: OFF, SUGGEST, or AUTO',
    example: 'SUGGEST',
    required: false,
    enum: ['OFF', 'SUGGEST', 'AUTO'],
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @IsIn(['OFF', 'SUGGEST', 'AUTO'], { message: '$t(common.validation.isIn)' })
  autoAssign?: string;

  @ApiPropertyOptional({
    description: 'CI webhook token for authentication',
    example: 'ci_webhook_token_123',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(32, { message: '$t(common.validation.webhookSecretMinLength)' })
  ciWebhookToken?: string;

  @ApiPropertyOptional({
    description: 'Enable graphify feature for this project',
    example: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean({ message: '$t(common.validation.isBoolean)' })
  graphifyEnabled?: boolean;
}
