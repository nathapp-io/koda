import { describe, expect, test } from 'bun:test';
import type { StaticCapabilities } from '../config/runner-config';
import { FakeNaxCli } from '../../test/helpers/fake-nax-cli';
import { createCapabilityProbe } from './create-probe';

const STATIC: StaticCapabilities = {
  nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true }, profiles: {}, credentials: [],
  tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
const now = () => new Date('2026-10-01T00:00:00.000Z');

describe('createCapabilityProbe (D95)', () => {
  test('a capabilities block in runner.json is used as is; nax is never asked', async () => {
    const nax = new FakeNaxCli();
    const { capabilities } = await createCapabilityProbe({ capabilities: STATIC, naxCommand: ['nax'], naxHome: '/nh' }, now, nax).probe();
    expect(capabilities.nax.version).toBe('0.83.0');
    expect(nax.calls).toEqual([]);
  });
  test('without one, nax is probed', async () => {
    const nax = new FakeNaxCli({ version: '0.84.0' });
    const { capabilities } = await createCapabilityProbe({ capabilities: null, naxCommand: ['nax'], naxHome: '/nonexistent-nax-home' }, now, nax).probe();
    expect(capabilities.nax.version).toBe('0.84.0');
    expect(nax.calls[0]?.args).toEqual(['--version']);
  });
});
