import { describe, expect, test } from 'bun:test';
import type { StaticCapabilities } from '../config/runner-config';
import { FakeNaxCli } from '../../test/helpers/fake-nax-cli';
import type { AcpAgentProbe } from './acp-agent-probe';
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
  test('US-002: an injected ACP probe reaches the nax probe and fills threadBackends.acp', async () => {
    const nax = new FakeNaxCli();
    const acpProbe: AcpAgentProbe = async () => [{ agent: 'claude', launchable: true, loggedIn: true, models: ['claude-sonnet-4-5'], efforts: ['high'] }];
    const { capabilities } = await createCapabilityProbe({ capabilities: null, naxCommand: ['nax'], naxHome: '/nonexistent-nax-home' }, now, nax, acpProbe).probe();
    expect(capabilities.threadBackends).toEqual({
      native: [], acp: ['claude'],
      acpOffers: [{ agent: 'claude', launchable: true, loggedIn: true, models: ['claude-sonnet-4-5'], efforts: ['high'] }],
    });
  });
  test('US-002: the operator\'s capabilities block still wins; ACP agents are not probed', async () => {
    let probed = 0;
    const acpProbe: AcpAgentProbe = async () => {
      probed += 1;
      return [{ agent: 'claude', launchable: true, loggedIn: true, models: [], efforts: [] }];
    };
    const { capabilities } = await createCapabilityProbe({ capabilities: STATIC, naxCommand: ['nax'], naxHome: '/nh' }, now, new FakeNaxCli(), acpProbe).probe();
    expect(probed).toBe(0);
    expect(capabilities.threadBackends).toBeUndefined();
  });
  test('US-010: a vaultHelper reaches the nax probe, and the operator\'s capabilities block still wins over it', async () => {
    let asked = 0;
    const vaultHelper = async (): Promise<boolean> => {
      asked += 1;
      return true;
    };
    const probed = await createCapabilityProbe({ capabilities: null, naxCommand: ['nax'], naxHome: '/nonexistent-nax-home' }, now, new FakeNaxCli(), undefined, vaultHelper).probe();
    expect(probed.capabilities.providerVault).toBe(true);
    expect(asked).toBe(1);
    const staticProbe = await createCapabilityProbe({ capabilities: STATIC, naxCommand: ['nax'], naxHome: '/nh' }, now, new FakeNaxCli(), undefined, vaultHelper).probe();
    expect('providerVault' in staticProbe.capabilities).toBe(false);
    expect(asked).toBe(1);   // the static probe never checks, so it never claims a vault
  });
});
