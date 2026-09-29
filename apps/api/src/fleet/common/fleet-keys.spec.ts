import { createHmac } from 'crypto';
import { ENROLLMENT_TOKEN_PREFIX, generateEnrollmentToken, generateRunnerKey, hashSecret } from './fleet-keys';
import { RUNNER_KEY_PREFIX } from '../../auth/guards/runner-route.decorator';

describe('fleet keys', () => {
  it('generates a kr_ key of 64 hex chars and its HMAC hash', () => {
    const { raw, hash } = generateRunnerKey('s3cret');
    expect(raw).toMatch(new RegExp(`^${RUNNER_KEY_PREFIX}[0-9a-f]{64}$`));
    expect(hash).toBe(createHmac('sha256', 's3cret').update(raw).digest('hex'));
  });

  it('generates a ke_ enrollment token distinct from runner keys', () => {
    const a = generateEnrollmentToken('s3cret');
    const b = generateEnrollmentToken('s3cret');
    expect(a.raw.startsWith(ENROLLMENT_TOKEN_PREFIX)).toBe(true);
    expect(a.raw).not.toBe(b.raw);
    expect(hashSecret('s3cret', a.raw)).toBe(a.hash);
  });

  it('refuses to generate without a secret', () => {
    expect(() => generateRunnerKey('')).toThrow('API_KEY_SECRET is not configured');
  });
});
