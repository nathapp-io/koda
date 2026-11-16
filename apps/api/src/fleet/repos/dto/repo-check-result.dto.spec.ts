import { REASONS } from './repo-check-result.dto';

/**
 * US-002 (GitLab parity F1): the reasons a repo check can answer.
 *
 * The list is the wire contract of the check endpoint, so every reason the fleet can refuse with
 * has to be in it — the new GitLab host and token reasons as well as the two legacy VCS connection
 * reasons, which stay until the fleet stops throwing them (US-006).
 */
describe('RepoCheckResultDto reasons', () => {
  it('US-002: answers the new GitLab host and token reasons', () => {
    for (const reason of [
      'gitlab_credentials_missing',
      'gitlab_host_invalid',
      'gitlab_host_blocked',
      'gitlab_host_unclassified',
      'gitlab_read_token_writable',
      'gitlab_read_token_no_access',
      'gitlab_project_mismatch',
    ]) {
      expect(REASONS).toContain(reason);
    }
  });

  it('US-002: keeps the legacy VCS connection reasons', () => {
    expect(REASONS).toContain('vcs_connection_missing');
    expect(REASONS).toContain('vcs_connection_mismatch');
  });

  it('has no duplicate reason', () => {
    expect(new Set(REASONS).size).toBe(REASONS.length);
  });
});
