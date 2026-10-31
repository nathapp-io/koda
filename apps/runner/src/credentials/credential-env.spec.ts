import { describe, expect, test } from 'bun:test';
import { withoutCredentialVars } from './credential-env';

describe('withoutCredentialVars', () => {
  test('US-004 AC-1: strips all ambient NAX forge identity variables', () => {
    const result = withoutCredentialVars({ KEEP: 'yes', NAX_FORGE_TOKEN: 't', NAX_FORGE_TOKEN_FILE: '/token', NAX_FORGE_LOGIN: 'login', NAX_FORGE_USER_ID: '42' });
    expect(result).toEqual({ KEEP: 'yes' });
  });
});
