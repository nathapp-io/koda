import { IsString, IsArray, IsBoolean, IsOptional, MinLength, MaxLength } from 'class-validator';

/** URL semantics (scheme, credentials, resolved destination) belong to `OutboundUrlGuard`. */
const MAX_URL_LENGTH = 2048;

export class CreateWebhookDto {
  @IsString()
  @MaxLength(MAX_URL_LENGTH)
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
  @IsString()
  @MaxLength(MAX_URL_LENGTH)
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
