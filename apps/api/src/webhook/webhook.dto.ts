import { IsUrl, IsString, IsArray, IsBoolean, IsOptional, MinLength } from 'class-validator';

export class CreateWebhookDto {
  @IsUrl()
  url: string;

  @IsOptional()
  @IsString()
  @MinLength(32, { message: '$t(common.validation.webhookSecretMinLength)' })
  secret?: string;

  @IsArray()
  @IsString({ each: true })
  events: string[];
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsUrl()
  url?: string;

  @IsOptional()
  @IsString()
  @MinLength(32, { message: '$t(common.validation.webhookSecretMinLength)' })
  secret?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
