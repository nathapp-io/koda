import { ApiPropertyOptional } from '@nestjs/swagger';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

/** The longest token a rotation may carry (a GitLab personal access token). */
const TOKEN_MAX_LENGTH = 512;

/**
 * A token is validated when the body carries it and skipped when it does not. `@IsOptional` is
 * deliberately not used: it also waves `null` through, and a null token is a malformed token, not an
 * absent one — every consumer would read it as a supplied value and hand it to the forge (fix round
 * 1, F1). Only `undefined` means "leave this token alone".
 */
const whenGiven = (_body: unknown, value: unknown): boolean => value !== undefined;

/**
 * US-005: the body of `PATCH /fleet/repos/:id/gitlab-credentials` — the rotation of a repo's stored
 * GitLab tokens.
 *
 * Either token may be absent: a partial rotation replaces the token it names and keeps the other
 * one. A body that names neither has nothing to rotate, and that is the one rule the DTO cannot
 * state itself — a field's rules say what a value must look like, never that one of two fields must
 * be there, and class-validator's `@ValidateIf`/`@IsOptional` group with the rest of the field's
 * decorators, so a cross-field rule attached to a token field would be skipped whenever that field
 * is absent. So the rule is a pure function every entry point calls (`assertRotationGiven`): the
 * route calls it before the approval gate opens a request, and the service calls it again when the
 * approved write runs.
 *
 * The tokens are deliberately not trimmed or normalised here: a token is opaque, and the DTO is not
 * the place that decides what GitLab accepts.
 */
export class UpdateGitlabCredentialsDto {
  @ApiPropertyOptional({ description: 'The new GitLab read token; stored encrypted and never returned' })
  @ValidateIf(whenGiven)
  @IsString({ message: 'common.validation.isString' })
  @MinLength(1, { message: 'common.validation.minLength|{"min":1}' })
  @MaxLength(TOKEN_MAX_LENGTH, { message: 'common.validation.maxLength|{"max":512}' })
  declare readToken?: string;

  @ApiPropertyOptional({ description: 'The new GitLab write token; stored encrypted and never returned' })
  @ValidateIf(whenGiven)
  @IsString({ message: 'common.validation.isString' })
  @MinLength(1, { message: 'common.validation.minLength|{"min":1}' })
  @MaxLength(TOKEN_MAX_LENGTH, { message: 'common.validation.maxLength|{"max":512}' })
  declare writeToken?: string;

  /**
   * The admin's confirmation that the new write token belongs to a bot account. A write token that
   * belongs to a person is allowed with a warning, so this only turns the warning off.
   */
  @ApiPropertyOptional({ description: 'Confirm the new write token belongs to a bot account' })
  @IsOptional()
  @IsBoolean({ message: 'common.validation.isBoolean' })
  declare confirmBotAccount?: boolean;
}

/**
 * US-005: a rotation has to name at least one token. The refusal is the route's own 400 and its i18n
 * key, so the API never hardcodes the prose.
 */
export function assertRotationGiven(patch: UpdateGitlabCredentialsDto): void {
  if (patch.readToken === undefined && patch.writeToken === undefined) {
    throw new ValidationAppException({}, 'fleet.repoGitlabCredentialsEmpty');
  }
}
