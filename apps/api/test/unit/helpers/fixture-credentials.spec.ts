import * as bcrypt from 'bcrypt';
import { TEST_PASSWORD, TEST_PASSWORD_HASH } from '../../helpers/test-credentials';

describe('fixture credentials', () => {
  it('hashes the fixture password at test cost', async () => {
    expect(bcrypt.getRounds(TEST_PASSWORD_HASH)).toBe(4);
    await expect(bcrypt.compare(TEST_PASSWORD, TEST_PASSWORD_HASH)).resolves.toBe(true);
    await expect(bcrypt.compare('not-the-password', TEST_PASSWORD_HASH)).resolves.toBe(false);
  });
});
