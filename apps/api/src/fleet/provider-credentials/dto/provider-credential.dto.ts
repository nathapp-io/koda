import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { KodaPageQuery } from '../../../common/dto/koda-page.query';
import {
  PROVIDER_CREDENTIAL_KEY_MAX_LENGTH,
  PROVIDER_CREDENTIAL_KEY_MIN_LENGTH,
  PROVIDER_CREDENTIAL_NAME_MAX_LENGTH,
  PROVIDER_ID_PATTERN,
  NO_WHITESPACE_PATTERN,
  type ProviderCredential,
  type ProviderCredentialScope,
} from '../provider-credential.domain';

/**
 * A management write body (spec §"US-003"). The scope is the route's, never the body's: this DTO is
 * the GLOBAL create, and a project route (US-005) adds its own `repoId` variant.
 */
export class CreateProviderCredentialDto {
  @ApiProperty({ description: 'Provider id, lowercase (for example `openrouter`)' })
  @Matches(PROVIDER_ID_PATTERN)
  declare providerId: string;

  @ApiProperty({ description: 'Display name, 1-64 characters' })
  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_CREDENTIAL_NAME_MAX_LENGTH)
  declare name: string;

  @ApiProperty({ description: 'The provider API key; stored encrypted and never returned' })
  @IsString()
  @MinLength(PROVIDER_CREDENTIAL_KEY_MIN_LENGTH)
  @MaxLength(PROVIDER_CREDENTIAL_KEY_MAX_LENGTH)
  @Matches(NO_WHITESPACE_PATTERN)
  declare key: string;
}

/**
 * One row of a management list: metadata only. Neither the key nor its ciphertext is a property here,
 * which is what makes "write-only after save" a shape rather than a promise.
 */
export class ProviderCredentialDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ enum: ['GLOBAL', 'PROJECT', 'REPO'] }) declare scope: ProviderCredentialScope;
  @ApiPropertyOptional({ type: String, nullable: true }) declare projectId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare repoId: string | null;
  @ApiProperty() declare providerId: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ description: 'Last four characters of the key, for display only' }) declare last4: string;
  @ApiProperty({ description: '12 hex characters: a stable, non-reversible identifier of the key' })
  declare fingerprint: string;
  @ApiProperty() declare disabled: boolean;
  @ApiProperty() declare createdBy: string;
  @ApiProperty({ description: 'ISO 8601' }) declare updatedAt: string;

  static from(row: ProviderCredential): ProviderCredentialDto {
    return Object.assign(new ProviderCredentialDto(), {
      id: row.id,
      scope: row.scope,
      projectId: row.projectId,
      repoId: row.repoId,
      providerId: row.providerId,
      name: row.name,
      last4: row.last4,
      fingerprint: row.fingerprint,
      disabled: row.disabledAt !== null,
      createdBy: row.createdById,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
}

/** The list query: the shared 1-based page (a management list is a bounded read). */
export class ListProviderCredentialsQuery extends KodaPageQuery {}
