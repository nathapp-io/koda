# SPEC: Web session expiry and CLI credential, ticket and login behavior

## Summary

Restore protected-page access across token rotation, scope CLI logout to the credential and deployment selected for the command, apply project ticket defaults, and give CLI login an actionable diagnostic for an API rejection. Findings 11–14 and the verification controls are recorded in [the review of 37b396c49](../../../docs/20261120-review-37b396c49.md).

## Motivation

A five-minute access JWT still has a browser cookie at minute six. On a fresh HTML request the presence of that cookie prevents SSR refresh, and the identity check redirects the user to login. A refresh JWT valid for fourteen days disappears from the browser after seven. These are supported API settings.

In the CLI, a successful logout with deployment B’s temporary token erases deployment A’s global key. Initializing a project with TASK/HIGH still requires an explicit type to create a ticket and omits HIGH from the request. Login with an invalid key prints `Could not reach API: [object Object]` for a response the API actually delivered.

## Design

### Integration

- The API signs each access and refresh JWT with its own NumericDate `exp` using the configured lifetimes in `apps/api/src/config/auth.config.ts` and `apps/api/src/auth/auth.module.ts`. At the existing common `setAuthCookies` entry point, decode the base64url payload of each token independently and accept a finite numeric expiry and compute max(0, floor(exp − serverTimeMs / 1000)). Treat an absent or nonnumeric expiry as unavailable. Use a nonnegative Max-Age capped at the remaining lifetime. Decoding is only a scheduling hint. Identity and refresh decisions still require the existing upstream endpoints. Preserve the cookie names, path, httpOnly, secure and each sameSite value. A missing token still produces no write for that cookie. For compatibility with an opaque or malformed token whose expiry is unavailable, retain the existing fallback age for that cookie (900 or 604800 seconds). An opaque access cookie remains present for SSR eligibility.
- Already-issued cookies may have the old Max-Age. On the existing eligible HTML GET path, consider an access cookie with a decodable expired JWT equivalent to an absent access cookie for refresh scheduling. Keep the existing request exclusions, refresh-cookie requirement, one upstream refresh call and request-cookie replacement before SSR. The original age of a refresh cookie that the browser has already discarded cannot be extended retroactively.
- `resolveContext` resolves key and endpoint independently. Record the key’s winning source (flag, environment, selected named profile, or global) at resolution time. A stored key’s owning endpoint is the API base URL recorded with that entry, with the existing default base URL for a global config lacking a URL. A selected stored profile without a usable owning URL cannot establish ownership and stays untouched. Compare full normalized API bases, retaining path prefixes and nondefault ports, allowing equivalent trailing slashes and the optional trailing `/api` used by the client. In-memory flag/environment credentials own no persistent entry. Keep project-local key and endpoint fields excluded from resolution.
- Following successful `authControllerLogout()`, clear only an eligible stored entry whose source, key value and owning endpoint match the credential actually used. Recheck current stored value and endpoint before the edit so a replacement saved during the request survives. Clear a selected profile’s key to an empty string and retain its endpoint and name, so a later request with that profile selected cannot fall through to the global key. Preserve unrelated entries and the global URL. On endpoint mismatch or for a transient credential, skip local mutation. Describe acceptance of the logout request and the actual local action in human output and help. Leave the extent of server-side revocation to the API, including its legacy fallback. JSON success retains `{success:true}`.
- Expose the nearest project config’s optional ticket defaults through the same context lookup used by ticket creation. Resolve each field independently using the explicit flag first, then that field’s project default. Run existing type/priority validation on the effective values and send those validated values through `ticketsControllerCreate`. Keep the existing missing-title and missing-type validation when no usable value is supplied. An absent priority leaves it unspecified for the API. Existing configs without defaults remain supported.
- `agentsControllerFindMe` uses the generated client, which throws the parsed HTTP error body. Reuse the shared CLI error normalizer in `utils/error.ts` for recognized application codes and legacy HTTP-status fields. Login maps normalized 401/403 to the existing invalid-key error, retaining the status. Other known HTTP failures retain their status/message. For an unrecognized numeric application error code with an API message, show that message as an API failure. Actual transport errors keep the transient connectivity diagnostic. The CLI continues to save credentials only after successful validation.

### Context and error contracts

The baseline `ResolvedContext` has projectSlug, apiKey and apiUrl. US-002 extends the result of `resolveContext` with credential provenance, retaining the three original fields and independent precedence rules. It preserves the distinction between an empty stored key and a missing one. US-003 extends that same result with optional project defaults. `withContext` already returns the resolver result intact after configuring the client. Logout consumes that returned snapshot once and compares the current stored entry after the remote call. Ticket creation uses the same snapshot for flags and defaults. The public logout command itself has no key flag: verify flag provenance at the resolver/helper seam.

The existing `getStatusAndMessage(err)` in utils/error.ts returns a numeric status or undefined together with a message. US-004 makes this existing result available to login and preserves plain transport Error handling. A numeric nonzero ret can identify a rejected application envelope even when the status mapping has no entry. A known application code takes precedence over conflicting legacy status fields, as it does in the shared normalizer.

### Failure Handling

An expired JWT yields zero remaining cookie lifetime. An unavailable upstream refresh uses the web middleware’s existing transient-failure behavior. Failed remote logout performs no local edit. Invalid effective ticket inputs exit 3 before an API write. A failed login leaves the previous credentials available and retains the command’s existing nonzero exit behavior.

## Out of Scope

- Changing API token issuance, revocation policy or deployment configuration.
- Editing generated client files or migrating the stored profile format.
- Changing ticket enums, init flags or the CLI exit-code contract.
- Adding cross-process locking to the shared CLI configuration file. Logout rechecks the current entry after the HTTP request using the existing synchronous store operations.

## Stories

**US-001: Honor JWT lifetimes in browser cookies and SSR refresh.** Workdir: `apps/web`. No dependencies. Covers finding 11.

**US-002: Clear only the credential used for logout.** Workdir: `apps/cli`. No dependencies. Covers finding 12.

**US-003: Apply project defaults during ticket creation.** Workdir: `apps/cli`. Depends on US-002. Covers finding 13 and extends the same resolved context.

**US-004: Classify login failures from API envelopes.** Workdir: `apps/cli`. No dependencies. Covers finding 14.

### Context Files

**US-001**
- `apps/web/server/utils/api.ts`
- `apps/web/server/utils/session-refresh.ts`
- `apps/web/server/middleware/session-refresh.ts`
- `apps/web/server/api/auth/me.get.ts`
- `apps/web/tests/server/session-refresh.spec.ts`

**US-002**
- `apps/cli/src/config.ts`
- `apps/cli/src/utils/context.ts`
- `apps/cli/src/commands/auth.ts`
- `apps/cli/src/commands/auth.spec.ts`

**US-003**
- `apps/cli/src/commands/init.ts`
- `apps/cli/src/commands/ticket.ts`
- `apps/cli/src/config.ts`
- `docs/specs/SPEC-project-cli-config.md`

**US-004**
- `apps/cli/src/commands/login.ts`
- `apps/cli/src/commands/login.spec.ts`
- `apps/cli/src/utils/error.ts`
- `apps/cli/src/index.ts`

### Creates

None. Extend the existing implementation and test files.

### Modifies

**US-001**
- `apps/web/server/utils/api.ts` — read each token’s expiry when setting its cookie and share the expiry reader with SSR.
- `apps/web/server/utils/session-refresh.ts` — qualify an expired legacy access cookie for eligible SSR refresh.
- `apps/web/tests/server/auth-cookie-samesite.spec.ts` — exercise lifetimes, expiry fallback and existing cookie attributes through the real setter.
- `apps/web/tests/server/session-refresh-utils.spec.ts` — cover eligible HTML requests with expired or unexpired JWT cookies.
- `apps/web/tests/server/session-refresh.spec.ts` — use the real eligibility and header-replacement helpers in the expiry cases instead of the existing constant stubs; keep H3 and upstream boundaries controlled, and verify the rotated token on the same SSR request.

**US-002**
- `apps/cli/src/config.ts` — track key provenance and implement conditional cleanup of the correct persisted entry.
- `apps/cli/src/commands/auth.ts` — pass the logout context into cleanup after remote success, report the local action and update the help text that currently promises revocation of all tokens.
- `apps/cli/src/config.spec.ts` — exercise independent key and URL precedence, endpoint normalization and preservation of replaced credentials.
- `apps/cli/src/commands/auth.spec.ts` — replace the unconditional global-clear expectation. Exercise real context resolution and credential cleanup against an isolated credential store; capture the configured API call, then assert stored values for success and rejection.

**US-003**
- `apps/cli/src/config.ts` — carry optional ticket defaults from project config through the existing resolution.
- `apps/cli/src/config.spec.ts` — check resolution for project configs with and without ticket defaults.
- `apps/cli/src/commands/ticket.ts` — apply field-specific precedence and validate effective values before creating.
- `apps/cli/src/commands/ticket.spec.ts` — connect the existing resolver mock to the real resolver for the default cases, using an isolated init-shaped project fixture and controlled credentials. Capture the generated request and use a terminating exit double or subprocess for validation cases, since the default exit spy returns.

**US-004**
- `apps/cli/src/utils/error.ts` — expose the existing status/message normalizer for login.
- `apps/cli/src/commands/login.ts` — distinguish API rejections from transport errors in the login flow.
- `apps/cli/src/commands/login.spec.ts` — drive login with the generated client’s actual error-envelope shape and transport and success controls. Keep any output-module mock at the presentation boundary so the real shared normalizer executes.

### Seams

US-001 exercises the real cookie setter and SSR middleware with a fixed clock. For the expiry cases in session-refresh.spec.ts, wire the mocked functions to their real implementations (for example via Jest requireActual). US-002 drives the logout action through real context resolution and observes the endpoint, bearer and persisted config. US-003 drives the ticket action from project configuration through the generated-client request boundary. US-004 drives login through its existing credential check and verifies config writes.

## Acceptance Criteria

### US-001

- AC-1 [unit] With a fixed server clock, calling the real setAuthCookies with access and refresh JWTs expiring in 300 and 1209600 seconds emits those respective Max-Ages. Both are httpOnly, secure and scoped to slash, with lax access and strict refresh cookies.
- AC-2 [unit] With the default 15-minute and seven-day JWTs at issue time, the setter emits 900 and 604800 seconds. An expired JWT emits Max-Age zero and a missing token produces no cookie for that name.
- AC-3 [unit] Supplying an opaque access token and a valid refresh JWT applies the 900-second fallback only to the access cookie. An opaque refresh token uses the seven-day fallback.
- AC-4 [unit] On a protected HTML GET at minute six with an old 15-minute cookie containing a five-minute JWT and a valid refresh cookie, the real middleware calls the upstream refresh once and supplies the rotated access cookie to the same request consumed by SSR.
- AC-5 [unit] The same HTML request at minute four makes zero refresh calls. A request with only a valid refresh cookie still rotates on eligible HTML navigation, while an API request with those credentials makes zero middleware refresh calls.

- AC-6 [unit] An opaque access cookie still prevents an SSR refresh. A JWT with a string-valued expiry uses its existing per-cookie fallback. At exactly the numeric access expiry the eligible GET requests refresh; on upstream 503 it preserves the incoming cookies.

### US-002

- AC-1 [unit] With global A saved and URL and key supplied through the environment for B, the logout command obtains its context through withContext and calls authControllerLogout against B with B’s bearer and produces zero persisted config mutations. The same is true when the environment key happens to equal A’s key.
- AC-2 [unit] With a selected B profile, successful logout to B clears only that profile’s key. Inspecting the store shows its original name and URL, A’s global key, and another profile intact. Resolving B again yields an empty key.
- AC-3 [unit] Successful logout using the global credential against its owning endpoint clears only the global key. A configured base URL ending in slash-api and its equivalent bare form identify the same endpoint.
- AC-4 [unit] With a stored credential selected and an endpoint override pointing at a different host, port or base path, a table-driven logout test observes zero local edits after remote success.
- AC-5 [unit] When the upstream logout rejects, the action preserves the complete stored config and reports a failure. When the stored key or its URL changes while logout is pending, successful completion preserves the replacement.
- AC-6 [unit] A successful human-readable logout identifies whether a global key, a named profile key, or no saved credential was cleared. JSON success parses as exactly `{"success":true}`.

- AC-7 [unit] Call resolveContext with a flag-supplied key equal to a saved global key and run conditional cleanup with that snapshot. The persisted global entry survives. A selected profile with an empty stored URL likewise survives logout even if resolution found a usable global endpoint.
- AC-8 [unit] Inspect Commander’s logout help and invoke the non-JSON success action. Both describe the logout request without promising revocation of all outstanding tokens, and neither response contains the credential value.

### US-003

- AC-1 [unit] With a valid stored credential and a project fixture containing `{"projectSlug":"my-project","defaults":{"type":"TASK","priority":"HIGH"}}`, invoking ticket create with only a title calls ticketsControllerCreate once for my-project with that title, TASK and HIGH.
- AC-2 [unit] Explicit BUG overrides default TASK and keeps default HIGH. Explicit LOW overrides default HIGH and keeps default TASK. The generated-client call records each effective pair.
- AC-3 [unit] In an older project config without defaults, an explicit type and title succeeds with no serialized priority. Omitting type or omitting title produces exit 3 and zero creates.
- AC-4 [unit] A project default containing an unsupported type or priority yields exit 3 and zero creates when selected. A valid explicit flag overrides an invalid default for that field and sends the valid value.

### US-004

- AC-1 [unit] With agentsControllerFindMe rejecting with `{ret:40000,message:"Unauthorized"}`, login rejects with `Invalid API key`, exposes status 401 and makes zero config writes. Application code 40003 exercises the corresponding 403 case.
- AC-2 [unit] A legacy rejection carrying statusCode 500 and a message retains both. An unknown numeric application error code with a message yields that API message and does not set the transient flag.
- AC-3 [unit] A transport Error carrying ECONNREFUSED produces the existing connectivity diagnostic with the transport reason and transient flag, and leaves saved credentials untouched.
- AC-4 [unit] A successful credential check saves the supplied key and normalized endpoint once and returns the existing login success message.
- AC-5 [unit] When the credential check returns a rejection containing ret 40000 and a conflicting statusCode 500, login and the real getStatusAndMessage helper agree on the mapped 401 result and preserves the previous stored key.
