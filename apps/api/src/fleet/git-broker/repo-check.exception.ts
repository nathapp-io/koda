import { AppException } from '@nathapp/nestjs-common';

export type RepoCheckReason =
  | 'github_app_not_configured'
  | 'app_not_installed'
  | 'app_permissions_insufficient'
  | 'repo_not_found'
  | 'provider_unreachable'
  | 'provider_error'
  | 'vcs_connection_missing'
  | 'vcs_connection_mismatch'
  | 'vcs_encryption_key_missing'
  | 'gitlab_token_invalid'
  | 'gitlab_access_insufficient'
  | 'gitlab_scope_missing';

/** 422: the forge refused or could not confirm runner git access (spec §7.1). */
export class RepoCheckException extends AppException {
  constructor(readonly reason: RepoCheckReason) {
    super(422, { reason }, 'fleet.repoCheck', 422);
  }
}
