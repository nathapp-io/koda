import { gitIdentityFor } from './assign-payload';
import type { IFleetConfig } from '../../config/fleet.config';

describe('gitIdentityFor', () => {
  const cfg = { githubAppSlug: 'koda-fleet', gitlabBotName: 'fallback', gitlabBotEmail: 'bot@example.com' } as Pick<IFleetConfig, 'githubAppSlug' | 'gitlabBotName' | 'gitlabBotEmail'>;

  it('US-003 AC-6: uses the credential write username for GitLab', () => {
    expect(gitIdentityFor({ provider: 'gitlab', gitlabWriteUser: { id: 77, username: 'koda-bot' } }, cfg))
      .toEqual({ name: 'koda-bot', email: cfg.gitlabBotEmail });
  });

  it('US-003 AC-7: falls back when GitLab has no credential user', () => {
    expect(gitIdentityFor({ provider: 'gitlab', gitlabWriteUser: null }, cfg))
      .toEqual({ name: cfg.gitlabBotName, email: cfg.gitlabBotEmail });
  });

  it('US-003 AC-8: preserves GitHub App identity', () => {
    expect(gitIdentityFor({ provider: 'github', gitlabWriteUser: null }, cfg))
      .toEqual({ name: 'koda-fleet[bot]', email: 'koda-fleet[bot]@users.noreply.github.com' });
  });
});
