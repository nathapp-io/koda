import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

/**
 * US-004: the i18n key of the refusal a GitHub body carrying GitLab-only fields gets. The key is
 * the message itself (the validation filter translates it), so the API never hardcodes the prose.
 */
export const GITLAB_FIELDS_ON_GITHUB = 'fleet.repoGitlabFieldsOnGitHub';

/** The longest host a GitLab repo may name. */
const HOST_MAX_LENGTH = 2048;
/** The longest token a body may carry (a GitLab personal access token). */
const TOKEN_MAX_LENGTH = 512;

/**
 * US-004: the GitLab-only fields of a create body are GitLab-only. A GitHub body that carries one
 * of them is refused (400 `fleet.repoGitlabFieldsOnGitHub`) instead of silently dropping what the
 * caller sent — a dropped token is a token the admin believes is stored and is not.
 *
 * The rule sits on the provider, so the refusal names the body that is wrong rather than the field
 * that happens to be the first one that carries a value.
 */
@ValidatorConstraint({ name: 'gitlabFieldsOnGitHub', async: false })
class GitLabFieldsOnGitHubConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const body = args.object as CreateFleetRepoDto;
    if (body?.provider !== 'github') return true;
    return body.host === undefined
      && body.readToken === undefined
      && body.writeToken === undefined
      && body.confirmBotAccount === undefined;
  }

  defaultMessage(): string {
    return GITLAB_FIELDS_ON_GITHUB;
  }
}

export class CreateFleetRepoDto {
  @ApiProperty() @IsString() @MaxLength(100) declare projectSlug: string;
  @ApiProperty({ enum: ['github', 'gitlab'] })
  @IsIn(['github', 'gitlab'])
  @Validate(GitLabFieldsOnGitHubConstraint)
  declare provider: 'github' | 'gitlab';
  @ApiProperty({ description: 'Owner or namespace (GitLab: group/subgroup)' })
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/) declare owner: string;
  @ApiProperty() @Matches(/^[A-Za-z0-9._-]{1,100}$/) declare name: string;

  /**
   * US-004: the GitLab host the repo lives on. Absent means gitlab.com. The host is checked before
   * any request leaves the process, so a body can never make koda talk to an address the admin did
   * not mean.
   */
  @ApiPropertyOptional({ description: 'The GitLab host the repo lives on; gitlab.com when absent' })
  @IsOptional() @IsString({ message: 'common.validation.isString' })
  @MaxLength(HOST_MAX_LENGTH, { message: 'common.validation.maxLength|{"max":2048}' })
  declare host?: string;

  /** The read token: it reads the repo and never writes. Required for a GitLab repo. */
  @ApiPropertyOptional({ description: 'The GitLab read token; stored encrypted and never returned' })
  @ValidateIf((body: CreateFleetRepoDto) => body.provider === 'gitlab')
  @MaxLength(TOKEN_MAX_LENGTH, { message: 'common.validation.maxLength|{"max":512}' })
  @MinLength(1, { message: 'common.validation.minLength|{"min":1}' })
  @IsString({ message: 'common.validation.isString' })
  @IsDefined({ message: 'common.validation.required' })
  declare readToken?: string;

  /** The write token: it pushes to the repo. Required for a GitLab repo. */
  @ApiPropertyOptional({ description: 'The GitLab write token; stored encrypted and never returned' })
  @ValidateIf((body: CreateFleetRepoDto) => body.provider === 'gitlab')
  @MaxLength(TOKEN_MAX_LENGTH, { message: 'common.validation.maxLength|{"max":512}' })
  @MinLength(1, { message: 'common.validation.minLength|{"min":1}' })
  @IsString({ message: 'common.validation.isString' })
  @IsDefined({ message: 'common.validation.required' })
  declare writeToken?: string;

  /**
   * The admin's confirmation that the write token belongs to a bot account. A write token that
   * belongs to a person is allowed with a warning, so this only turns the warning off.
   */
  @ApiPropertyOptional({ description: 'Confirm the write token belongs to a bot account' })
  @ValidateIf((body: CreateFleetRepoDto) => body.provider === 'gitlab')
  @IsBoolean({ message: 'common.validation.isBoolean' })
  @IsOptional()
  declare confirmBotAccount?: boolean;
}
