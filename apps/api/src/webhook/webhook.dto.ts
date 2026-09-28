import {
  IsString,
  IsArray,
  IsBoolean,
  IsOptional,
  MinLength,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** URL semantics (scheme, credentials, resolved destination) belong to `OutboundUrlGuard`. */
const MAX_URL_LENGTH = 2048;

/**
 * Skips a field only when it is truly absent.
 *
 * `@IsOptional()` skips `null` as well, so an explicit `{"events": null}` reached the
 * service and was persisted as the string `"null"`, and `secret`/`active` reached
 * Prisma's required columns as a 500. With this predicate the field validators still
 * run for `null`, so an explicit null is a 400 like any other invalid value.
 */
const whenProvided = (_object: unknown, value: unknown): boolean => value !== undefined;

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
  @ValidateIf(whenProvided)
  @IsString()
  @MaxLength(MAX_URL_LENGTH)
  url?: string;

  @ValidateIf(whenProvided)
  @IsString()
  @MinLength(32, { message: '$t(common.validation.webhookSecretMinLength)' })
  secret?: string;

  @ValidateIf(whenProvided)
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @ValidateIf(whenProvided)
  @IsBoolean()
  active?: boolean;
}
