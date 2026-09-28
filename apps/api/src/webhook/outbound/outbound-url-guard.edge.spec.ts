/**
 * Adversarial-review regressions for US-002 `OutboundUrlGuard`.
 *
 * Each case pins a defect the review found in the first implementation:
 * 1. a CIDR allowlist entry that covers a *public* range is an allowlist entry too
 *    (step 5), so it relaxes `https_required` like a private one does;
 * 2. an empty connect-time DNS answer fails the lookup instead of succeeding with no
 *    addresses at all (which `checkUrl` already reports as `unresolvable`);
 * 3. the lookup always calls back exactly once, even when its own plumbing throws
 *    before the resolver is reached;
 * 4. a URL whose normalised host is empty (`https://./hook`) is `invalid_url`, not a
 *    destination that "failed to resolve".
 */
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { IWebhookConfig } from '../../config/webhook.config';
import { DnsResolver } from './dns-resolver';
import { OutboundUrlGuard, OutboundUrlRejection } from './outbound-url-guard';

const PUBLIC_IPV4 = '93.184.215.14';

type ResolveMock = jest.Mock<Promise<string[]>, [string]>;

interface GuardHarness {
  guard: OutboundUrlGuard;
  resolve: ResolveMock;
}

const EMPTY_ALLOWLISTS: IWebhookConfig = {
  allowedHostnames: [],
  allowedCidrs: [],
  deliveryTimeoutMs: 5000,
};

function makeGuard(
  config: Partial<IWebhookConfig> = {},
  addresses: readonly string[] = [PUBLIC_IPV4],
): GuardHarness {
  const resolve = jest.fn<Promise<string[]>, [string]>(
    (): Promise<string[]> => Promise.resolve([...addresses]),
  );
  const guard = new OutboundUrlGuard({ ...EMPTY_ALLOWLISTS, ...config }, { resolve });
  return { guard, resolve };
}

interface LookupResult {
  calls: number;
  error: NodeJS.ErrnoException | null;
  addresses: string | LookupAddress[] | undefined;
}

/** Invokes a `net.LookupFunction` the way `node:http(s)` does (`options.all: true`). */
function invokeLookup(lookup: LookupFunction, hostname: string): Promise<LookupResult> {
  return new Promise<LookupResult>((fulfil) => {
    let calls = 0;
    let result: Omit<LookupResult, 'calls'> = { error: null, addresses: undefined };

    lookup(hostname, { all: true }, (error, addresses) => {
      calls += 1;
      result = { error, addresses };
      setImmediate(() => fulfil({ ...result, calls }));
    });
  });
}

function rejectionReason(check: Promise<void>): Promise<string> {
  return check.then(
    () => {
      throw new Error('expected checkUrl to reject');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(OutboundUrlRejection);
      return (error as OutboundUrlRejection).reason;
    },
  );
}

describe('US-002 review: an operator CIDR allowlist also covers public ranges', () => {
  it('accepts plain HTTP to a public IP literal inside an allowedCidrs entry, without DNS', async () => {
    const { guard, resolve } = makeGuard({ allowedCidrs: ['93.184.215.0/24'] });

    await expect(guard.checkUrl(`http://${PUBLIC_IPV4}/hook`)).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('still requires HTTPS for a public IP literal outside the allow-listed subnet', async () => {
    const { guard, resolve } = makeGuard({ allowedCidrs: ['93.184.215.0/25'] });

    expect(await rejectionReason(guard.checkUrl('http://93.184.215.200/hook'))).toBe('https_required');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not treat a private address outside the allow-listed subnet as allow-listed', async () => {
    const { guard, resolve } = makeGuard({ allowedCidrs: ['93.184.215.0/24'] });

    expect(await rejectionReason(guard.checkUrl('https://10.0.0.5/hook'))).toBe(
      'blocked_destination',
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('covers IPv6 entries too: an http ULA literal inside fd00::/8 is allow-listed', async () => {
    const { guard, resolve } = makeGuard({ allowedCidrs: ['fd00::/8'] });

    await expect(guard.checkUrl('http://[fd00::1]/hook')).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('US-002 review: an empty connect-time answer fails the lookup', () => {
  it('calls back once with an ENOTFOUND error instead of a success carrying no address', async () => {
    const { guard, resolve } = makeGuard({}, []);

    const result = await invokeLookup(guard.createLookup(), 'hooks.example');

    expect(result.calls).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.code).toBe('ENOTFOUND');
    expect(result.addresses).toBeUndefined();
    expect(resolve).toHaveBeenCalledWith('hooks.example');
  });
});

describe('US-002 review: the lookup always answers its callback exactly once', () => {
  it('reports an error when the hostname cannot be normalised, instead of never calling back', async () => {
    const { guard, resolve } = makeGuard();

    const lookup = guard.createLookup();
    const result = await new Promise<LookupResult>((fulfil) => {
      let calls = 0;
      let observed: Omit<LookupResult, 'calls'> = { error: null, addresses: undefined };

      lookup(undefined as unknown as string, { all: true }, (error, addresses) => {
        calls += 1;
        observed = { error, addresses };
        setImmediate(() => fulfil({ ...observed, calls }));
      });
    });

    expect(result.calls).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('US-002 review: a URL with no host is invalid_url', () => {
  it('rejects "https://./hook", whose normalised host is empty, without resolving', async () => {
    const { guard, resolve } = makeGuard();

    expect(await rejectionReason(guard.checkUrl('https://./hook'))).toBe('invalid_url');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses the same destination in assertStaticTarget', () => {
    const { guard } = makeGuard();

    expect(() => guard.assertStaticTarget(new URL('https://./hook'))).toThrow(OutboundUrlRejection);
  });
});
