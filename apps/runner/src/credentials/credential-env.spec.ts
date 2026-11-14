import { describe, expect, test } from 'bun:test';
import { withoutCredentialVars } from './credential-env';

describe('withoutCredentialVars', () => {
  test('US-008 AC-7: strips ambient NAX_FORGE_IDENTITY but preserves unrelated variables', () => {
    expect(withoutCredentialVars({ NAX_FORGE_IDENTITY: 'login-only', HOME: '/h' })).toEqual({ HOME: '/h' });
  });
});
