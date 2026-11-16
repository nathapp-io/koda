import { AppException } from '@nathapp/nestjs-common';

export type RepoCheckReason =
  | 'github_app_not_configured'
  | 'github_app_key_unreadable'
  | 'app_not_installed'
  | 'app_permissions_insufficient'
  | 'repo_not_found'
  | 'provider_unreachable'
  | 'provider_error'
  | 'default_branch_unprotected'
  | 'vcs_connection_missing'
  | 'vcs_connection_mismatch'
  | 'vcs_encryption_key_missing'
  | 'gitlab_token_invalid'
  | 'gitlab_credentials_missing'
  | 'gitlab_access_insufficient'
  | 'gitlab_scope_missing'
  // US-002 (GitLab parity F1): the host rule and the two token kinds of a repo.
  | 'gitlab_host_invalid'
  | 'gitlab_host_blocked'
  | 'gitlab_host_unclassified'
  | 'gitlab_read_token_writable'
  | 'gitlab_read_token_no_access'
  | 'gitlab_project_mismatch';

/** 422: the forge refused or could not confirm runner git access (spec §7.1). */
export class RepoCheckException extends AppException {
  constructor(readonly reason: RepoCheckReason) {
    super(422, { reason }, 'fleet.repoCheck', 422);
  }
}
