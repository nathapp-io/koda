/**
 * US-002 AC1–AC15: `OutboundUrlGuard` — webhook destination syntax, credentials and
 * resolved destinations.
 *
 * `checkUrl` is one ordered pipeline (invalid_url → scheme_not_allowed →
 * credentials_not_allowed → https_required → allowlist → IP-literal classification →
 * DNS resolution → resolved-address classification) and `createLookup()` is the
 * connect-time `net.LookupFunction` that blocks a DNS-rebinding answer.
 *
 * The DNS seam is the `DnsResolver` class itself: every case injects a stub
 * (`{ resolve }`) so no test performs a real lookup.
 */
import { Test, TestingModule } from '@nestjs/testing';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { IWebhookConfig, WEBHOOK_CFG } from '../../config/webhook.config';
import { DnsResolver } from './dns-resolver';
import { OutboundRejectionReason, OutboundUrlGuard, OutboundUrlRejection } from './outbound-url-guard';

/** An address on the allowed side of every blocked range (US-001 design table). */
const PUBLIC_IPV4 = '93.184.215.14';
const PUBLIC_IPV6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2e';
const PRIVATE_IPV4 = '10.0.0.1';

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

function makeConfig(overrides: Partial<IWebhookConfig> = {}): IWebhookConfig {
  return { ...EMPTY_ALLOWLISTS, ...overrides };
}

function makeResolveMock(addresses: readonly string[]): ResolveMock {
  return jest.fn<Promise<string[]>, [string]>(
    (): Promise<string[]> => Promise.resolve([...addresses]),
  );
}

function makeGuard(
  options: { config?: Partial<IWebhookConfig>; addresses?: readonly string[] } = {},
): GuardHarness {
  const resolve = makeResolveMock(options.addresses ?? [PUBLIC_IPV4]);
  const guard = new OutboundUrlGuard(makeConfig(options.config), { resolve });

  return { guard, resolve };
}

/** Settles `checkUrl`, asserts the rejection type, and returns the rejection reason. */
async function rejectionReason(check: Promise<void>): Promise<OutboundRejectionReason> {
  let caught: unknown;
  try {
    await check;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(OutboundUrlRejection);
  if (!(caught instanceof OutboundUrlRejection)) {
    throw new Error('checkUrl resolved instead of rejecting with OutboundUrlRejection');
  }

  return caught.reason;
}

interface LookupResult {
  calls: number;
  error: NodeJS.ErrnoException | null;
  addresses: string | LookupAddress[] | undefined;
  family: number | undefined;
}

/**
 * Invokes a `net.LookupFunction` the way `node:http(s)` does (`options.all: true`) and
 * reports the callback arguments plus how many times it was called. A second call is
 * observed only because the first result is handed back on the next macrotask.
 */
function invokeLookup(lookup: LookupFunction, hostname: string): Promise<LookupResult> {
  return new Promise<LookupResult>((fulfil) => {
    let calls = 0;
    let result: Omit<LookupResult, 'calls'> = {
      error: null,
      addresses: undefined,
      family: undefined,
    };

    lookup(hostname, { all: true }, (error, addresses, family) => {
      calls += 1;
      result = { error, addresses, family };
      setImmediate(() => fulfil({ ...result, calls }));
    });
  });
}

describe('US-002: OutboundUrlGuard.checkUrl', () => {
  describe('AC1: plain HTTP is only allowed for an allow-listed host', () => {
    it('AC1: checkUrl("http://hooks.example/x") rejects with https_required when both allowlists are empty', async () => {
      const { guard, resolve } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('http://hooks.example/x'))).toBe('https_required');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC1 boundary: an http URL to a private IP literal rejects with https_required — the scheme is decided before the address', async () => {
      const { guard, resolve } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('http://127.0.0.1/hook'))).toBe('https_required');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC1: the same destination over https is accepted', async () => {
      const { guard, resolve } = makeGuard();

      await expect(guard.checkUrl('https://hooks.example/x')).resolves.toBeUndefined();
      expect(resolve).toHaveBeenCalledWith('hooks.example');
    });
  });

  describe('AC2: embedded credentials are refused', () => {
    it('AC2: checkUrl("https://user:pw@hooks.example/") rejects with credentials_not_allowed', async () => {
      const { guard, resolve } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('https://user:pw@hooks.example/'))).toBe(
        'credentials_not_allowed',
      );
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC2 boundary: a username without a password rejects with credentials_not_allowed', async () => {
      const { guard } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('https://user@hooks.example/'))).toBe(
        'credentials_not_allowed',
      );
    });

    it('AC2 boundary: a password without a username rejects with credentials_not_allowed', async () => {
      const { guard } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('https://:pw@hooks.example/'))).toBe(
        'credentials_not_allowed',
      );
    });

    it('AC2 boundary: the scheme is decided before the credentials', async () => {
      const { guard } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('ftp://user:pw@hooks.example/'))).toBe(
        'scheme_not_allowed',
      );
    });

    it('AC2: a URL without credentials is accepted', async () => {
      const { guard } = makeGuard();

      await expect(guard.checkUrl('https://hooks.example/')).resolves.toBeUndefined();
    });
  });

  describe('AC3: only http and https are allowed schemes', () => {
    it('AC3: checkUrl("ftp://hooks.example/") rejects with scheme_not_allowed', async () => {
      const { guard, resolve } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('ftp://hooks.example/'))).toBe(
        'scheme_not_allowed',
      );
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC3 boundary: a file URL with no host rejects with scheme_not_allowed, not invalid_url', async () => {
      const { guard } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('file:///etc/passwd'))).toBe(
        'scheme_not_allowed',
      );
    });

    it('AC3 boundary: the scheme check is case-insensitive, so uppercase HTTPS is accepted', async () => {
      const { guard, resolve } = makeGuard();

      await expect(guard.checkUrl('HTTPS://hooks.example/')).resolves.toBeUndefined();
      expect(resolve).toHaveBeenCalledWith('hooks.example');
    });
  });

  describe('AC4: unparsable URLs are refused', () => {
    it('AC4: checkUrl("not a url") rejects with invalid_url', async () => {
      const { guard, resolve } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('not a url'))).toBe('invalid_url');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC4 boundary: an empty string rejects with invalid_url', async () => {
      const { guard } = makeGuard();

      expect(await rejectionReason(guard.checkUrl(''))).toBe('invalid_url');
    });

    it('AC4 boundary: "https://" with no host rejects with invalid_url', async () => {
      const { guard } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('https://'))).toBe('invalid_url');
    });

    it('AC4 boundary: a relative reference with no scheme rejects with invalid_url', async () => {
      const { guard } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('hooks.example/hook'))).toBe('invalid_url');
    });

    it('AC4: a well-formed URL is parsed and accepted rather than refused', async () => {
      const { guard } = makeGuard();

      await expect(guard.checkUrl('https://hooks.example/')).resolves.toBeUndefined();
    });
  });

  describe('AC5: numeric IPv4 literals are classified, never resolved', () => {
    it('AC5: checkUrl("https://2130706433/hook") rejects with blocked_destination without calling the resolver', async () => {
      const { guard, resolve } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('https://2130706433/hook'))).toBe(
        'blocked_destination',
      );
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC5 boundary: the hex form 0x7f.0.0.1 rejects with blocked_destination without calling the resolver', async () => {
      const { guard, resolve } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('https://0x7f.0.0.1/hook'))).toBe(
        'blocked_destination',
      );
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC5 boundary: an http URL to a private literal is still refused before the address is classified', async () => {
      const { guard, resolve } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('http://10.0.0.5/hook'))).toBe('https_required');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC5: a public IP literal is accepted without calling the resolver', async () => {
      const { guard, resolve } = makeGuard();

      await expect(guard.checkUrl(`https://${PUBLIC_IPV4}/hook`)).resolves.toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  describe('AC6: IPv4-mapped IPv6 literals are classified, never resolved', () => {
    it('AC6: checkUrl("https://[::ffff:127.0.0.1]/hook") rejects with blocked_destination', async () => {
      const { guard, resolve } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('https://[::ffff:127.0.0.1]/hook'))).toBe(
        'blocked_destination',
      );
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC6 boundary: the IPv6 loopback literal rejects with blocked_destination without calling the resolver', async () => {
      const { guard, resolve } = makeGuard();

      expect(await rejectionReason(guard.checkUrl('https://[::1]/hook'))).toBe(
        'blocked_destination',
      );
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC6: a public IPv6 literal is accepted without calling the resolver', async () => {
      const { guard, resolve } = makeGuard();

      await expect(guard.checkUrl(`https://[${PUBLIC_IPV6}]/hook`)).resolves.toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  describe('AC7: any blocked address in the DNS answer blocks the destination', () => {
    it('AC7: an answer mixing a public and a private address rejects with blocked_destination', async () => {
      const { guard, resolve } = makeGuard({ addresses: [PUBLIC_IPV4, PRIVATE_IPV4] });

      expect(await rejectionReason(guard.checkUrl('https://hooks.example/'))).toBe(
        'blocked_destination',
      );
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith('hooks.example');
    });

    it('AC7 boundary: an answer that also contains the cloud-metadata address rejects with blocked_destination', async () => {
      const { guard } = makeGuard({ addresses: [PUBLIC_IPV4, '169.254.169.254'] });

      expect(await rejectionReason(guard.checkUrl('https://hooks.example/'))).toBe(
        'blocked_destination',
      );
    });

    it('AC7 boundary: an answer of two public addresses is accepted', async () => {
      const { guard } = makeGuard({ addresses: [PUBLIC_IPV4, '172.32.0.1'] });

      await expect(guard.checkUrl('https://hooks.example/')).resolves.toBeUndefined();
    });
  });

  describe('AC8: a failing resolver is unresolvable', () => {
    it('AC8: a resolver failure with code ENOTFOUND rejects with unresolvable', async () => {
      const { guard, resolve } = makeGuard();
      resolve.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));

      expect(await rejectionReason(guard.checkUrl('https://hooks.example/'))).toBe('unresolvable');
    });

    it('AC8 boundary: a resolver failure without a code rejects with unresolvable', async () => {
      const { guard, resolve } = makeGuard();
      resolve.mockRejectedValue(new Error('dns exploded'));

      expect(await rejectionReason(guard.checkUrl('https://hooks.example/'))).toBe('unresolvable');
    });

    it('AC8: a resolver that answers keeps the destination valid', async () => {
      const { guard } = makeGuard({ addresses: [PUBLIC_IPV4] });

      await expect(guard.checkUrl('https://hooks.example/ok')).resolves.toBeUndefined();
    });
  });

  describe('AC9: an empty DNS answer is unresolvable', () => {
    it('AC9: a resolver returning [] rejects with unresolvable', async () => {
      const { guard, resolve } = makeGuard({ addresses: [] });

      expect(await rejectionReason(guard.checkUrl('https://hooks.example/'))).toBe('unresolvable');
      expect(resolve).toHaveBeenCalledWith('hooks.example');
    });

    it('AC9 boundary: a resolver returning one address is accepted', async () => {
      const { guard } = makeGuard({ addresses: [PUBLIC_IPV4] });

      await expect(guard.checkUrl('https://hooks.example/')).resolves.toBeUndefined();
    });
  });

  describe('AC10: the hostname is normalised before resolution', () => {
    it('AC10: checkUrl("https://hooks.example/hook") resolves and calls the resolver once with the normalised host', async () => {
      const { guard, resolve } = makeGuard({ addresses: [PUBLIC_IPV4] });

      await expect(guard.checkUrl('https://hooks.example/hook')).resolves.toBeUndefined();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith('hooks.example');
    });

    it('AC10 boundary: an uppercase host with a trailing dot is lower-cased and stripped before resolution', async () => {
      const { guard, resolve } = makeGuard({ addresses: [PUBLIC_IPV4] });

      await expect(guard.checkUrl('https://Hooks.Example./hook')).resolves.toBeUndefined();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith('hooks.example');
    });
  });

  describe('AC11: an allow-listed hostname skips DNS', () => {
    it('AC11: checkUrl("http://Hooks.Internal./hook") resolves without calling the resolver', async () => {
      const { guard, resolve } = makeGuard({ config: { allowedHostnames: ['hooks.internal'] } });

      await expect(guard.checkUrl('http://Hooks.Internal./hook')).resolves.toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC11 boundary: a host that merely contains the allow-listed name is not allow-listed', async () => {
      const { guard, resolve } = makeGuard({ config: { allowedHostnames: ['hooks.internal'] } });

      expect(await rejectionReason(guard.checkUrl('http://hooks.internal.evil.example/hook'))).toBe(
        'https_required',
      );
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  describe('AC12: an allow-listed CIDR covers IP literals only', () => {
    it('AC12: checkUrl("http://10.0.0.5:8080/hook") resolves with allowedCidrs ["10.0.0.0/24"] without calling the resolver', async () => {
      const { guard, resolve } = makeGuard({ config: { allowedCidrs: ['10.0.0.0/24'] } });

      await expect(guard.checkUrl('http://10.0.0.5:8080/hook')).resolves.toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC12 boundary: an https literal outside the allow-listed CIDR rejects with blocked_destination', async () => {
      const { guard, resolve } = makeGuard({ config: { allowedCidrs: ['10.0.0.0/24'] } });

      expect(await rejectionReason(guard.checkUrl('https://10.0.1.5/hook'))).toBe(
        'blocked_destination',
      );
      expect(resolve).not.toHaveBeenCalled();
    });

    it('AC12 boundary: an http literal outside the allow-listed CIDR rejects with https_required', async () => {
      const { guard } = makeGuard({ config: { allowedCidrs: ['10.0.0.0/24'] } });

      expect(await rejectionReason(guard.checkUrl('http://10.0.1.5:8080/hook'))).toBe(
        'https_required',
      );
    });

    it('AC12 boundary: the last address inside the allow-listed CIDR is accepted', async () => {
      const { guard } = makeGuard({ config: { allowedCidrs: ['10.0.0.0/24'] } });

      await expect(guard.checkUrl('http://10.0.0.255:8080/hook')).resolves.toBeUndefined();
    });
  });
});

describe('US-002: OutboundUrlGuard.createLookup', () => {
  describe('AC13: a blocked resolved address fails the lookup', () => {
    it('AC13: a resolver answer of 127.0.0.1 calls back once with an error whose code is EBLOCKED_DESTINATION', async () => {
      const { guard } = makeGuard({ addresses: ['127.0.0.1'] });

      const result = await invokeLookup(guard.createLookup(), 'rebind.example');

      expect(result.calls).toBe(1);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.code).toBe('EBLOCKED_DESTINATION');
    });

    it('AC13 boundary: a mixed public/private answer also fails the lookup', async () => {
      const { guard } = makeGuard({ addresses: [PUBLIC_IPV4, PRIVATE_IPV4] });

      const result = await invokeLookup(guard.createLookup(), 'rebind.example');

      expect(result.calls).toBe(1);
      expect(result.error?.code).toBe('EBLOCKED_DESTINATION');
    });

    it('AC13 boundary: a resolver failure is passed through with its own code', async () => {
      const { guard, resolve } = makeGuard();
      resolve.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));

      const result = await invokeLookup(guard.createLookup(), 'rebind.example');

      expect(result.calls).toBe(1);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.code).toBe('ENOTFOUND');
      expect(resolve).toHaveBeenCalledWith('rebind.example');
    });
  });

  describe('AC14: a public address is handed to the socket', () => {
    it('AC14: a resolver answer of 93.184.215.14 calls back with (null, [{ address, family: 4 }])', async () => {
      const { guard, resolve } = makeGuard({ addresses: [PUBLIC_IPV4] });

      const result = await invokeLookup(guard.createLookup(), 'hooks.example');

      expect(result.calls).toBe(1);
      expect(result.error).toBeNull();
      expect(result.addresses).toEqual([{ address: PUBLIC_IPV4, family: 4 }]);
      expect(resolve).toHaveBeenCalledWith('hooks.example');
    });

    it('AC14 boundary: an IPv6 address is handed over with family 6', async () => {
      const { guard } = makeGuard({ addresses: [PUBLIC_IPV6] });

      const result = await invokeLookup(guard.createLookup(), 'hooks.example');

      expect(result.error).toBeNull();
      expect(result.addresses).toEqual([{ address: PUBLIC_IPV6, family: 6 }]);
    });
  });

  describe('AC15: an allow-listed hostname bypasses the address check', () => {
    it('AC15: a resolver answer of 10.0.0.7 calls back with (null, [{ address, family: 4 }]) for an allow-listed hostname', async () => {
      const { guard, resolve } = makeGuard({
        config: { allowedHostnames: ['hooks.internal'] },
        addresses: ['10.0.0.7'],
      });

      const result = await invokeLookup(guard.createLookup(), 'hooks.internal');

      expect(result.calls).toBe(1);
      expect(result.error).toBeNull();
      expect(result.addresses).toEqual([{ address: '10.0.0.7', family: 4 }]);
      expect(resolve).toHaveBeenCalledWith('hooks.internal');
    });

    it('AC15 boundary: an allow-listed hostname with an uppercase name and trailing dot still bypasses the address check', async () => {
      const { guard } = makeGuard({
        config: { allowedHostnames: ['hooks.internal'] },
        addresses: ['10.0.0.7'],
      });

      const result = await invokeLookup(guard.createLookup(), 'Hooks.Internal.');

      expect(result.error).toBeNull();
      expect(result.addresses).toEqual([{ address: '10.0.0.7', family: 4 }]);
    });

    it('AC15 boundary: the same private address fails the lookup when the hostname is not allow-listed', async () => {
      const { guard } = makeGuard({ addresses: ['10.0.0.7'] });

      const result = await invokeLookup(guard.createLookup(), 'hooks.internal');

      expect(result.error?.code).toBe('EBLOCKED_DESTINATION');
    });
  });
});

describe('US-002: OutboundUrlGuard DI seam', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined as unknown as TestingModule;
    }
  });

  it('US-002: the guard is injectable with DnsResolver as a typed class token and WEBHOOK_CFG as the config', async () => {
    const resolve = makeResolveMock([PUBLIC_IPV4]);

    moduleRef = await Test.createTestingModule({
      providers: [
        OutboundUrlGuard,
        { provide: DnsResolver, useValue: { resolve } },
        { provide: WEBHOOK_CFG, useValue: makeConfig({ allowedHostnames: ['hooks.internal'] }) },
      ],
    }).compile();

    const guard = moduleRef.get(OutboundUrlGuard);

    await expect(guard.checkUrl('http://hooks.internal/hook')).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});
