import { encryptToken } from '../../common/utils/encryption.util';
import { GitLabTokenSource } from './gitlab-token.source';
import { RepoCheckException } from './repo-check.exception';

const KEY = 'a'.repeat(64);

describe('GitLabTokenSource', () => {
  const vcsRepo = { findVcsConnectionByProjectId: jest.fn() };
  const make = (encryptionKey: string | undefined = KEY) => new GitLabTokenSource(vcsRepo as never, { encryptionKey } as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('decrypts the connected project token', async () => {
    vcsRepo.findVcsConnectionByProjectId.mockResolvedValue({ provider: 'gitlab', repoOwner: 'Group', repoName: 'App', encryptedToken: encryptToken('glpat-1', KEY) });
    await expect(make().resolve('p1', 'group', 'app')).resolves.toBe('glpat-1');
    expect(vcsRepo.findVcsConnectionByProjectId).toHaveBeenCalledWith('p1');
  });

  it.each([
    ['no connection', null, 'vcs_connection_missing'],
    ['a GitHub connection', { provider: 'github', repoOwner: 'group', repoName: 'app', encryptedToken: 'x' }, 'vcs_connection_mismatch'],
    ['another repo', { provider: 'gitlab', repoOwner: 'group', repoName: 'other', encryptedToken: 'x' }, 'vcs_connection_mismatch'],
  ])('rejects resolution with %s', async (_label, connection, reason) => {
    vcsRepo.findVcsConnectionByProjectId.mockResolvedValue(connection);
    await expect(make().resolve('p1', 'group', 'app')).rejects.toMatchObject({ reason: reason });
  });

  it('rejects resolution without VCS_ENCRYPTION_KEY', async () => {
    vcsRepo.findVcsConnectionByProjectId.mockResolvedValue({ provider: 'gitlab', repoOwner: 'group', repoName: 'app', encryptedToken: 'x' });
    // NB: `make(undefined)` would hit the `= KEY` default and test the wrong path;
    // an empty key is falsy and exercises the vcs_encryption_key_missing branch.
    await expect(make('').resolve('p1', 'group', 'app')).rejects.toMatchObject({ reason: 'vcs_encryption_key_missing' });
  });

  it('rejects undecryptable token ciphertext as gitlab_token_invalid', async () => {
    // Matching connection, key present, but the ciphertext is garbage (e.g. key
    // rotation without re-encryption): the crypto error must surface as the fixed
    // 422 reason, never as a 500 echoing library detail.
    vcsRepo.findVcsConnectionByProjectId.mockResolvedValue({ provider: 'gitlab', repoOwner: 'group', repoName: 'app', encryptedToken: 'not-a-valid-ciphertext' });
    await expect(make().resolve('p1', 'group', 'app')).rejects.toBeInstanceOf(RepoCheckException);
    await expect(make().resolve('p1', 'group', 'app')).rejects.toMatchObject({ reason: 'gitlab_token_invalid' });
  });
});
