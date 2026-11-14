import { describe, expect, test } from 'bun:test';
import { withoutCredentialVars } from './credential-env';

describe('withoutCredentialVars', () => {
  test('US-008 AC-7: strips all ambient forge credential and identity variables', () => {
    const result = withoutCredentialVars({
      KEEP: 'yes',
      GH_TOKEN: 'gh',
      GH_ENTERPRISE_TOKEN: 'ghe',
      GITHUB_TOKEN: 'github',
      GITLAB_TOKEN: 'gitlab',
      GL_TOKEN: 'gl',
      NAX_FORGE_TOKEN: 't',
      NAX_FORGE_TOKEN_FILE: '/token',
      NAX_FORGE_IDENTITY: 'login-only',
      NAX_FORGE_LOGIN: 'login',
      NAX_FORGE_USER_ID: '42',
      KODA_PROVIDER_CRED_SOCKET: '/tmp/sock',
    });
    expect(result).toEqual({ KEEP: 'yes' });
  });
});
