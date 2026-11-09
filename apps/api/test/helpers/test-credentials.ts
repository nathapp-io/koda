import * as bcrypt from 'bcrypt';

/** The password every fixture user shares. Real login still verifies it. */
export const TEST_PASSWORD = 'Admin1234!Aa';

/**
 * One real bcrypt hash at the cost the repo already uses for test users (4).
 * Fixture inserts reuse it instead of paying cost-12 hashing per user; production
 * hashing stays at 12.
 */
export const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);
