import { describe, expect, test } from 'bun:test';
import { FakeNaxCli, naxError } from '../../test/helpers/fake-nax-cli';
import { StartupError } from '../errors';
import { WorkspaceUntrustedError, assertWorkspaceTrusted, checkTrust } from './trust';

describe('checkTrust (D103)', () => {
  test("asks nax about the folder, from the folder, and follows nax's verdict", async () => {
    const nax = new FakeNaxCli();
    expect(await checkTrust(nax, '/w/acme/app')).toEqual({ trusted: true });
    expect(nax.calls).toEqual([{ args: ['trust', 'check', '--json', '/w/acme/app'], cwd: '/w/acme/app' }]);
    nax.answers = { trusted: false };
    expect(await checkTrust(nax, '/w/acme/app')).toEqual({ trusted: false, reason: 'project untrusted' });
  });
  test('a failed check is never trusted', async () => {
    expect(await checkTrust(new FakeNaxCli({ trusted: naxError('TRUST_STORE_UNREADABLE') }), '/w')).toEqual({ trusted: false, reason: 'trust check failed: TRUST_STORE_UNREADABLE' });
  });
});

describe('assertWorkspaceTrusted (D103)', () => {
  test('passes for a trusted workspace root', async () => {
    await assertWorkspaceTrusted(new FakeNaxCli(), { workspaceRoot: '/srv/ws', naxHome: '/home/k/.nax' });
  });
  test('Review focus 4: an untrusted root is a StartupError naming the exact command, with the nax home', async () => {
    const failure = assertWorkspaceTrusted(new FakeNaxCli({ trusted: false }), { workspaceRoot: '/srv/ws', naxHome: '/home/k/.nax' });
    await expect(failure).rejects.toBeInstanceOf(WorkspaceUntrustedError);
    await expect(failure).rejects.toBeInstanceOf(StartupError);
    await expect(failure).rejects.toThrow('NAX_GLOBAL_CONFIG_DIR=/home/k/.nax nax trust add /srv/ws --yes');
  });
});
