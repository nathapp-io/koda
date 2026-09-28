# SPEC: Track 3 Slice 2a — Outbound webhook SSRF guard

## Summary

Outbound project webhooks can currently be pointed at any address the API host can reach, including
loopback, private networks and cloud metadata, and the delivery follows redirects and records raw socket
errors. This slice adds an outbound address guard, checks webhook URLs when they are created or updated
(including a new `PATCH projects/:slug/webhooks/:id` route), and moves delivery onto `node:http` /
`node:https` with a connect-time DNS check, no redirects, and a fixed set of error codes. A
`WEBHOOK_ALLOWED_HOSTS` allowlist lets an operator deliberately target an internal host.

## Motivation

Review finding M5 (`docs/20260925-review-whole-repo.md`, confirmed):

- `CreateWebhookDto.url` is only `@IsUrl()` (`apps/api/src/webhook/webhook.dto.ts:4`). That accepts IP
  literals such as `http://169.254.169.254/` and dotted internal names.
- `WebhookDeliveryHandler.handle` (`apps/api/src/webhook/webhook-delivery.handler.ts:31-41`) calls global
  `fetch`, which follows redirects, so a public URL can redirect the API into the internal network.
- A failed delivery throws `Webhook delivery failed with status N` or the raw socket error. `FanOutPublisher`
  stores that text as the outbox row's `lastError`, which `/admin/outbox` shows. Different socket errors
  for different internal ports make it a port-scan oracle.

Registering a webhook needs `@RequiredPermission('ADMIN')`, so the attacker is an admin or a stolen admin
token. The API runs with network access the admin does not otherwise have, so this is still a real
privilege boundary.

Track 3 rulings (2026-09-27): block private ranges, with an env allowlist (`WEBHOOK_ALLOWED_HOSTS`),
checked at lookup time. Slice 2a rulings (2026-09-27): add the PATCH route with the same check; an
unresolvable hostname at create/update time is a 400; blocked deliveries keep the normal relay retries;
block the IPv6 unspecified address and multicast in addition to the listed ranges.

## Design

### Integration

Read-only symbols (verified at `26d2128f`):

- `FanOutPublisher.publish` (`apps/api/src/outbox/fan-out-publisher.ts`) runs every handler registered for
  a record type and, if any throws, records `"<n> fan-out handler(s) failed for <type>: <messages>"` via
  `PrismaOutboxRepository.recordLastError` and rethrows, so the relay retries. The handler's `Error.message`
  is therefore exactly what an admin sees.
- `WebhookOutboxSubscriber` (`apps/api/src/webhook/webhook-outbox.subscriber.ts`) registers
  `WebhookDeliveryHandler.handle` for `webhook_delivery` in `onModuleInit`.
- `PrismaWebhookRepository` (`apps/api/src/webhook/prisma-webhook.repository.ts`) extends
  `AbstractPrismaRepository`, whose inherited `update(id: string, patch: Partial<WebhookDomain>):
  Promise<WebhookDomain>` maps `url`, `secret`, `events`, `active` through `toPersistenceUpdate`. No new
  repository method is needed.
- `ConfigBridgeModule` (`apps/api/src/config/config-bridge.module.ts`) is `@Global()` and exposes typed
  config tokens (e.g. `LIVE_CFG`) consumed as `@Inject(LIVE_CFG) private readonly config: ILiveConfig`.
  `GlobalStubsModule` (`apps/api/src/common/test-helpers/global-stubs.module.ts`) provides mocks of those
  tokens for DI tests.
- `ValidationAppException(args, prefix)` (`@nathapp/nestjs-common`) is a 400 whose message key is
  `<prefix>.-2`, interpolated with `args` (same mechanism as `tickets.json` `"-2"`).
- `validate` in `apps/api/src/config/env.validation.ts` runs the Joi `envSchema` at boot and throws
  `ValidationAppException` with one arg per failing variable.

Mutated symbols. The baseline only locates the code; implement the target.

- `CreateWebhookDto.url` / `UpdateWebhookDto.url` (`webhook.dto.ts`)
  - Baseline: `@IsUrl()`.
  - Target: `@IsString() @MaxLength(2048)`. `OutboundUrlGuard` is the only URL validator, so `@IsUrl`'s
    TLD rule no longer refuses an allow-listed `localhost`.
- `WebhookService` (`webhook.service.ts`)
  - Baseline: `constructor(webhookRepo: PrismaWebhookRepository)`; `create(projectId, dto)` stores the URL
    unchecked; no update method.
  - Target: `constructor(webhookRepo: PrismaWebhookRepository, urlGuard: OutboundUrlGuard)`;
    `create(projectId, dto)` awaits `urlGuard.checkUrl(dto.url)` before `createWebhook`;
    new `update(projectId: string, id: string, dto: UpdateWebhookDto): Promise<WebhookView>`.
- `WebhookController` (`webhook.controller.ts`)
  - Baseline: create, list, two deletes.
  - Target: adds `@Patch('projects/:slug/webhooks/:id') @RequiredPermission('ADMIN') update(slug, id, dto)`
    returning `JsonResponse.Ok(view)`.
- `WebhookDeliveryHandler` (`webhook-delivery.handler.ts`)
  - Baseline: `constructor(webhookRepo)`; delivers with global `fetch`, `AbortSignal.timeout(5000)`; throws
    `Webhook delivery failed with status N` or the raw error.
  - Target: `constructor(webhookRepo: PrismaWebhookRepository, http: OutboundHttpClient)`; signs the body as
    today (same three `X-Koda-*` headers, same signature and delivery-id derivation) and calls
    `http.post(...)`; throws `WebhookDeliveryError` whose `message` is exactly one delivery error code.

### New code

All new files live under `apps/api/src/webhook/outbound/` except the config.

`config/webhook.config.ts`, following `live.config.ts`:

```typescript
export const WEBHOOK_CFG = 'webhook';
export const DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;

export interface IWebhookConfig {
  allowedHostnames: readonly string[]; // lower-cased, trailing dot stripped
  allowedCidrs: readonly string[];     // e.g. '10.0.0.0/24', 'fd00::/8'
  deliveryTimeoutMs: number;           // always DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS
}

/** Throws Error naming the bad entry when an entry is neither a hostname nor a valid CIDR. */
export function parseAllowedHosts(raw: string | undefined): Pick<IWebhookConfig, 'allowedHostnames' | 'allowedCidrs'>;

export const webhookConfig = registerAs(WEBHOOK_CFG, (): IWebhookConfig => ({ ... }));
```

`WEBHOOK_ALLOWED_HOSTS` is comma-separated; entries are trimmed and empty entries dropped. An entry with a
`/` is a CIDR (IPv4 prefix 0-32, IPv6 prefix 0-128). Anything else is a hostname, which must match
`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$` after lower-casing and stripping one
trailing dot. `envSchema` gains `WEBHOOK_ALLOWED_HOSTS: Joi.string().allow('').custom(...)`, where the
custom rule calls `parseAllowedHosts` and turns a thrown error into a Joi error, so a bad entry refuses boot.
`webhookConfig` is added to the `ConfigModule.forRoot` `load` array in `app.module.ts`, and
`ConfigBridgeModule` gains a `WEBHOOK_CFG` provider built the same way as `LIVE_CFG`.

`outbound/address-classifier.ts`:

```typescript
export type AddressVerdict = 'allowed' | 'blocked';

/** `address` is an IP string as returned by URL.hostname (brackets removed) or by DNS lookup. */
export function classifyAddress(address: string, allowedCidrs: readonly string[]): AddressVerdict;
```

It uses one module-level `net.BlockList` for the blocked ranges and builds a second `net.BlockList` from
`allowedCidrs`. `BlockList.check` matches an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`,
`::ffff:7f00:1`) against IPv4 rules on both Node 22 and Bun 1.4.2 (spike 2026-09-27). An address inside an
allow-listed CIDR is `allowed` even when it is in a blocked range. A string that `net.isIP` does not
recognise is `blocked` (fail closed).

Blocked ranges:

| Blocked range | Representative address (test fixture) |
|:--|:--|
| `0.0.0.0/8` | `0.1.2.3` |
| `10.0.0.0/8` | `10.1.2.3` |
| `100.64.0.0/10` | `100.64.0.1` |
| `127.0.0.0/8` | `127.0.0.1` |
| `169.254.0.0/16` | `169.254.169.254` |
| `172.16.0.0/12` | `172.16.0.1` |
| `192.168.0.0/16` | `192.168.1.1` |
| `224.0.0.0/3` (224.0.0.0-255.255.255.255) | `224.0.0.1`, `255.255.255.255` |
| `::/128` | `::` |
| `::1/128` | `::1` |
| `fc00::/7` | `fd00::1` |
| `fe80::/10` | `fe80::1` |
| `ff00::/8` | `ff02::1` |
| `::ffff:0:0/96` mapped forms of the IPv4 ranges above | `::ffff:127.0.0.1`, `::ffff:a9fe:a9fe` |

Allowed edge addresses (just outside a blocked range, or public), used as the negative fixture:
`93.184.215.14`, `172.32.0.1`, `100.128.0.1`, `2606:2800:21f:cb07:6820:80da:af6b:8b2e`.

`outbound/dns-resolver.ts`: an `@Injectable() class DnsResolver` with
`resolve(hostname: string): Promise<string[]>`, implemented with `dns.promises.lookup(hostname, { all: true })`
mapped to addresses. It is the DNS seam: tests provide `{ provide: DnsResolver, useValue: stub }` (typed class
injection, no string token).

`outbound/outbound-url-guard.ts`:

```typescript
export type OutboundRejectionReason =
  | 'invalid_url' | 'scheme_not_allowed' | 'credentials_not_allowed'
  | 'https_required' | 'blocked_destination' | 'unresolvable';

export class OutboundUrlRejection extends Error {
  constructor(readonly reason: OutboundRejectionReason) { super(reason); this.name = 'OutboundUrlRejection'; }
}

@Injectable()
export class OutboundUrlGuard {
  constructor(@Inject(WEBHOOK_CFG) config: IWebhookConfig, resolver: DnsResolver) {}

  /** Create/update-time check. Resolves hostnames. Rejects with OutboundUrlRejection. */
  checkUrl(url: string): Promise<void>;

  /** Delivery-time pre-connect check: steps 2-8 below, never resolves DNS. Throws OutboundUrlRejection. */
  assertStaticTarget(url: URL): void;

  /** A `lookup` for node:http(s).request that validates every resolved address at connect time. */
  createLookup(): net.LookupFunction;
}
```

`checkUrl` is one ordered pipeline. The first failing step decides the reason:

1. `new URL(url)` throws → `invalid_url`.
2. protocol is not `http:` or `https:` → `scheme_not_allowed`.
3. `username` or `password` is non-empty → `credentials_not_allowed`.
4. host = `URL.hostname` lower-cased, one trailing dot stripped, `[`/`]` removed. WHATWG URL has already
   normalised numeric forms (`127.1`, `2130706433`, `0x7f.0.0.1` all become `127.0.0.1`), so the guard only
   ever sees canonical addresses.
5. allow-listed = host equals an entry of `allowedHostnames`, or host is an IP literal inside an
   `allowedCidrs` entry.
6. protocol is `http:` and the host is not allow-listed → `https_required`.
7. host is an allow-listed hostname → accept. No DNS lookup.
8. host is an IP literal → `classifyAddress(host, allowedCidrs)`; `blocked` → `blocked_destination`,
   otherwise accept.
9. `resolver.resolve(host)` throws, or returns an empty list → `unresolvable`.
10. any resolved address classifies `blocked` → `blocked_destination`. Otherwise accept.

`assertStaticTarget` runs steps 2-8 on an already-parsed URL (the caller has done step 1). For a hostname that is not allow-listed it
returns without resolving; the connect-time `lookup` does the address check.

The function returned by `createLookup()` has the `net.LookupFunction` signature
`(hostname, options, callback)`. It calls `resolver.resolve(hostname)`. If the hostname (normalised as in
step 4) is allow-listed, all addresses pass. Otherwise, if any address classifies `blocked`, it calls back
with an `Error` whose `code` is `'EBLOCKED_DESTINATION'`. A resolver failure is passed through with its own
code. On success it calls back `callback(null, [{ address, family }])` when `options.all` is true, else
`callback(null, address, family)` with the first address. Node 22 and Bun 1.4.2 both call `lookup` with
`all: true` for `http` and `https`, honour its error, and skip `lookup` entirely for IP-literal hosts
(spike 2026-09-27). That is why the static check exists.

`outbound/outbound-http-client.ts`:

```typescript
export type DeliveryErrorCode =
  | 'blocked_destination' | 'connect_failed' | 'timeout'
  | 'redirect_refused' | 'http_4xx' | 'http_5xx';

export class WebhookDeliveryError extends Error {
  constructor(readonly code: DeliveryErrorCode) { super(code); this.name = 'WebhookDeliveryError'; }
}

@Injectable()
export class OutboundHttpClient {
  constructor(urlGuard: OutboundUrlGuard, @Inject(WEBHOOK_CFG) config: IWebhookConfig) {}

  /** Resolves on 2xx. Otherwise throws WebhookDeliveryError. */
  post(url: string, headers: Record<string, string>, body: string): Promise<void>;
}
```

`post`:

1. parses the URL and calls `urlGuard.assertStaticTarget`; any `OutboundUrlRejection` → `blocked_destination`.
2. calls `https.request` or `http.request` (by protocol) with `method: 'POST'`, the headers, `lookup:
   urlGuard.createLookup()`, and `signal: AbortSignal.timeout(config.deliveryTimeoutMs)`.
3. drains and discards the response body. Status 200-299 → resolve; 300-399 → `redirect_refused` (the
   `Location` is never requested); 400-499 → `http_4xx`; 500-599 → `http_5xx`.
4. maps request errors: `code === 'EBLOCKED_DESTINATION'` → `blocked_destination`; `code === 'ABORT_ERR'`
   (Node 22 and Bun 1.4.2 both raise `AbortError` / `ABORT_ERR` with cause `TimeoutError`, spike 2026-09-27)
   → `timeout`; anything else (refused, reset, TLS failure, DNS failure) → `connect_failed`.
5. logs the raw error once with `Logger.warn` (`OutboundHttpClient`), including the error code and the URL's
   host, so operators can still diagnose. The raw text never reaches `WebhookDeliveryError.message`.

`WebhookModule` registers `DnsResolver`, `OutboundUrlGuard` and `OutboundHttpClient` as providers.

`WebhookView` (returned by `WebhookService.update` and the PATCH route) is `WebhookListItem` plus
`active: boolean`, never `secret`. It lives in `webhook/domain/webhook.domain.ts`.

`WebhookService.update(projectId, id, dto)`:

1. `findById(id)`; missing, or `projectId` differs from the webhook's → `NotFoundAppException({}, 'webhooks')`.
2. if `dto.url !== undefined`, `await urlGuard.checkUrl(dto.url)`.
3. `webhookRepo.update(id, { url, secret, events: JSON.stringify(events), active })` with only the provided
   fields, then returns the `WebhookView`.

An `OutboundUrlRejection` from `checkUrl` in `create` or `update` becomes
`new ValidationAppException({ reason: rejection.reason }, 'webhooks')`. `webhooks.json` (en and zh) gains
`"-2"`: en `"Webhook URL rejected: {reason}"`, zh `"Webhook URL 被拒绝：{reason}"`.

### Failure Handling

| Condition | Where | Behaviour |
|:--|:--|:--|
| URL fails the guard at create or update (any reason, incl. `unresolvable`) | `WebhookService` | 400 `ValidationAppException({ reason }, 'webhooks')`; nothing stored or changed |
| PATCH on an id that is missing or belongs to another project | `WebhookService.update` | 404 `NotFoundAppException`, no update |
| Stored URL fails the static check at delivery (e.g. an `http` row created before this slice) | `OutboundHttpClient.post` | `blocked_destination`, no connection attempted |
| Hostname resolves to a blocked address at delivery (DNS rebinding) | connect-time `lookup` | `blocked_destination`, no connection attempted |
| DNS failure, refused, reset or TLS error at delivery | `OutboundHttpClient.post` | `connect_failed`; raw error logged with `Logger.warn` |
| No response within `deliveryTimeoutMs` | `OutboundHttpClient.post` | `timeout` |
| 3xx response | `OutboundHttpClient.post` | `redirect_refused`; `Location` not requested |
| 4xx / 5xx response | `OutboundHttpClient.post` | `http_4xx` / `http_5xx` |
| Any delivery error | `WebhookDeliveryHandler` → `FanOutPublisher` | `lastError` holds only the code. Retry and dead-lettering are the existing, unchanged `@nathapp/nestjs-outbox` relay policy (see Out of Scope); this slice adds no retry behaviour and no test of it |
| `WEBHOOK_ALLOWED_HOSTS` has an invalid entry | `envSchema` | boot refused with a `ValidationAppException` naming `WEBHOOK_ALLOWED_HOSTS` |

## Out of Scope

- Non-retryable delivery errors: a `blocked_destination` delivery keeps the relay's normal retry and backoff before it becomes `dead` (Slice 2a ruling 2026-09-27).
- Inbound CI and VCS webhook hardening and the scope of `DELETE projects/:slug/webhooks/:id` (it ignores the slug today): Track 3 Slice 2b.
- A CLI `webhook update` command and any web UI for webhooks: the PATCH route is exposed through the API and `openapi.json` only.
- HTTP(S) proxy support: deliveries connect directly, and `HTTP_PROXY` / `HTTPS_PROXY` are ignored.
- Blocking NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`) and Teredo (`2001::/32`) prefixes: only the ranges in the Design table are blocked.
- Re-validating or migrating existing webhook rows: rows created before this slice are checked at delivery time only.
- Storing or logging response bodies: the body is drained and discarded.
- A per-project allowlist: `WEBHOOK_ALLOWED_HOSTS` is one global setting.
- Extending `test/e2e/api-endpoint/endpoint.e2e.spec.ts`: it is past the 1000-line limit in `.nax/rules/api-testing.md`, so the HTTP-level webhook coverage lives in the new `test/integration/webhook/webhook-routes.integration.spec.ts`.
- US-002 only: `createLookup()` called with `options.all` false. Node 22 and Bun 1.4.2 always pass `all: true` (spike 2026-09-27); the single-address callback form is implemented but not pinned by a test.

## Stories

### US-001 — Address classifier and allowlist config

Workdir: `apps/api`. Depends on: none.

Adds `classifyAddress` with the blocked-range table, `parseAllowedHosts`, `webhookConfig` /
`IWebhookConfig` / `WEBHOOK_CFG` wired through `app.module.ts`, `ConfigBridgeModule` and `GlobalStubsModule`,
and the Joi rule for `WEBHOOK_ALLOWED_HOSTS`.

### US-002 — Outbound URL guard

Workdir: `apps/api`. Depends on: US-001.

Adds `DnsResolver`, `OutboundUrlRejection` and `OutboundUrlGuard` (`checkUrl`, `assertStaticTarget`,
`createLookup`) and registers `DnsResolver` and `OutboundUrlGuard` in `WebhookModule`.

### US-003 — Checked URLs on create and the new PATCH route

Workdir: `apps/api`. Depends on: US-002.

`WebhookService.create` checks the URL, `WebhookService.update` and `PATCH projects/:slug/webhooks/:id` are
added, the DTO `url` validators change, the `webhooks.json` `"-2"` message is added in en and zh, and the
HTTP integration spec is added. Verification note: run `bun run generate` from the repo root and commit
the regenerated `openapi.json`.

### US-004 — Guarded delivery

Workdir: `apps/api`. Depends on: US-002.

Adds `OutboundHttpClient` and `WebhookDeliveryError`, registers the client in `WebhookModule`, and moves
`WebhookDeliveryHandler` from global `fetch` to the client.

### Context Files

**US-001**
- `apps/api/src/config/live.config.ts`
- `apps/api/src/config/env.validation.ts`
- `apps/api/src/config/config-bridge.module.ts`
- `apps/api/src/common/test-helpers/global-stubs.module.ts`

**US-002**
- `apps/api/src/webhook/webhook.module.ts`
- `apps/api/src/webhook/outbound/address-classifier.ts` — created by US-001, read here
- `apps/api/src/config/webhook.config.ts` — created by US-001, read here

**US-003**
- `apps/api/src/webhook/webhook.service.ts`
- `apps/api/src/webhook/webhook.controller.ts`
- `apps/api/src/webhook/prisma-webhook.repository.ts`
- `apps/api/test/helpers/http-app.ts`
- `apps/api/test/unit/i18n/projects-translation-keys.spec.ts`
- `apps/api/src/webhook/outbound/outbound-url-guard.ts` — created by US-002, read here

**US-004**
- `apps/api/src/webhook/webhook-delivery.handler.ts`
- `apps/api/src/outbox/fan-out-publisher.ts`
- `apps/api/src/webhook/webhook-outbox.subscriber.ts`
- `apps/api/src/webhook/outbound/outbound-url-guard.ts` — created by US-002, read here

### Creates

**US-001**
- `apps/api/src/webhook/outbound/address-classifier.ts`
- `apps/api/src/webhook/outbound/address-classifier.spec.ts`
- `apps/api/src/config/webhook.config.ts`
- `apps/api/src/config/webhook.config.spec.ts`

**US-002**
- `apps/api/src/webhook/outbound/dns-resolver.ts`
- `apps/api/src/webhook/outbound/outbound-url-guard.ts`
- `apps/api/src/webhook/outbound/outbound-url-guard.spec.ts`

**US-003**
- `apps/api/test/integration/webhook/webhook-routes.integration.spec.ts`

**US-004**
- `apps/api/src/webhook/outbound/outbound-http-client.ts`
- `apps/api/src/webhook/outbound/outbound-http-client.spec.ts`

### Modifies

**US-001**
- `apps/api/src/config/env.validation.ts` — `envSchema` gains `WEBHOOK_ALLOWED_HOSTS` with a custom rule that calls `parseAllowedHosts`.
- `apps/api/src/config/config-bridge.module.ts` — gains a `WEBHOOK_CFG` provider and export built like `LIVE_CFG`.
- `apps/api/src/app.module.ts` — `webhookConfig` is added to the `ConfigModule.forRoot` `load` array.
- `apps/api/src/common/test-helpers/global-stubs.module.ts` — provides and exports a `mockWebhookConfig` for `WEBHOOK_CFG` (empty allowlists, `deliveryTimeoutMs: 5000`) so DI tests that import `GlobalStubsModule` can resolve the new providers.

**US-002**
- `apps/api/src/webhook/webhook.module.ts` — registers `DnsResolver` and `OutboundUrlGuard` as providers.

**US-003**
- `apps/api/src/webhook/webhook.service.ts` — the constructor gains `OutboundUrlGuard`; `create` checks the URL and `update` is added.
- `apps/api/src/webhook/webhook.controller.ts` — adds the PATCH handler for projects/:slug/webhooks/:id.
- `apps/api/src/webhook/webhook.dto.ts` — `url` on both DTOs changes from `@IsUrl()` to `@IsString() @MaxLength(2048)`.
- `apps/api/src/webhook/domain/webhook.domain.ts` — adds the `WebhookView` type.
- `apps/api/src/webhook/webhook.service.spec.ts` — `new WebhookService(webhookRepo)` becomes `new WebhookService(webhookRepo, urlGuard)` with a stub guard; the existing create cases keep their assertions with a guard that resolves.
- `apps/api/src/webhook/webhook.dto.spec.ts` — gains cases for the new invariant that `url` must be a string of at most 2048 characters (no existing case asserts `@IsUrl`; semantic URL checks belong to `OutboundUrlGuard`).
- `apps/api/src/i18n/en/webhooks.json` — adds the `"-2"` message.
- `apps/api/src/i18n/zh/webhooks.json` — adds the `"-2"` message.
- `openapi.json` — regenerated for the PATCH route and the DTO change.

**US-004**
- `apps/api/src/webhook/webhook-delivery.handler.ts` — the constructor gains `OutboundHttpClient`, and delivery goes through `OutboundHttpClient.post` instead of global `fetch`.
- `apps/api/src/webhook/webhook-delivery.handler.spec.ts` — the assertions that global `fetch` is called with the method, headers, signal and body, and that a non-ok response rejects with `Webhook delivery failed with status N`, are replaced by the invariant that `OutboundHttpClient.post` receives the same URL, the same three `X-Koda-*` headers plus `Content-Type`, and the same body, and that a `WebhookDeliveryError` from it propagates unchanged.
- `apps/api/src/webhook/webhook.module.ts` — registers `OutboundHttpClient` as a provider.
- `apps/api/src/webhook/webhook.module.spec.ts` — the invariant that `WebhookDeliveryHandler` resolves with only a mocked `PrismaWebhookRepository` becomes: it resolves with a mocked `PrismaWebhookRepository` and a mocked `OutboundHttpClient`.

### Seams

- US-002 runs the real `classifyAddress` and `IWebhookConfig` from US-001; a blocked verdict must surface as `blocked_destination` (US-002 AC 5).
- US-003 wires `OutboundUrlGuard.checkUrl` (US-002) into `POST /api/projects/:slug/webhooks` and `PATCH /api/projects/:slug/webhooks/:id`. The integration ACs enter at those routes with the real guard.
- US-004 wires `OutboundUrlGuard.assertStaticTarget` and `createLookup` (US-002) into delivery. The seam AC enters at `FanOutPublisher.publish` (the relay's call) with the real `WebhookOutboxSubscriber`, handler, client and guard.

## Acceptance Criteria

### US-001

1. [unit] A table-driven test over the Design blocked-range table: `classifyAddress(address, [])` returns `'blocked'` for every representative address in the table.
2. [unit] A table-driven test over the Design allowed edge addresses: `classifyAddress(address, [])` returns `'allowed'` for every one of them.
3. [unit] `classifyAddress('10.0.0.5', ['10.0.0.0/24'])` returns `'allowed'`, and `classifyAddress('10.0.1.5', ['10.0.0.0/24'])` returns `'blocked'`.
4. [unit] `classifyAddress('not-an-ip', [])` returns `'blocked'`.
5. [unit] `parseAllowedHosts(' Hooks.Internal. ,10.0.0.0/24,, fd00::/8 ')` returns `allowedHostnames` `['hooks.internal']` and `allowedCidrs` `['10.0.0.0/24', 'fd00::/8']`.
6. [unit] `parseAllowedHosts(undefined)` and `parseAllowedHosts('')` both return empty `allowedHostnames` and `allowedCidrs`.
7. [unit] `parseAllowedHosts('10.0.0.0/33')` throws an `Error` whose message contains `10.0.0.0/33`.
8. [unit] `parseAllowedHosts('bad_host!')` throws an `Error` whose message contains `bad_host!`.
9. [unit] `validate` from `env.validation.ts`, given the required variables plus `WEBHOOK_ALLOWED_HOSTS: '10.0.0.0/33'`, throws `ValidationAppException` whose `args` has a `WEBHOOK_ALLOWED_HOSTS` key.
10. [unit] `webhookConfig()` with `WEBHOOK_ALLOWED_HOSTS` unset returns `allowedHostnames: []`, `allowedCidrs: []` and `deliveryTimeoutMs: 5000`.
11. [unit] A testing module importing `ConfigModule.forRoot({ load: [webhookConfig], ignoreEnvFile: true })` and `ConfigBridgeModule`, with `WEBHOOK_ALLOWED_HOSTS` set to `hooks.internal`, resolves `WEBHOOK_CFG` to a config whose `allowedHostnames` is `['hooks.internal']`.

### US-002

1. [unit] `OutboundUrlGuard.checkUrl('http://hooks.example/x')` with empty allowlists rejects with `OutboundUrlRejection` whose `reason` is `'https_required'`.
2. [unit] `checkUrl('https://user:pw@hooks.example/')` rejects with reason `'credentials_not_allowed'`.
3. [unit] `checkUrl('ftp://hooks.example/')` rejects with reason `'scheme_not_allowed'`.
4. [unit] `checkUrl('not a url')` rejects with reason `'invalid_url'`.
5. [unit] `checkUrl('https://2130706433/hook')` (the decimal form of `127.0.0.1`) rejects with reason `'blocked_destination'`, and the `DnsResolver` stub is not called.
6. [unit] `checkUrl('https://[::ffff:127.0.0.1]/hook')` rejects with reason `'blocked_destination'`.
7. [unit] `checkUrl('https://hooks.example/')` with a `DnsResolver` stub returning `['93.184.215.14', '10.0.0.1']` rejects with reason `'blocked_destination'`.
8. [unit] `checkUrl('https://hooks.example/')` with a `DnsResolver` stub that throws an error with code `ENOTFOUND` rejects with reason `'unresolvable'`.
9. [unit] `checkUrl('https://hooks.example/')` with a `DnsResolver` stub returning `[]` rejects with reason `'unresolvable'`.
10. [unit] `checkUrl('https://hooks.example/hook')` with a `DnsResolver` stub returning `['93.184.215.14']` resolves, and the stub was called once with `'hooks.example'`.
11. [unit] `checkUrl('http://Hooks.Internal./hook')` with `allowedHostnames` `['hooks.internal']` resolves, and the `DnsResolver` stub is not called.
12. [unit] `checkUrl('http://10.0.0.5:8080/hook')` with `allowedCidrs` `['10.0.0.0/24']` resolves.
13. [unit] The function from `createLookup()`, called with `('rebind.example', { all: true }, callback)` and a `DnsResolver` stub returning `['127.0.0.1']`, calls `callback` with an error whose `code` is `'EBLOCKED_DESTINATION'`.
14. [unit] The function from `createLookup()`, called with `('hooks.example', { all: true }, callback)` and a stub returning `['93.184.215.14']`, calls `callback(null, [{ address: '93.184.215.14', family: 4 }])`.
15. [unit] The function from `createLookup()`, called with `('hooks.internal', { all: true }, callback)`, `allowedHostnames` `['hooks.internal']` and a stub returning `['10.0.0.7']`, calls `callback(null, [{ address: '10.0.0.7', family: 4 }])`.

### US-003

1. [unit] `WebhookService.create` with an `OutboundUrlGuard` stub whose `checkUrl` rejects with `OutboundUrlRejection('blocked_destination')` throws `ValidationAppException` whose `args` is `{ reason: 'blocked_destination' }`, and `PrismaWebhookRepository.createWebhook` is not called.
2. [unit] `WebhookService.create` with a guard stub that resolves calls `createWebhook` once with the given `url`.
3. [unit] `WebhookService.update('p1', 'w1', { url: 'https://hooks.example/new' })` for a webhook in project `p1` calls `checkUrl('https://hooks.example/new')` before `PrismaWebhookRepository.update`.
4. [unit] `WebhookService.update('p1', 'w1', { active: false })` does not call `checkUrl` and calls `PrismaWebhookRepository.update('w1', { active: false })`.
5. [unit] `WebhookService.update('p1', 'w1', { events: ['STATUS_CHANGE'] })` calls `PrismaWebhookRepository.update('w1', { events: '["STATUS_CHANGE"]' })`.
6. [unit] `WebhookService.update('p1', 'w1', ...)` for a webhook whose `projectId` is `p2` throws `NotFoundAppException` and does not call `PrismaWebhookRepository.update`.
7. [unit] `WebhookService.update` for an id that `findById` does not find throws `NotFoundAppException`.
8. [unit] `WebhookService.update` returns an object with `id`, `projectId`, `url`, `events`, `active` and `createdAt`, and no `secret` property.
9. [integration] `POST /api/projects/:slug/webhooks` as a global ADMIN with `url` `https://10.0.0.5/hook` returns 400, and no webhook row exists for the project afterwards.
10. [integration] `POST /api/projects/:slug/webhooks` as a global ADMIN with `url` `https://93.184.215.14/hook` returns 201.
11. [integration] `PATCH /api/projects/:slug/webhooks/:id` as a global ADMIN with `{ "url": "http://93.184.215.14/hook" }` returns 400, and the stored `url` is unchanged.
12. [integration] `PATCH /api/projects/:slug/webhooks/:id` as a global ADMIN with `{ "active": false }` returns 200 with `data.active` false and no `data.secret`.
13. [integration] `PATCH /api/projects/:slug/webhooks/:id` by a user who is not a global ADMIN returns 403.
14. [integration] `PATCH /api/projects/:slug/webhooks/:id` with the id of a webhook in another project returns 404.
15. [unit] Translating `webhooks.-2` with args `{ reason: 'blocked_destination' }` through the real i18n runtime (`I18nCoreModule` over `src/i18n`, as in `test/unit/i18n/projects-translation-keys.spec.ts`) returns, in both `en` and `zh`, a string that differs from the key and contains `blocked_destination`.

### US-004

1. [integration] `OutboundHttpClient.post` to `http://allowed.test:<port>/hook` (local HTTP server on 127.0.0.1, no database), with `allowedHostnames` `['allowed.test']` and a `DnsResolver` stub returning `['127.0.0.1']`, delivers one POST whose body and headers equal the arguments, and resolves when the server answers 204.
2. [integration] `post` to `https://rebind.test:<port>/hook` with empty allowlists and a `DnsResolver` stub returning `['127.0.0.1']` rejects with `WebhookDeliveryError` whose `message` is `'blocked_destination'`, and the local server receives no request.
3. [integration] `post` to `https://127.0.0.1:<port>/hook` with empty allowlists rejects with message `'blocked_destination'`, the `DnsResolver` stub is not called, and the local server receives no request.
4. [integration] `post` to an allow-listed URL whose server answers 302 with `Location: /elsewhere` rejects with message `'redirect_refused'`, and the server receives exactly one request.
5. [integration] `post` to an allow-listed URL whose server answers 404 rejects with message `'http_4xx'`.
6. [integration] `post` to an allow-listed URL whose server answers 503 rejects with message `'http_5xx'`.
7. [integration] `post` to an allow-listed URL whose server never answers, with `deliveryTimeoutMs` 200, rejects with message `'timeout'` in under 1000 ms.
8. [integration] `post` to an allow-listed URL on a port with no listener rejects with message `'connect_failed'`.
9. [integration] `post` to an allow-listed hostname whose `DnsResolver` stub throws an error with code `ENOTFOUND` rejects with message `'connect_failed'`.
10. [integration] When `post` fails with `'connect_failed'`, `Logger.warn` is called once with text containing the raw error code (`ECONNREFUSED`) and `allowed.test`.
11. [unit] `WebhookDeliveryHandler.handle` for an active webhook calls `OutboundHttpClient.post` once with the webhook's `url`, a body equal to `JSON.stringify(payload)`, and headers `Content-Type: application/json`, `X-Koda-Event`, `X-Koda-Signature: sha256=<hmac of the body>` and `X-Koda-Delivery-Id`.
12. [unit] `WebhookDeliveryHandler.handle` never calls `globalThis.fetch`.
13. [unit] `WebhookDeliveryHandler.handle` for a missing or inactive webhook does not call `OutboundHttpClient.post`.
14. [integration] `FanOutPublisher.publish` of a `webhook_delivery` record, with the real `WebhookOutboxSubscriber`, `WebhookDeliveryHandler`, `OutboundHttpClient` and `OutboundUrlGuard`, a webhook whose `url` is `https://rebind.test/hook` and a `DnsResolver` stub returning `['127.0.0.1']`, rejects, and `recordLastError` is called with the outbox record id and exactly `1 fan-out handler(s) failed for webhook_delivery: blocked_destination`.
