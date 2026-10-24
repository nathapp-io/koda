import { afterEach, describe, expect, it, vi } from 'vitest';
import globalSetup from '../../global-setup';

afterEach(() => vi.unstubAllEnvs());

describe('sandboxed DB setup', () => {
  it('does not provision or reset Postgres even when DB tests are requested', async () => {
    vi.stubEnv('NAX_SANDBOXED', '1');
    vi.stubEnv('KODA_DB_TESTS', '1');
    // An unsafe explicit URL fails before a schema reset if setup reaches provisioning.
    vi.stubEnv('KODA_TEST_DATABASE_URL', 'postgresql://user:pass@localhost:5433/development');
    await expect(globalSetup()).resolves.toBeUndefined();
  });
});
