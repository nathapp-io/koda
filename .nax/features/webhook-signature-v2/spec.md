# SPEC: Webhook signature v2 (signed timestamp and delivery id, outbound and inbound CI)

## Summary

This feature implements owner ruling 21 of 2026-11-19 on the 2026-11-14 whole-repo review
(`docs/20261114-review-whole-repo.md`, "Rulings needed", item 21, findings C/SEC-3 and C/SEC-4).

1. **Outbound (C/SEC-4).** Every koda webhook delivery carries a v2 signature that binds the body to a send time and to
   the delivery id: `X-Koda-Timestamp` (Unix seconds) and `X-Koda-Signature-V2`, an HMAC-SHA256 over
   `<timestamp>.<deliveryId>.<body>`. The v1 body-only `X-Koda-Signature` is still sent alongside it during a
   deprecation window.
2. **Inbound CI (C/SEC-3).** `POST /projects/:slug/ci-webhook` accepts the same signed-timestamp form: `X-CI-Timestamp`
   plus `X-CI-Signature-V2` over `<timestamp>.<X-CI-Delivery>.<body>`, with a 300-second tolerance. When the v2 header
   is present it alone decides. The v1 body-only signature stays accepted during the window.
3. **The window ends by deployment switch.** `WEBHOOK_SIGNATURE_V1_ENABLED=false` stops sending v1 outbound, and
   `CI_WEBHOOK_REQUIRE_V2=true` makes the CI route refuse a delivery without v2. Both default to the window being open.
4. **Receiver docs.** A new page `docs/deployment/webhooks.md` documents both schemes for operators and receivers.

Rulings 2 (docs line, done by hand on this branch), 3, 5, 10 and 17-20 were delivered in `review-1119-fleet-rulings`
(#481) and `review-1119-data-rulings` (#482). Ruling 23 waits for the production deployment decision.

## Motivation

- **Outbound replay.** `WebhookDeliveryHandler.handle` signs only the body (`webhook/webhook-delivery.handler.ts`). A
  captured delivery can be re-sent to the receiver at any time and still verifies. The delivery id is a content hash, so
  a receiver can block a replay only by storing every id forever. Nothing in the signed bytes binds the message to a time.
- **Inbound CI replay.** `CiWebhookController.handleCiWebhook` checks an HMAC over the body only
  (`ci-webhook/ci-webhook.controller.ts`). `X-CI-Delivery` and `Date` are unsigned, so the replay guard's 5-minute
  `Date` window is best effort: an attacker can rewrite both headers on a captured body. Since ruling 10 the
  `WebhookDelivery` dedupe row is purged after 30 days, so a captured body with a fresh delivery id and `Date` replays.
  A signed timestamp makes the freshness window enforceable and the delivery id tamper-evident.
- **Owner rulings (2026-11-19).** v2 signs timestamp + delivery id + body under a new header, v1 is sent alongside during
  a deprecation window, inbound CI accepts the same form. The window ends through environment switches (outbound v1
  off, inbound v2 required). When a CI delivery carries `X-CI-Signature-V2`, a failing v2 is refused even when v1
  verifies. The CLI is unchanged. Receiver docs go in `docs/deployment/webhooks.md`.

## Design

### Calls made in this spec

- **Signed string.** `<timestamp>.<deliveryId>.<body>`, joined with `.`, where `<timestamp>` is the header's text
  exactly as sent, `<deliveryId>` is the delivery id header's text and `<body>` is the raw request body. The signature
  header value has the v1 shape `sha256=<lower-case hex>`.
- **Timestamp.** Decimal Unix seconds, 1 to 12 digits, no sign, no fraction. Fresh means the absolute difference between
  now and the timestamp is at most 300 seconds (`WEBHOOK_TIMESTAMP_TOLERANCE_SEC`), in both directions. Not configurable.
- **Outbound timestamp per attempt.** The handler stamps the time of each send as `Math.floor(Date.now() / 1000)`, so an outbox retry carries a fresh
  timestamp and passes a receiver's tolerance. `X-Koda-Delivery-Id` keeps its content-hash derivation, so a retry keeps
  the same id for receiver dedupe.
- **Inbound decision order** (after the project lookup, before payload validation):
  1. `x-ci-signature-v2` present (any value, including empty): verify v2 only. `x-ci-delivery` and `x-ci-timestamp` must
     both be present, the timestamp must be fresh and the v2 HMAC must match; otherwise 401. The v1 header is ignored.
  2. `x-ci-signature-v2` absent and `ciRequireV2` true: 401.
  3. Otherwise: verify v1 exactly as today.

  Every refusal is the existing `AuthException({}, 'ci_webhook')`, the same 401 as an unknown slug or a bad signature,
  so the route reveals neither which slugs exist nor which check failed. A refusal happens before
  `WebhookReplayGuard.assertFresh`, so a refused delivery does not consume its delivery id. The guard's `Date` window
  and delivery-id dedupe are unchanged.
- **Switches.** `WEBHOOK_SIGNATURE_V1_ENABLED` (boolean, default `true`) and `CI_WEBHOOK_REQUIRE_V2` (boolean, default
  `false`). Both are validated in `config/env.validation.ts` with the `Joi.boolean().truthy('true').falsy('false')`
  shape `OUTBOX_RELAY_ENABLED` uses. Joi's boolean match is case-insensitive, so the factory mirrors
  `config/outbox.config.ts`: a `validateUtil` schema with `@Matches(/^(true|false)$/i)` and a lower-cased comparison, so
  `TRUE` and `FALSE` take effect instead of booting clean and being ignored. Unlike retention, the defaults do not
  depend on `NODE_ENV`.
- **Config shape.** A new registered config `WEBHOOK_SIGNATURE_CFG` (`config/webhook-signature.config.ts`), read with
  `ConfigService.get`, like `RETENTION_CFG`. It is separate from `IWebhookConfig` so the many typed `IWebhookConfig`
  test literals keep compiling. When `ConfigService.get` answers `undefined` (a test module that does not load it),
  consumers use the defaults: v1 sent, v2 not required. Test stubs of `ConfigService.get` answer the signature config
  only for the key `WEBHOOK_SIGNATURE_CFG` and `undefined` for any other key, so reading the wrong key fails a test.
- **OpenAPI.** The CI route documents `x-ci-timestamp`, `x-ci-signature-v2` and `x-ci-signature` as optional header
  parameters (`required: false`), each appearing once. A v2-only sender omits `x-ci-signature`. Declare each with
  `@ApiHeader({ name, required: false, description })` on the handler, name in lower case exactly as the `@Headers`
  parameter: `@nestjs/swagger` 12 merges an explicit header into the reflected parameter of the same name and `in`
  (`dist/explorers/api-parameters.explorer.js`), so the explicit `required: false` wins and nothing is duplicated.

### Integration

Read-only (verified at main `c11e85292`):

- `WebhookReplayGuard.assertFresh(input: ReplayCheckInput): Promise<void>` and `forget(input)`,
  `webhook-security/webhook-replay.guard.ts`. Unchanged.
- `signedBytesOf(request: InboundWebhookRequest): string`, `webhook-security/inbound-webhook-request.ts`: the raw body
  bytes the sender signed. Used unchanged as `<body>` for v2.
- `OutboundHttpClient.post(url, headers, body)`, `webhook/outbound/outbound-http-client.ts`. Unchanged.
- `retentionConfig` / `RETENTION_CFG`, `config/retention.config.ts`: the pattern for a registered config read through
  `ConfigService.get`, loaded in `app.module.ts`'s `ConfigModule.forRoot({ load: [...] })` array.
- `ApiHeader({ name, required: false, description })` precedent in `approvals/route/approval-gated.decorator.ts`.
- `bootHttpApp` (`test/helpers/http-app.ts`) and the raw-body delivery helper in
  `test/integration/audit/audit-ci-webhook.integration.spec.ts`; `SwaggerModule.createDocument` usage in
  `test/integration/permissions/roles-api.integration.spec.ts`.

Changed. Each **Baseline** exists only to locate the code; it is never the interface to implement.

- `WebhookDeliveryHandler` (`webhook/webhook-delivery.handler.ts`)
  - Baseline: `constructor(webhookRepo: PrismaWebhookRepository, http: OutboundHttpClient)`; `handle` sends
    `Content-Type`, `X-Koda-Signature`, `X-Koda-Event`, `X-Koda-Delivery-Id`.
  - Target: `constructor(webhookRepo: PrismaWebhookRepository, http: OutboundHttpClient, config: ConfigService)`;
    `handle` also sends `X-Koda-Timestamp` and `X-Koda-Signature-V2`, and sends `X-Koda-Signature` only when
    `v1Enabled` is true.
- `CiWebhookController` (`ci-webhook/ci-webhook.controller.ts`)
  - Baseline: `constructor(ciWebhookService, replayGuard)`; `handleCiWebhook(slug, request, signature?, deliveryId?,
    dateHeader?)`; private `verifySignature(payload, signature, secret)`.
  - Target: `constructor(ciWebhookService, replayGuard, config: ConfigService)`; `handleCiWebhook(slug, request,
    signature?, deliveryId?, dateHeader?, timestamp?, signatureV2?)`, the two new parameters read `x-ci-timestamp` and
    `x-ci-signature-v2`. The existing positional parameters keep their order, so existing calls stay valid. Signature
    checks go through `webhook-security/webhook-signature.ts`.

New (US-001, US-002):

```ts
// webhook-security/webhook-signature.ts
export const WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;
export function signatureV1(secret: string, body: string): string;                       // 'sha256=<hex>'
export function signatureV2(secret: string, timestamp: string, deliveryId: string, body: string): string;
export function signaturesMatch(expected: string, received: string): boolean;            // timing-safe, false on length mismatch
export function isFreshTimestamp(timestamp: string, nowMs: number): boolean;

// config/webhook-signature.config.ts
export const WEBHOOK_SIGNATURE_CFG = 'webhookSignature';
export interface IWebhookSignatureConfig { v1Enabled: boolean; ciRequireV2: boolean }
export const webhookSignatureConfig: ConfigFactory<IWebhookSignatureConfig>; // registerAs(WEBHOOK_SIGNATURE_CFG, ...)
```

### Failure Handling

| Case | Behaviour |
|---|---|
| CI: `x-ci-signature-v2` present, HMAC does not match | 401 `ci_webhook`, even when `x-ci-signature` verifies |
| CI: v2 present, `x-ci-timestamp` absent | 401 `ci_webhook` |
| CI: v2 present, timestamp not 1-12 digits | 401 `ci_webhook` |
| CI: v2 present, timestamp more than 300 s old or ahead | 401 `ci_webhook` |
| CI: v2 present, `x-ci-delivery` absent | 401 `ci_webhook` |
| CI: v2 absent, `CI_WEBHOOK_REQUIRE_V2=true` | 401 `ci_webhook`, even when `x-ci-signature` verifies |
| CI: any signature refusal | replay guard not called, delivery id not recorded |
| `ConfigService.get(WEBHOOK_SIGNATURE_CFG)` answers `undefined` | defaults: v1 sent outbound, v2 not required inbound |
| Invalid switch value at boot (`CI_WEBHOOK_REQUIRE_V2=yes`) | environment validation fails, the API does not boot |
| CI: `x-ci-signature-v2` present but empty | 401 `ci_webhook`, even when `x-ci-signature` verifies |
| CI: v2 signed over a different delivery id than the sent `x-ci-delivery` | 401 `ci_webhook` |

## Out of Scope

- The CLI `koda ci-webhook trigger` command keeps forwarding a caller-supplied v1 `x-ci-signature`; signing v2 in the CLI is a later change.
- Deleting the v1 code paths: the deprecation window ends through the two environment switches; removing v1 is a later feature.
- A configurable timestamp tolerance: it is fixed at 300 seconds.
- Secret rotation or several active secrets per webhook or per project.
- GitHub VCS webhooks (`POST /projects/:slug/vcs-webhook`), which use GitHub's own `X-Hub-Signature-256`.
- Per-project or per-webhook signature switches: both switches are deployment-wide.
- Changing `WebhookReplayGuard`: its `Date` window and delivery-id dedupe stay as they are.
- US-004 only: a fresh, valid v2 delivery replayed inside the 300-second window is refused by `WebhookReplayGuard`'s existing delivery-id record, unchanged.
- Downgrade by stripping `x-ci-signature-v2` while `CI_WEBHOOK_REQUIRE_V2` is false: the remaining v1 signature is accepted for the deprecation window, so the replay protection applies once `CI_WEBHOOK_REQUIRE_V2=true` (documented in US-006).
- Restricting the characters of a delivery id: the timestamp is digits only, so the first `.` after it is unambiguous, and koda's own bodies are JSON objects.
- Changing the OpenAPI documentation of `x-ci-delivery` and `date`, which stay documented as required.
- Changing how `X-Koda-Delivery-Id` is derived (it stays a content hash, stable across retries).
- Receiver-side verification code: koda only documents the scheme.

## Stories

Six stories: two shared primitives, one outbound, two inbound (controller checks, then the route contract), and the docs.

**US-001: Signature primitives.** Workdir: `apps/api`. No dependencies.
The pure signing and freshness functions in `webhook-security/webhook-signature.ts`, used by both sides.

**US-002: Signature switches config.** Workdir: `apps/api`. No dependencies.
`WEBHOOK_SIGNATURE_CFG` with the two environment switches, their case-insensitive parse, validation and app wiring.

**US-003: Outbound v2 signature.** Workdir: `apps/api`. Depends on US-001, US-002.
`WebhookDeliveryHandler.handle` sends `X-Koda-Timestamp` and `X-Koda-Signature-V2`, and v1 only while enabled.

**US-004: Inbound CI v2 verification.** Workdir: `apps/api`. Depends on US-001, US-002.
`CiWebhookController.handleCiWebhook` verifies v2 when the header is present, refuses v1-only when required, and refuses
before the replay guard.

**US-005: CI webhook route contract.** Workdir: `apps/api`. Depends on US-004.
The HTTP route accepts a v2-only delivery end to end, and the OpenAPI document lists the three signature headers as
optional; `openapi.json` and the CLI client are regenerated.

**US-006: Receiver docs.** Workdir: `.`. Depends on US-003, US-005.
**No-test:** documentation only. New page `docs/deployment/webhooks.md`.

### Context Files

**US-001**
- `apps/api/src/ci-webhook/ci-webhook.controller.ts`
- `apps/api/src/webhook/webhook-delivery.handler.ts`
- `apps/api/src/webhook-security/inbound-webhook-request.ts`

**US-002**
- `apps/api/src/config/retention.config.ts`
- `apps/api/src/config/outbox.config.ts`
- `apps/api/src/config/env.validation.ts`
- `apps/api/src/app.module.ts`
- `apps/api/test/helpers/http-app.ts`

**US-003**
- `apps/api/src/webhook/webhook-delivery.handler.ts`
- `apps/api/src/webhook/webhook.module.ts`
- `apps/api/src/webhook-security/webhook-signature.ts` — created by US-001, used here
- `apps/api/src/config/webhook-signature.config.ts` — created by US-002, used here

**US-004**
- `apps/api/src/ci-webhook/ci-webhook.controller.ts`
- `apps/api/src/webhook-security/webhook-replay.guard.ts`
- `apps/api/src/webhook-security/webhook-signature.ts` — created by US-001, used here
- `apps/api/src/config/webhook-signature.config.ts` — created by US-002, used here

**US-005**
- `apps/api/src/ci-webhook/ci-webhook.controller.ts`
- `apps/api/src/approvals/route/approval-gated.decorator.ts`
- `apps/api/src/approvals/approval-openapi.contract.spec.ts`
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts`
- `apps/api/test/integration/audit/audit-ci-webhook.integration.spec.ts`

**US-006**
- `docs/deployment/gitlab.md`
- `apps/api/src/ci-webhook/ci-webhook.controller.ts`
- `apps/api/src/webhook/webhook-delivery.handler.ts`

### Creates

**US-001**
- `apps/api/src/webhook-security/webhook-signature.ts`
- `apps/api/src/webhook-security/webhook-signature.spec.ts`

**US-002**
- `apps/api/src/config/webhook-signature.config.ts`
- `apps/api/src/config/webhook-signature.config.spec.ts`
- `apps/api/test/integration/config/webhook-signature-config.integration.spec.ts`

**US-005**
- `apps/api/src/ci-webhook/ci-webhook-openapi.contract.spec.ts`
- `apps/api/test/integration/ci-webhook/ci-webhook-signature-v2.integration.spec.ts`

**US-006**
- `docs/deployment/webhooks.md`

### Modifies

US-001, US-002 and US-006 change no existing test.

**US-003**
- `apps/api/src/webhook/webhook-delivery.handler.spec.ts` — its `new WebhookDeliveryHandler(webhookRepo, http)` factory gains a third `ConfigService` stub argument whose `get` answers the signature config only for `WEBHOOK_SIGNATURE_CFG` (default `undefined`, so v1 stays on), and its exact `expect(headers).toEqual({...})` header set gains `X-Koda-Timestamp` and `X-Koda-Signature-V2`; the invariant that replaces it is the six-header set of US-003 AC-9.
- `apps/api/src/webhook/webhook-delivery.seam.spec.ts` — its `new WebhookDeliveryHandler(makeWebhookRepo(url), client)` construction gains a third `ConfigService` stub argument answering `undefined`; its transport assertions are unchanged.

**US-004**
- `apps/api/src/ci-webhook/ci-webhook.controller.spec.ts` — its `Test.createTestingModule` providers list has no `ConfigService`; it gains a `ConfigService` stub whose `get` answers `undefined` by default (v1 accepted, v2 not required) and answers the signature config only for the key `WEBHOOK_SIGNATURE_CFG` in the switch cases; its existing v1 cases keep passing unchanged.

**US-005**
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — the api-testing rule requires endpoint changes to be reflected here; its CI webhook block gains a v2-only delivery case answering 200 next to the existing v1 cases, which keep passing unchanged.
- `openapi.json` — the CI webhook operation (POST on the project ci-webhook path) gains optional `x-ci-timestamp` and `x-ci-signature-v2` header parameters and `x-ci-signature` becomes optional; regenerate with `bun run generate` from the repo root, never hand-edit.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` for the same header changes on the CI webhook operation's data type; never hand-edited.

### Seams

- US-003, US-004 and US-005 consume `signatureV2`, `signaturesMatch` and `isFreshTimestamp` (US-001). US-003 AC-2, US-004
  AC-1 and AC-12 and US-005 AC-1 recompute the expected v2 HMAC independently and drive the production entry point (`handle`,
  `handleCiWebhook`, and the HTTP route through `bootHttpApp`), which proves each call site exists and is wired.
- US-003 and US-004 consume `WEBHOOK_SIGNATURE_CFG` (US-002) through `ConfigService.get`. US-002 AC-8 pins that the
  booted app resolves it; US-003 AC-4 and US-004 AC-9 pin that each consumer reads it under that key.

## Acceptance Criteria

### US-001

- AC-1 [unit] `signatureV1('s3cret', '{"a":1}')` returns `sha256=` followed by the lower-case hex HMAC-SHA256 of `{"a":1}` keyed by `s3cret`.
- AC-2 [unit] `signatureV2('s3cret', '1700000000', 'd-1', '{"a":1}')` returns `sha256=` followed by the lower-case hex HMAC-SHA256 of `1700000000.d-1.{"a":1}` keyed by `s3cret`.
- AC-3 [unit] `signatureV2` with delivery id `d-2` and otherwise the AC-2 inputs returns a value different from the AC-2 result.
- AC-4 [unit] `signaturesMatch(x, x)` for an equal `sha256=` string returns `true`.
- AC-5 [unit] `signaturesMatch('sha256=abc', 'sha256=ab')` returns `false` without throwing.
- AC-6 [unit] `signaturesMatch('sha256=abc', 'sha256=abd')` returns `false`.
- AC-7 [unit] `isFreshTimestamp(String(nowSec - 300), nowSec * 1000)` returns `true`.
- AC-8 [unit] `isFreshTimestamp(String(nowSec + 300), nowSec * 1000)` returns `true`.
- AC-9 [unit] `isFreshTimestamp(String(nowSec - 301), nowSec * 1000)` returns `false`.
- AC-10 [unit] `isFreshTimestamp(String(nowSec + 301), nowSec * 1000)` returns `false`.
- AC-11 [unit] `isFreshTimestamp('1700000000.5', 1700000000000)` returns `false`.
- AC-12 [unit] `isFreshTimestamp('', 1700000000000)` returns `false`.
- AC-13 [unit] `isFreshTimestamp('+1700000000', 1700000000000)` returns `false`.
- AC-14 [unit] `isFreshTimestamp('1700000000000', 1700000000000)` (13 digits) returns `false`.

### US-002

- AC-1 [unit] `webhookSignatureConfig()` with neither `WEBHOOK_SIGNATURE_V1_ENABLED` nor `CI_WEBHOOK_REQUIRE_V2` set resolves `v1Enabled` `true`.
- AC-2 [unit] In the AC-1 setup, `webhookSignatureConfig()` resolves `ciRequireV2` `false`.
- AC-3 [unit] `webhookSignatureConfig()` with `WEBHOOK_SIGNATURE_V1_ENABLED=false` resolves `v1Enabled` `false`.
- AC-4 [unit] `webhookSignatureConfig()` with `WEBHOOK_SIGNATURE_V1_ENABLED=FALSE` resolves `v1Enabled` `false`.
- AC-5 [unit] `webhookSignatureConfig()` with `CI_WEBHOOK_REQUIRE_V2=true` resolves `ciRequireV2` `true`.
- AC-6 [unit] `webhookSignatureConfig()` with `CI_WEBHOOK_REQUIRE_V2=TRUE` resolves `ciRequireV2` `true`.
- AC-7 [unit] The environment validation `validate()` given an otherwise valid environment with `CI_WEBHOOK_REQUIRE_V2=yes` throws a `ValidationAppException` naming `CI_WEBHOOK_REQUIRE_V2`.
- AC-8 [integration] The application booted by the `bootHttpApp` test helper answers `ConfigService.get(WEBHOOK_SIGNATURE_CFG)` with `{ v1Enabled: true, ciRequireV2: false }`.

### US-003

- AC-1 [unit] `WebhookDeliveryHandler.handle` with the clock at `2026-11-19T12:00:00Z` posts an `X-Koda-Timestamp` header of `1795089600`.
- AC-2 [unit] `handle` posts an `X-Koda-Signature-V2` equal to `sha256=` plus the hex HMAC-SHA256, keyed by the webhook secret, of the posted `X-Koda-Timestamp` value, `.`, the posted `X-Koda-Delivery-Id` value, `.`, and the posted body.
- AC-3 [unit] `handle` with `ConfigService.get(WEBHOOK_SIGNATURE_CFG)` answering `{ v1Enabled: true, ciRequireV2: false }` posts `X-Koda-Signature` equal to `sha256=` plus the hex HMAC-SHA256 of the body.
- AC-4 [unit] `handle` with `ConfigService.get` answering `{ v1Enabled: false, ciRequireV2: false }` for the key `WEBHOOK_SIGNATURE_CFG` (and `undefined` for any other key) posts no `X-Koda-Signature` header.
- AC-5 [unit] In the AC-4 setup, `handle` still posts `X-Koda-Signature-V2`.
- AC-6 [unit] `handle` with `ConfigService.get(WEBHOOK_SIGNATURE_CFG)` answering `undefined` posts `X-Koda-Signature`.
- AC-7 [unit] Two `handle` calls with the same webhook, event and payload, 100 seconds apart, post the same `X-Koda-Delivery-Id`.
- AC-8 [unit] In the AC-7 case, the two calls post `X-Koda-Timestamp` values 100 apart.
- AC-9 [unit] With the default config, `handle` posts exactly the headers `Content-Type`, `X-Koda-Event`, `X-Koda-Delivery-Id`, `X-Koda-Signature`, `X-Koda-Timestamp` and `X-Koda-Signature-V2`.

### US-004

- AC-1 [unit] `CiWebhookController.handleCiWebhook` with a fresh `x-ci-timestamp`, an `x-ci-delivery`, a matching `x-ci-signature-v2` and no `x-ci-signature` calls `CiWebhookService.processCiWebhook` with the validated payload.
- AC-2 [unit] `handleCiWebhook` with `ConfigService.get` answering `{ v1Enabled: true, ciRequireV2: true }` for the key `WEBHOOK_SIGNATURE_CFG`, a matching v2 signature and a wrong `x-ci-signature` calls `processCiWebhook`.
- AC-3 [unit] `handleCiWebhook` with an `x-ci-signature-v2` computed under a different secret than the project's CI token, and a valid `x-ci-signature`, rejects with the same `AuthException` 401 as a bad v1 signature.
- AC-4 [unit] `handleCiWebhook` with a matching v2 signature over an `x-ci-timestamp` 301 seconds in the past rejects with the 401 `AuthException`.
- AC-5 [unit] `handleCiWebhook` with a matching v2 signature over an `x-ci-timestamp` 301 seconds in the future rejects with the 401 `AuthException`.
- AC-6 [unit] `handleCiWebhook` with `x-ci-timestamp` `abc` and an `x-ci-signature-v2` computed over it rejects with the 401 `AuthException`.
- AC-7 [unit] `handleCiWebhook` with `x-ci-signature-v2` present and `x-ci-delivery` absent rejects with the 401 `AuthException`.
- AC-8 [unit] `handleCiWebhook` with `x-ci-signature-v2` present and `x-ci-timestamp` absent rejects with the 401 `AuthException`.
- AC-9 [unit] `handleCiWebhook` with `ConfigService.get` answering `{ v1Enabled: true, ciRequireV2: true }` for the key `WEBHOOK_SIGNATURE_CFG`, a valid `x-ci-signature` and no `x-ci-signature-v2` rejects with the 401 `AuthException`.
- AC-10 [unit] `handleCiWebhook` with `ConfigService.get(WEBHOOK_SIGNATURE_CFG)` answering `undefined`, a valid `x-ci-signature` and no `x-ci-signature-v2` calls `processCiWebhook`.
- AC-11 [unit] `handleCiWebhook` with an empty `x-ci-signature-v2` and a valid `x-ci-signature` rejects with the 401 `AuthException`.
- AC-12 [unit] `handleCiWebhook` with an `x-ci-signature-v2` computed over delivery id `d-1` but sent with `x-ci-delivery` `d-2` rejects with the 401 `AuthException`.
- AC-13 [unit] In the AC-3 case, `WebhookReplayGuard.assertFresh` is not called.
- AC-14 [unit] In the AC-9 case, `WebhookReplayGuard.assertFresh` is not called.

### US-005

- AC-1 [integration] `POST /api/projects/:slug/ci-webhook` on the app booted by `bootHttpApp`, with the raw JSON body signed as v2 under the project's `ciWebhookToken`, a fresh `x-ci-timestamp`, an `x-ci-delivery` and no `x-ci-signature`, answers 200.
- AC-2 [integration] The same route, with a v2 signature computed over a different delivery id than the sent `x-ci-delivery`, answers 401.
- AC-3 [unit] In the committed `openapi.json`, read DB-free as `approvals/approval-openapi.contract.spec.ts` reads it, the `post` operation of `/api/projects/{slug}/ci-webhook` has exactly one `x-ci-signature-v2` header parameter, with `required` `false`.
- AC-4 [unit] In the AC-3 document, that operation has exactly one `x-ci-timestamp` header parameter, with `required` `false`.
- AC-5 [unit] In the AC-3 document, that operation has exactly one `x-ci-signature` header parameter, with `required` `false`.

### US-006

**No-test:** documentation only.

- AC-1 [review] `docs/deployment/webhooks.md`, section "Outbound webhooks", names the headers `X-Koda-Timestamp`, `X-Koda-Signature-V2`, `X-Koda-Signature`, `X-Koda-Delivery-Id` and `X-Koda-Event`.
- AC-2 [review] The same section gives the v2 signed string as `<timestamp>.<deliveryId>.<body>` and the header value form `sha256=<hex>`.
- AC-3 [review] The same section tells receivers to refuse a timestamp more than 300 seconds from their clock and to dedupe on `X-Koda-Delivery-Id`, which is stable across retries.
- AC-4 [review] Section "Inbound CI webhook" names `X-CI-Timestamp`, `X-CI-Signature-V2`, `X-CI-Delivery` and `X-CI-Signature`, and gives the signed string `<timestamp>.<X-CI-Delivery>.<body>`.
- AC-5 [review] The same section states that a present `X-CI-Signature-V2` alone decides, so a failing v2 is refused even when v1 verifies.
- AC-6 [review] Section "Deprecation window" names `WEBHOOK_SIGNATURE_V1_ENABLED` (default `true`) and `CI_WEBHOOK_REQUIRE_V2` (default `false`) and what each does when switched.
- AC-7 [review] The same section states that while `CI_WEBHOOK_REQUIRE_V2` is false a captured delivery with its v2 header stripped is still accepted on v1, so operators turn it on once every CI sender sends v2.
