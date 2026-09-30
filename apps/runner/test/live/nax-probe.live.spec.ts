import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapabilityProbe } from '../../src/capabilities/create-probe';
import { MIN_NAX_VERSION, createNaxCli, parseNaxVersion, versionAtLeast } from '../../src/nax/nax-cli';
import { checkTrust } from '../../src/nax/trust';
import { systemNow } from '../../src/time';

/**
 * D107, slice 3 design §4 "3b merge gate": the probe against the installed, released nax, read-only (no nax run,
 * no nax plan, no trust add). Run it on each runner machine: `KODA_NAX_LIVE=1 bun run test:live`. Never in CI.
 */
const enabled = process.env['KODA_NAX_LIVE'] === '1';
// A dynamic import keeps the API's source out of the runner's type-check; bun resolves its dependencies at run time.
const API_VALIDATOR = join(import.meta.dir, '..', '..', '..', 'api', 'src', 'fleet', 'common', 'capabilities.ts');

describe.skipIf(!enabled)('merge gate: NaxCapabilityProbe against the installed nax (D107)', () => {
  const naxHome = process.env['NAX_GLOBAL_CONFIG_DIR'] ?? join(homedir(), '.nax');
  const nax = createNaxCli(['nax'], naxHome);

  test('the report from the real nax meets the version floor and passes the server validator', async () => {
    const { capabilities, warnings } = await createCapabilityProbe({ capabilities: null, naxCommand: ['nax'], naxHome }, systemNow, nax).probe();
    const version = parseNaxVersion(capabilities.nax.version);
    expect(version).not.toBeNull();
    expect(versionAtLeast(version as [number, number, number], MIN_NAX_VERSION)).toBe(true);
    const api = (await import(API_VALIDATOR)) as { parseCapabilities(raw: unknown): unknown };
    expect(() => api.parseCapabilities(capabilities)).not.toThrow();
    const summary = {
      nax: capabilities.nax, sandbox: capabilities.sandbox, profiles: Object.keys(capabilities.profiles).length,
      credentials: capabilities.credentials.map((c) => `${c.providerId}:${c.available ? 'available' : 'unavailable'}`), tools: capabilities.tools, warnings,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }, 120_000);

  test('trust check: a folder nax has never seen is untrusted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'koda-runner-live-'));
    try {
      expect(await checkTrust(nax, dir)).toEqual({ trusted: false, reason: 'project untrusted' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
