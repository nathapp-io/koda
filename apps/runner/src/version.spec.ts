import { describe, expect, test } from 'bun:test';
import pkg from '../package.json' with { type: 'json' };
import { DAEMON_VERSION } from './version';

describe('DAEMON_VERSION', () => {
  test('is the package version, a plain semver', () => {
    expect(DAEMON_VERSION).toBe(pkg.version);
    expect(DAEMON_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
