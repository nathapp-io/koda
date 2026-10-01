import { ApiProperty } from '@nestjs/swagger';
import type { RepoCheckReason } from '../../git-broker/repo-check.exception';

const REASONS: RepoCheckReason[] = [
  'github_app_not_configured', 'github_app_key_unreadable', 'app_not_installed', 'app_permissions_insufficient',
  'repo_not_found', 'provider_unreachable', 'provider_error', 'vcs_connection_missing', 'vcs_connection_mismatch',
  'vcs_encryption_key_missing', 'gitlab_token_invalid', 'gitlab_access_insufficient', 'gitlab_scope_missing',
];

/** Result of re-running the registration forge check (overview D119); a failure is data, not an error. */
export class RepoCheckResultDto {
  @ApiProperty() declare repoId: string;
  @ApiProperty() declare reachable: boolean;
  @ApiProperty({ enum: REASONS, nullable: true }) declare reason: RepoCheckReason | null;
  @ApiProperty() declare checkedAt: string;
}
