# SPEC: Client identity behind a reverse proxy (trusted proxy hops)

Closes: #444, #445

## Summary

The web server becomes the single authority for the client address it reports to the API. A new setting,
`NUXT_TRUSTED_PROXY_HOPS` (runtime config `trustedProxyHops`, default `0`), says how many reverse proxies
sit in front of Nuxt. With `0` the client is the socket peer, as today. With `N > 0` the client is the
N-th entry from the right of `X-Forwarded-For`, the entry the outermost trusted proxy appended, so
anything a browser put in front of it is ignored. Every call the web server makes to the API then sends
that one address in both `x-client-ip` and `x-forwarded-for`, replacing whatever the browser sent.

## Motivation

- #444: the cookie routes (`server/api/auth/*`, `server/api/invites/[token]/accept`) call the API through
  `forwardToApi`, which sends only `x-client-ip` set from the socket peer. Behind a reverse proxy (koda-wk
  runs nginx in front of Nuxt) the peer is the proxy, so every user shares one throttle bucket: one user's
  failed logins exhaust the login limit for everybody, and `/auth/me` and `/auth/refresh` share one
  100/min bucket.
- #445: the API resolves the client from `x-forwarded-for` before `x-client-ip`
  (`@nathapp/nestjs-common` `getClientIp`, default header order). The catch-all `/api/**` proxy
  (`proxyRequest`) and SSR `useApi` (`useRequestFetch`) pass the browser's `X-Forwarded-For` through, so
  a client whose own address is in a trusted private range can choose its throttle identity. The comment in
  `server/utils/client-ip.ts` ("overrides any IP header the browser sent") does not hold.

Verified live on koda-wk `849f7eb6` on 2026-11-12.

## Design

### Integration

Read-only (verified, unchanged):

- `server/api/[...].ts`: catch-all proxy, `proxyRequest(event, target, { headers: proxyHeaders(event.context.clientIp, getRequestHeader(event, 'accept')) })`. h3 `proxyRequest` merges `opts.headers` over the request headers, later wins.
- `server/utils/api.ts` `forwardToApi(event, path, init)`: builds `{ Accept, ...clientIpHeaders(event.context.clientIp), Authorization? }` fresh (browser headers are never copied) and calls `$fetch.raw`.
- `composables/useApi.ts` `useApi()`: on the server, `getHeaders` spreads `clientIpHeaders(ssrEvent.context.clientIp)` last and calls `useRequestFetch()`. In nuxt 4.6.4 that is `event.$fetch`, h3 `fetchWithEvent`, which builds `{ ...getProxyRequestHeaders(event), ...init.headers }`: the call's own headers win. The spread is case-sensitive, so every header key this feature sets is lowercase.
- `server/utils/proxy-target.ts` `proxyHeaders(clientIp, accept)`: `{ accept?, ...clientIpHeaders(clientIp) }`.

Changed. The baseline exists only to locate the code; implement the target.

- `server/utils/client-ip.ts` `resolveClientIp`
  - Baseline: `resolveClientIp(req: ClientIpRequest): string | undefined`
  - Target: `resolveClientIp(req: ClientIpRequest, trustedProxyHops = 0): string | undefined`; `ClientIpRequest` gains `headers?: { 'x-forwarded-for'?: string }` (Node joins repeated `x-forwarded-for` headers into one comma-separated string).
- `server/utils/client-ip.ts` `clientIpHeaders`
  - Baseline: `clientIpHeaders(clientIp: string | undefined): Record<string, string>` returning `{ 'x-client-ip': ip }`
  - Target: same signature, returning `{ 'x-client-ip': ip, 'x-forwarded-for': ip }` where `ip` is the resolved address or `UNKNOWN_CLIENT_IP` (`0.0.0.0`).
- New export in `server/utils/client-ip.ts`: `parseTrustedProxyHops(raw: unknown): number`.
- `server/middleware/client-ip.ts`
  - Baseline: `event.context.clientIp = resolveClientIp(event.node.req as unknown as ClientIpRequest)`
  - Target: `event.context.clientIp = resolveClientIp(event.node.req as unknown as ClientIpRequest, parseTrustedProxyHops(useRuntimeConfig(event).trustedProxyHops))`, keeping the `resolveClientIp(event.node.req` call shape that `tests/server/client-ip.spec.ts` pins.
- `nuxt.config.ts` `runtimeConfig`: new server-only key `trustedProxyHops: 0`, so `NUXT_TRUSTED_PROXY_HOPS` overrides it at runtime.

### Approach

Resolution order in `resolveClientIp(req, hops)`:

1. An in-process request (`req.__unenv__` present) inherits the outer request's client IP, as today. Hops and headers are not read.
2. `hops` is `0`: the socket peer (zone id stripped), as today.
3. `hops` is `N > 0`: split `x-forwarded-for` on commas and trim each entry; empty entries are kept and count toward the length. When there are at least `N` entries, take the entry at index `length - N` and strip an IPv6 zone id. Return it when `isIP` from `node:net` accepts it (a bare IPv4 or IPv6 address; `host:port` and bracketed forms are rejected). Otherwise (header absent, fewer than `N` entries, or the chosen entry rejected) fall back to the socket peer.

`parseTrustedProxyHops` accepts a non-negative integer, given as a number or a decimal string, and returns `0` for anything else.

The same address goes into both headers because the API reads `x-forwarded-for` first and accepts a single untrusted entry as the client; sending only `x-client-ip` would leave a browser-supplied `x-forwarded-for` in charge.

The comment block in `server/utils/client-ip.ts` and the header comment of `tests/server/client-ip.spec.ts` are rewritten to describe this rule (non-normative).

### Failure Handling

| Input | Behaviour |
|:--|:--|
| `trustedProxyHops` unset, negative, fractional or non-numeric | treated as `0` (socket peer) |
| `hops > 0` and no `x-forwarded-for` | socket peer |
| `hops > 0` and fewer entries than `hops` | socket peer |
| `hops > 0` and the chosen entry is not a bare IP (garbage, empty, `host:port`) | socket peer |
| no address resolved at all | both headers carry `0.0.0.0` (shared placeholder, never omitted) |

## Out of Scope

- The API's trusted-proxy list (`configureTrustProxy` in `apps/api/src/main.ts`) and its header priority are unchanged; the fix is that the web server always sends one authoritative value.
- Runner routes that a deployment proxy sends straight to the API (`/api/fleet/runner/*`) never pass through Nuxt; they require a runner API key, and their client identity is the deployment proxy's concern.
- With `NUXT_TRUSTED_PROXY_HOPS` above `0`, Nuxt must be reachable only through that proxy; a request that reaches Nuxt directly can still name its own address. This is documented, not enforced.
- The resolved address is used as-is with no canonicalisation of equivalent IPv6 or IPv4-mapped forms; the trusted proxy writes the entry, so a client cannot choose its form.
- Throttle limits (`THROTTLE_LIMIT`, `AUTH_LOGIN_LIMIT`) and per-route `@Throttle` values are unchanged.
- Setting `NUXT_TRUSTED_PROXY_HOPS: 1` in the koda-wk deployment (`~/koda-wk/docker-compose.yml`) is a manual deploy step outside this repository.
- The `/me/permissions` SSR refetch and the R2-15 hydration mismatch belong to the UX audit bundle, not this feature.

## Stories

### US-001: Hop-aware client resolution

No dependencies. Workdir: `apps/web`.

Add the `trustedProxyHops` argument to `resolveClientIp` in `server/utils/client-ip.ts`, following the
resolution order in Design § Approach, with `isIP` from `node:net` as the address check.

### US-002: Trusted-hop setting wired into the middleware

Depends on US-001. Workdir: `apps/web`.

Add `parseTrustedProxyHops` to `server/utils/client-ip.ts`, add `trustedProxyHops: 0` to `runtimeConfig`
in `nuxt.config.ts`, and make `server/middleware/client-ip.ts` pass the parsed runtime value, keeping the
`resolveClientIp(event.node.req` call shape.

### US-003: One authoritative client address on every upstream call

Depends on US-002. Workdir: `apps/web`.

`clientIpHeaders` returns both `x-client-ip` and `x-forwarded-for` set to the same address. The catch-all
proxy, `forwardToApi` and SSR `useApi` already spread `clientIpHeaders` last, so each now overrides a
browser-supplied `x-forwarded-for`. Rewrite the comments in `server/utils/client-ip.ts`. The login-route
test drives `server/api/auth/login.post.ts` with the Nitro globals stubbed the way
`tests/server/logout-route.spec.ts` does (`defineEventHandler`, `readBody`, `$fetch.raw`,
`useRuntimeConfig`, and the real `forwardToApi`).

### US-004: Document the setting for deployments

**No-test:** documentation and example config only; no code loads these lines.

No dependencies. Workdir: `.`.

Document `NUXT_TRUSTED_PROXY_HOPS` in `deployments/example/docker-compose.yml` (web service) and
`.env.example`.

### Context Files

**US-001**

- `apps/web/server/utils/client-ip.ts`
- `apps/web/tests/server/client-ip.spec.ts`

**US-002**

- `apps/web/server/utils/client-ip.ts`
- `apps/web/server/middleware/client-ip.ts`
- `apps/web/nuxt.config.ts`

**US-003**

- `apps/web/server/utils/client-ip.ts`
- `apps/web/server/api/[...].ts`
- `apps/web/server/api/auth/login.post.ts`
- `apps/web/tests/server/logout-route.spec.ts`
- `apps/web/tests/composables/useApi.spec.ts`

**US-004**

- `deployments/example/docker-compose.yml`
- `.env.example`

### Creates

**US-001**

- `apps/web/tests/server/client-ip-hops.spec.ts`

**US-002**

- `apps/web/tests/server/client-ip-middleware.spec.ts`

**US-003**

- `apps/web/tests/server/client-identity-wiring.spec.ts`

### Modifies

**US-003**

- `apps/web/tests/server/client-ip.spec.ts` — the `clientIpHeaders` tests assert the exact objects `{ 'x-client-ip': '203.0.113.7' }` and `{ 'x-client-ip': '0.0.0.0' }`; replace them with objects that also carry `'x-forwarded-for'` equal to the same address, keeping the fail-closed `0.0.0.0` case; also rewrite the file's header comment, which says the API reads `x-client-ip` first, to say the web server sends one address in both headers.
- `apps/web/tests/server/api-proxy.spec.ts` — the `proxyHeaders` tests assert exact objects containing only `accept` and `x-client-ip`; replace them with objects that also carry `'x-forwarded-for'` equal to the `x-client-ip` value, keeping the `accept` cases unchanged.

### Seams

- US-001 `resolveClientIp(req, hops)` and US-002 `parseTrustedProxyHops` are consumed by `server/middleware/client-ip.ts`; US-002 AC-6 and AC-7 drive the middleware handler.
- US-003 `clientIpHeaders` is consumed by the catch-all proxy, `forwardToApi` (through the login route) and SSR `useApi`; US-003 AC-3 to AC-5 drive each entry point.

## Acceptance Criteria

### US-001

1. [unit] `resolveClientIp` with hops `0`, socket peer `172.25.0.5` and `x-forwarded-for: 203.0.113.5` returns `172.25.0.5`.
2. [unit] `resolveClientIp` with hops `1`, socket peer `::ffff:172.25.0.5` and `x-forwarded-for: 198.51.100.9` returns `198.51.100.9`.
3. [unit] `resolveClientIp` with hops `1` and `x-forwarded-for: 203.0.113.5, 172.25.0.1` returns `172.25.0.1` (the entry the proxy appended, not the one the client sent).
4. [unit] `resolveClientIp` with hops `2` and `x-forwarded-for: 203.0.113.5, 198.51.100.9, 10.0.0.2` returns `198.51.100.9`.
5. [unit] `resolveClientIp` with hops `1`, socket peer `172.25.0.5` and no `x-forwarded-for` header returns `172.25.0.5`.
6. [unit] `resolveClientIp` with hops `2`, socket peer `172.25.0.5` and `x-forwarded-for: 198.51.100.9` (one entry) returns `172.25.0.5`.
7. [unit] `resolveClientIp` with hops `1`, socket peer `172.25.0.5` and `x-forwarded-for: not-an-ip` returns `172.25.0.5`.
8. [unit] `resolveClientIp` with hops `1`, socket peer `172.25.0.5` and `x-forwarded-for: 198.51.100.9:443` returns `172.25.0.5`.
9. [unit] `resolveClientIp` with hops `1`, socket peer `172.25.0.5` and `x-forwarded-for: 203.0.113.5,` (trailing comma, empty last entry) returns `172.25.0.5`.
10. [unit] `resolveClientIp` with hops `1` and `x-forwarded-for: fe80::1%eth0` returns `fe80::1`.
11. [unit] `resolveClientIp` with hops `1`, `x-forwarded-for: 203.0.113.5` and `__unenv__.clientIp` `198.51.100.9` returns `198.51.100.9` (in-process requests inherit the outer client).

### US-002

1. [unit] `parseTrustedProxyHops(1)` returns `1`.
2. [unit] `parseTrustedProxyHops("2")` returns `2`.
3. [unit] `parseTrustedProxyHops(undefined)` returns `0`.
4. [unit] `parseTrustedProxyHops("-1")` returns `0`.
5. [unit] `parseTrustedProxyHops("abc")` returns `0`.
6. [unit] Invoking the `server/middleware/client-ip.ts` handler with runtime config `trustedProxyHops` `1`, socket peer `::ffff:172.25.0.5` and `x-forwarded-for: 203.0.113.5, 172.25.0.1` sets `event.context.clientIp` to `172.25.0.1`.
7. [unit] Invoking the `server/middleware/client-ip.ts` handler with a runtime config that has no `trustedProxyHops`, socket peer `172.25.0.5` and `x-forwarded-for: 203.0.113.5` sets `event.context.clientIp` to `172.25.0.5`.

### US-003

1. [unit] `clientIpHeaders('198.51.100.9')` returns exactly `{ 'x-client-ip': '198.51.100.9', 'x-forwarded-for': '198.51.100.9' }`.
2. [unit] `clientIpHeaders(undefined)` returns exactly `{ 'x-client-ip': '0.0.0.0', 'x-forwarded-for': '0.0.0.0' }`.
3. [unit] Invoking the `server/api/[...].ts` handler with `proxyRequest` stubbed and `event.context.clientIp` `172.25.0.1` calls `proxyRequest` once with options whose `headers['x-forwarded-for']` is `172.25.0.1`.
4. [unit] Invoking the `server/api/auth/login.post.ts` handler with `$fetch.raw` stubbed and `event.context.clientIp` `172.25.0.1` sends the upstream `/auth/login` request with `headers['x-forwarded-for']` `172.25.0.1` and `headers['x-client-ip']` `172.25.0.1`.
5. [unit] On the server, `useApi().$api.get('/projects/1')` with request event `context.clientIp` `203.0.113.20` and a caller header `x-forwarded-for: 6.6.6.6` sends `x-forwarded-for` `203.0.113.20`.
6. [unit] Regression guard: in the browser, `useApi().$api.get('/projects/1')` still sends no `x-forwarded-for` header (the `/api` proxy sets it).

### US-004

1. [review] `deployments/example/docker-compose.yml`, `web.environment`: a commented `NUXT_TRUSTED_PROXY_HOPS` entry explains that it is the number of reverse proxies in front of web, `0` (default) when browsers connect to web directly as in this file, and `1` when one proxy such as nginx sits in front.
2. [review] `.env.example`: a commented `NUXT_TRUSTED_PROXY_HOPS=0` line with the same one-line explanation sits next to `NUXT_API_INTERNAL_URL`.
