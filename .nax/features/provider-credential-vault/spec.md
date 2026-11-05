# SPEC: Provider credential vault (C10)

Closes: #371, #394

## Summary

An admin adds a provider API key (OpenRouter, DeepSeek, OpenAI, ...) once in koda, and every runner's fleet jobs and
native thread sessions use it, with no `nax auth login` on the machine. Keys exist at three scopes: GLOBAL
(fleet-wide), PROJECT and REPO; the most specific active key wins. koda stores each key encrypted, never shows it again
after it is saved, and records which job or thread was handed which key (by name and fingerprint). Runners serve the
key to nax through nax-agent's `credentials.source: "exec"` helper contract over a per-job provider-key socket. A
machine-local `nax auth` credential keeps working for any provider koda holds no key for.

The feature also carries #394: a ruling that nax can never apply is refused up front (a `ci` item, or a draft whose PR
has no nax item index), and the web explains an `unknown-item` skip.

## Motivation

Today each runner needs every provider credential stored on the machine (`nax auth`). Setting up a runner, rotating a
key, or keeping separate billing per project means touching every machine, and nothing records which job used which
key. The nax side is ready: nax-agent 0.91.7 (koda's pin) ships the exec helper contract and a per-session credential
source. Design: `docs/superpowers/specs/2026-11-05-provider-credential-vault-design.md` (approved 11-05).

#394: koda accepts a ruling on any open item of a draft RUN, but nax (>= 0.91.2) settles only items in the PR's
`w-index` comment and never settles `ci` items. The ruling looks accepted until a billed FIX reports
`skipped: unknown-item`.

## Design

### User rulings (2026-11-05)

- Picture: add an API key once in koda; every runner's jobs and native threads use it; no `nax auth` per machine;
  see which job used which key.
- Scopes: GLOBAL plus per-PROJECT and per-REPO override keys.
- Management and storage as played back: Owner/Admin manage GLOBAL keys, project admins manage PROJECT and REPO keys;
  keys are write-only after save; local encrypted storage behind an interface.
- #371 as filed (exec helper vault), no LLM proxy. #394 folded in.

### Calls made while drafting (not user rulings)

- No spend cap per key; attribution only (existing C1 job budgets still apply).
- New env `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` (64 hex chars), separate from `VCS_ENCRYPTION_KEY`. Unset = the vault
  is off: management writes refuse with 503 and hand-outs answer `vault_off`; the API still boots.
- Uniqueness uses a computed `scopeKey` string (`global`, `project:<projectId>`, `repo:<repoId>`) with
  `@@unique([scopeKey, providerId])`, because Postgres treats NULL columns as distinct.
- A key is 16-8192 characters with no whitespace (16 keeps `last4` to at most a quarter of the key).
- Fingerprint = first 12 hex chars of HMAC-SHA256(master key, plaintext key); `last4` = last 4 chars of the key.
- Hand-out lease `expiresAt = now + 10 min`. Attribution dedupe uses a `ProviderCredentialIssue` row unique on
  (job, credential, fingerprint); a new row records one `credential.issued` activity.
- Revocation latency: after a key is disabled or deleted, a running nax keeps its current lease until `expiresAt`
  (nax-agent serves the last good lease when the helper fails), so a running job is cut off at most 10 minutes later.
- Thread jobs resolve from the thread's own `projectId` and `repoId` (`repoId` null for PROJECT and WORKSPACE threads;
  a WORKSPACE thread's anchor `projectId` is non-null, so its PROJECT key applies); fleet jobs from `FleetJob.projectId`
  and `FleetJob.repoId`.
- Relations: `ProviderCredential.projectId` and `repoId` reference `Project` and `FleetRepo` with `onDelete: Cascade`;
  `createdById`/`updatedById` are plain strings (no FK), as on other fleet rows.
- Permission keys: `fleet.credential.create|update|delete` (global; the prefix is already high risk) and
  `project.credential.read|create|update|delete` (project; `project.credential.` joins `HIGH_RISK_PREFIXES`).
- Writes follow the `vcs.connection.create` precedent exactly: route commands whose `redeem.redact` replaces the key
  with `redactSecret(key)`, so no approval request row carries the key.
- Each job gets its own provider-key socket, separate from the git credential socket, open for the whole job (git
  credentials are released after checkout; provider keys are needed for every model call).
- The runner never edits nax config on its own; `koda-runner vault enable|disable` does, atomically.
- Helper timeout 60000 ms (nax's schema maximum); the socket holds a provider reply open up to 55 s.
- The `w-index` pre-check runs before the ruling transaction, matches the exact nax marker `<!-- nax-bot:v1
  key=w-index -->`, reads one page of 100 comments with a 5 s timeout, and fails open on any forge error or a full page
  with no marker. No author check: a planted marker only restores today's behaviour (a later skip).
- Value redaction of runner-shipped logs is dropped: the log shipper sends offset-tracked byte windows, so an
  in-place rewrite breaks the offsets (deferred, Out of Scope).

### Integration

Symbols this feature only reads (verified):

- `encryptToken(plaintext: string, masterKey: string): string` and `decryptToken(ciphertext: string, masterKey:
  string): string` in `apps/api/src/common/utils/encryption.util.ts` (AES-256-GCM, `iv:tag:ciphertext` hex, 32-byte
  hex key).
- `vcsConfig` / `VCS_CFG` / `IVcsConfig` in `apps/api/src/config/vcs.config.ts`; `VCS_ENCRYPTION_KEY:
  Joi.string().hex().length(64).optional()` in `apps/api/src/config/env.validation.ts:32` — the pattern for the new key.
- `vcs-route.commands.ts` `routeCommand({ key, variant, parse, redeem: { redact }, run })` with `redactSecret`
  (`apps/api/src/approvals/route/redact-secret.ts`; precedent `apps/api/src/vcs/vcs-route.commands.ts:44-58`), the
  sibling route decorators `@ApprovalGated({ redeem: true })` and `@ApprovalRedeemHeader()`, and `routeGate.run({ projectId:
  null, ... })` for a global route (`apps/api/src/outbox/admin.controller.ts:53`) and the controller's `routeGate.run` call
  (`apps/api/src/vcs/vcs.controller.ts:68-90`) — the approval-gated secret write precedent.
- `AuditRecorder.record({ key, resourceType, resourceId, projectId?, summary })`
  (`apps/api/src/audit/audit-recorder.service.ts`; used at `fleet-repos.service.ts:74`).
- `FleetActivityService.record(entry)` (`apps/api/src/fleet/activity/fleet-activity.service.ts`); a payload key
  matching `/token|secret|key|password|credential/i` throws, so payloads use `providerId`, `scope`, `name`,
  `fingerprint` only. `FleetActorType` has `RUNNER` (`apps/api/src/common/enums.ts`).
- `FenceService.holds(job, runnerId, leaseEpoch)` (`apps/api/src/fleet/sync/fence.service.ts`) and
  `RUNNER_HELD_STATES` (`apps/api/src/fleet/jobs/job-state.ts`).
- `GitHubAppClient.mintThreadReadToken(installationId, repoName)` (pull_requests:read) in
  `apps/api/src/fleet/git-broker/github-app-client.ts`.
- nax helper contract (`@nathapp/nax-agent` 0.91.7, `dist/native/credentials/exec-source.js`, `helper-protocol.js`):
  argv `[...command, "get"]`; stdin `{"version":1,"providerId":"<id>"}`; reply `{"version":1,"kind":"api-key",
  "key":"...","expiresAt":<epoch ms>,"account":"..."}` or `{"version":1,"decline":true}`; non-zero exit = failure. A
  failure while a lease is held serves the last good lease until its `expiresAt`. A decline for a provider that already
  holds a lease is invalid. `key` <= 8192 chars; `account` <= 200 chars.
- nax `auth` is global-only (`packages/nax/src/config/global-only-keys.ts:53` in the nax repo): read only from
  `<NAX_GLOBAL_CONFIG_DIR>/config.json`, shape `auth: { source: "file" | "exec", exec?: { command: string[],
  timeoutMs: number }, onChange: "warn" | "refuse" }`. The process-wide store asks the helper first and falls back to
  the credentials file on a decline.
- nax-agent per-session source: `NativeBackendOptions.credentials?: CredentialSource`, where the exec member is
  `{ kind: "exec"; command: readonly string[]; timeoutMs?: number; onChange?: "warn" | "refuse" }` (no file fallback).
- Runner: `socketPathFor(dir, runnerId, jobId, leaseEpoch, repoId?)` and `ensureSocketDir`
  (`apps/runner/src/credentials/socket-dir.ts`); `TokenCache` (`credentials/token-cache.ts`) as the cache pattern
  (in memory only, never journaled).

The baselines below exist only to locate the code. Never implement a baseline; implement the target.

- `SyncRequest` / `SyncResponse` (`packages/fleet-protocol/src/index.ts:246`, `:301-313`).
  Baseline: `SyncRequest.tokenRequests: TokenRequest[]`; `SyncResponse { jobAcks, commands, gitTokens, gitTokenErrors,
  unknownJobIds, archivedThreadIds?, nextPollAfterMs? }`.
  Target: `SyncRequest.providerRequests?: ProviderKeyRequest[]` with `ProviderKeyRequest { jobId: string; leaseEpoch:
  number; providerId: string }`; `SyncResponse.providerKeys?: ProviderKeyGrant[]` with `ProviderKeyGrant { jobId;
  providerId; key; expiresAt: string (ISO); account: string; fingerprint: string }`; `SyncResponse.providerKeyErrors?:
  ProviderKeyError[]` with `ProviderKeyError { jobId; providerId; reason: 'none' | 'job_not_active' | 'vault_off' }`.
- `SyncService.sync` idle check (`apps/api/src/fleet/sync/sync.service.ts:108-111`). Baseline: `idle` counts only
  acks, commands and git tokens. Target: a response carrying any provider grant or provider error is not idle.
- `findThreadTokenScope(jobId)` (`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:265`). Baseline: returns
  `{ kind, action }`. Target: unchanged; a new sibling `findThreadCredentialScope(jobId): Promise<{ projectId: string;
  repoId: string | null } | null>` reads the job's `ChatThread`.
- `FleetEntityType` (`apps/api/src/fleet/activity/domain/fleet-activity.domain.ts:7`). Baseline: `'runner' |
  'enrollment' | 'repo' | 'job' | 'budget' | 'schedule' | 'approval' | 'ingest' | 'analytics'`. Target: adds
  `'provider_credential'`.
- `RunnerCapabilities` (`packages/fleet-protocol/src/index.ts:82`, parsed in `apps/api/src/fleet/common/
  capabilities-core.ts:214`). Baseline: `threadModes?: true`. Target: also `providerVault?: true`.
- `CredentialProvider` and `CredentialBroker` (`apps/runner/src/credentials/broker.ts:27-36`). Baseline: the interface has
  `acquire`, `release` and optional `currentToken?`, `freshToken?`; the class adds `acquireRepo`, `releaseRepo`,
  `closeAll`. Target: the interface gains OPTIONAL `serveProviderKeys?`, `providerKeyGranted?` and
  `releaseProviderKeys?` (callers skip them when absent, so existing fakes with only `acquire`/`release` keep working);
  `BrokerDeps` gains an optional provider-key cache; provider-key sockets live in their own map, never in `servers`
  (so `release`'s sibling check for `<jobDir>/bin` ignores them). The class implements `serveProviderKeys(job: JobRow): Promise<string>` (opens, once per job and
  epoch, a provider-key socket at `socketPathFor(dir, runnerId, jobId, leaseEpoch, 'provider-keys')` and returns its
  path, whatever the clone URL), `providerKeyGranted(job, providerId): Promise<boolean>` (the same lookup the socket
  uses, true on a grant) and `releaseProviderKeys(job)` (closes the socket, drops the job's cached grants and served
  set). `closeAll` also closes provider-key sockets.
- `CredentialServer` (`apps/runner/src/credentials/cred-server.ts`). Baseline: `listen(path, reply)`; `serve()`
  answers only `get`. Target: a sibling `CredentialServer.listenProviderKeys(path, providerReply: (providerId: string)
  => Promise<ProviderReply>)` whose sockets answer only `provider <providerId>\n` (providerId matching
  `^[a-z0-9][a-z0-9._-]{0,47}$`), with `ProviderReply = { ok: true; key: string; expiresAt: number; account: string } |
  { ok: false; reason: 'none' | 'revoked' | 'error' | 'bad request' }`. `listen` is unchanged.
- `SyncLoop` (`apps/runner/src/sync/sync-loop.ts`). Baseline: deps `tokenRequests()` and `onTokens(...)`;
  `inflightIdle` true when jobs, acks and token requests are empty (`:130`). Target: optional deps
  `providerRequests?(): readonly ProviderKeyRequest[]` and `onProviderKeys?(grants, errors)`; `inflightIdle` is false
  when provider requests are queued; a newly queued provider request wakes the loop as a token need does.
- `dispatchInternal(argv)` (`apps/runner/src/internal-commands.ts`). Baseline: `git-cred`, `shim`. Target: also
  `provider-cred`.
- `OpenThreadSessionOptions` / `ThreadSessionFactory.open` (`apps/runner/src/thread/session-factory.ts:35-41`,
  `:108`). Baseline: `{ jobId; thread; worktree; tools; approvalTimeoutSec }`; native options carry no `credentials`.
  Target: adds `providerKeys?: { socket: string; granted(providerId: string): Promise<boolean> }`; native options carry
  `credentials: { kind: 'exec', command: [...self, 'provider-cred', '--socket', socket], timeoutMs: 60000 }` when
  `granted` resolves true for the session model's provider.
- `NaxProbeDeps` (`apps/runner/src/capabilities/nax-probe.ts:41`). Baseline: no vault input. Target: optional
  `vaultHelper?: () => Promise<boolean>`; capabilities carry `providerVault: true` only when it resolves true.
- `RulingJobTarget`, `findTarget` and `lockTarget` (`apps/api/src/fleet/rulings/fleet-pr-ruling.domain.ts`,
  `prisma-fleet-pr-ruling.repository.ts:21-56`). Baseline: `{ projectId, repoId, prNumber, openItems }`. Target: adds
  `repo: { provider: string; owner: string; name: string; githubInstallationId: bigint | null }`.
- `FleetPrRulingsService.ruleTarget(projectId, jobId, dto)` (`fleet-pr-rulings.service.ts:84`). Baseline: refuses
  `notDraft`, `notLatest`, `unknownItem`, `invalidText`, `settled`. Target: also refuses `notRulable` (item kind `ci`).
  A new `preflight(projectId, jobId, dto)` runs `ruleTarget` then `assertItemIndex(target)` (the forge check); all three
  callers (the controller, the ruling route command and the assistant `pr-ruling-tools.ts`) call `preflight` before
  `create`, never inside `create`'s transaction. Both `RulingJobTarget` producers, `findTarget` and `lockTarget`,
  populate `repo`.

Patterns to follow: `apps/api/src/vcs/` (encrypted secret, project routes, route commands with redaction),
`apps/api/src/fleet/repos/fleet-repos.service.ts` (fleet CRUD with activity and audit),
`apps/runner/src/credentials/` (per-job socket and cache), `apps/web/composables/useFleetRepos.ts` (writes that may
return an approval request), `SettingsVcsCard.vue` (project settings card).

### Approach

**Storage (api).** Model `ProviderCredential` (`id`, `scope` `GLOBAL|PROJECT|REPO` as a string, `scopeKey`,
`projectId?`, `repoId?`, `providerId`, `name`, `encryptedKey`, `last4`, `fingerprint`, `createdById`, `updatedById`,
`disabledAt?`, timestamps), `@@unique([scopeKey, providerId])`, `@@index([projectId])`, `@@index([repoId])`. Model
`ProviderCredentialIssue` (`id`, `jobId`, `credentialId`, `fingerprint`, `createdAt`),
`@@unique([jobId, credentialId, fingerprint])`. `providerId` matches `^[a-z0-9][a-z0-9._-]{0,47}$`; `name` 1-64 chars.
A `SecretStore` interface (`seal(plaintext) -> { encryptedKey, last4, fingerprint }`, `open(encryptedKey) ->
plaintext`) with one implementation, `LocalSecretStore`, over `encryptToken`/`decryptToken` and the config namespace
`providerCredentials` (`PROVIDER_CREDENTIAL_ENCRYPTION_KEY`).

**Resolution.** `ProviderCredentialsService.resolve({ projectId, repoId | null, providerId })` returns the active
(`disabledAt` null) REPO key for `repoId`, else the PROJECT key, else the GLOBAL key, else null.

**Management.** Global routes `GET|POST /fleet/provider-credentials`, `PATCH|DELETE /fleet/provider-credentials/:id`
(`fleet.credential.read|create|update|delete`). Project routes `GET|POST /projects/:slug/provider-credentials`,
`PATCH|DELETE /projects/:slug/provider-credentials/:id` (`project.credential.read|create|update|delete`); a POST with
`repoId` creates a REPO key for a repo of that project; the project routes see only that project's PROJECT and REPO
rows (any other id is 404). PATCH takes any of `name`, `key` (rotate), `disabled` (boolean). Every response row is
`{ id, scope, projectId, repoId, providerId, name, last4, fingerprint, disabled, createdBy, updatedAt }`, never the
key. Writes run through route commands (approval-gated, `redeem.redact` with `redactSecret`), record `FleetActivity`
(`credential.created|rotated|updated|disabled|enabled|deleted`, entityType `provider_credential`, entityId the
credential id) and an audit entry (`AuditRecorder.record` with the route key). A unique-constraint violation
(Prisma `P2002`) maps to 409 `fleet.providerCredentials.duplicate`.

**Hand-out (api).** `SyncService` handles `providerRequests` like `tokenRequests`: fence (a stale epoch abandons, as
for tokens), job state in `RUNNER_HELD_STATES` (else `job_not_active`), vault off (`vault_off`), scope (thread job:
`findThreadCredentialScope`; fleet job: the job's `projectId`/`repoId`), resolve (null or undecryptable = `none`), else
a grant with `account = koda:<scope lowercase>:<name>` and `expiresAt = now + 10 min`. In the same transaction it
inserts `ProviderCredentialIssue` with skip-on-duplicate and, when a row was inserted, records `credential.issued`
(actor `RUNNER`/runnerId, entityType `provider_credential`, entityId the credential id, `jobId`, `projectId`, payload
`{ providerId, scope, name, fingerprint }`). A response with any provider grant or error skips the long-poll wait.

**Runner, provider-key socket.** `CredentialBroker.serveProviderKeys(job)` opens one provider-key socket per job and
epoch. Its reply for `provider <id>` queues a `ProviderKeyRequest` in a `ProviderKeyCache` (in memory, mirroring
`TokenCache`), wakes the sync loop, waits up to 55 s for the grant, serves a cached grant until 60 s before
`expiresAt` (ISO converted to epoch ms), and remembers which providers it served the job: once served, a later `none`
becomes `revoked`. `releaseProviderKeys(job)` closes it and forgets the job.

**Runner, fleet jobs.** The host executor calls `serveProviderKeys(job)` and puts `KODA_PROVIDER_CRED_SOCKET=<path>`
in the nax env at both spawn sites (`spawn`, which covers RUN, PLAN and REVIEW, and `spawnFixStep`), re-serves it in
`resumeCredentials` (a readopted nax keeps its deterministic socket path), and calls `releaseProviderKeys(job)` in
both `cleanup()` and `releaseCredentials()`. The config job serves before it builds `naxEnv` and releases in its own
cleanup. The helper `koda-runner provider-cred [--socket <path>] get` reads the nax request from
stdin; the socket is `--socket` when given, else `KODA_PROVIDER_CRED_SOCKET`; it maps: neither given -> decline;
`none` -> decline; ok -> the api-key reply; `revoked`, `error`, `bad request`, socket failure -> exit 1 with one
stderr line and nothing on stdout.

**Runner, nax config.** `koda-runner vault enable` writes `auth: { source: "exec", exec: { command: [...self,
"provider-cred"], timeoutMs: 60000 }, onChange: "warn" }` into `<naxHome>/config.json`, keeping every other key, via a
temp file + rename; `vault disable` removes `auth`. The probe's `vaultHelper` dep (wired in the daemon) is true exactly
when `config.json`'s `auth.exec.command` equals `[...self, "provider-cred"]`.

**Runner, threads.** `ThreadJobRun` calls `serveProviderKeys(row)` before both `sessions.open` call sites (the REPO
path and `runProject`, so REPO, PROJECT and WORKSPACE threads alike), passes `providerKeys: { socket, granted: (p) =>
broker.providerKeyGranted(row, p) }` into every `open`, and calls `releaseProviderKeys(row)` in `start()`'s `finally`
and in `abandon()`. The factory derives `providerId` from
the session model id (text before the first `/`; the runner default model when the thread pins none; a model id with
no `/` gets no koda key) and, when
`granted` is true, sets the per-session exec `credentials`; otherwise it opens without `credentials`
(process-wide store, machine-local). ACP threads never consult it.

**Visibility.** Credential board gains `kodaKeys: { providerId, name, last4, updatedAt }[]` (active GLOBAL keys) and a
per-runner `providerVault` boolean; the admin page shows a koda column and a "vault off" marker. The admin page
`/admin/fleet/provider-keys` manages GLOBAL keys; project settings gain a "Provider keys" card with PROJECT and REPO
rows. A write that returns an approval request shows a pending notice instead of a saved row.

**#394.** `ruleTarget` refuses `kind === 'ci'` (no forge read). `assertItemIndex(target)`, for a GitHub repo with an
installation id, mints the thread-read token, calls new `GitHubAppClient.listIssueComments(token, owner, name,
number)` (`GET /repos/{o}/{n}/issues/{number}/comments?per_page=100`, 5 s timeout through an optional per-request timeout override on `FleetHttpClient.request`, returns bodies), and refuses
`noItemIndex` only when the page has fewer than 100 comments and none contains `<!-- nax-bot:v1 key=w-index -->`.
Web `FleetJobOpenItems.vue` hides Rule on `ci` items; the `fleet.rulings.skipReason.unknown-item` label explains.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| Master key unset | Management writes 503 `fleet.providerCredentials.vaultOff`; hand-outs `vault_off`; helper declines; API boots |
| Master key wrong length | Boot fails (env validation), as for `VCS_ENCRYPTION_KEY` |
| Ciphertext cannot be decrypted | Hand-out answers `none` and logs a warning with the credential id only |
| Duplicate key at the same scope and provider | 409 `fleet.providerCredentials.duplicate` (also on a `P2002` race) |
| REPO key for a repo of another project | 404 `fleet.repos` |
| Credential id of another scope on a project or global route | 404 |
| Key disabled or deleted during a run | Next renewal: socket `revoked`, helper exits 1; nax keeps its last good lease until `expiresAt` (at most 10 min), then fails the call |
| Socket unreachable | Helper exits 1 with a stderr line, never declines |
| Helper run outside a koda job | Helper declines; nax uses the credentials file |
| Provider reply not ready in 55 s | Socket answers `error`; helper exits 1 |
| `w-index` forge read fails, times out, or returns a full page | Ruling accepted (fail open) |

## Out of Scope

- OAuth or subscription logins (Claude, ChatGPT, Copilot, Gemini) are not stored or served by koda; nax's exec helper accepts only `kind: "api-key"`.
- ACP thread backends (Claude Code, Codex, Cursor) keep their own sign-ins on the runner host and never receive koda keys.
- An LLM proxy or gateway in front of providers (one koda key for all providers) is not built.
- Spend caps or rate limits per provider key are not enforced; existing C1 job budgets are unchanged.
- HashiCorp Vault, OpenBao and cloud KMS backends are not built; only the local encrypted `SecretStore` exists.
- Re-encrypting stored keys under a new master key (master key rotation) is not built.
- Secrecy from the agent is not claimed: the agent's Bash runs as the runner uid and can reach the job's provider-key socket.
- Value redaction of runner-shipped job logs, thread logs, bundles and diagnostics for served provider keys is not done; the key is never in the job env or on disk, and nax-agent's own redaction is unchanged.
- Revocation does not interrupt a running nax before its current lease expires (at most 10 minutes).
- Placement does not prefer or require runners with `providerVault`; a job on a runner without the helper uses that machine's own credentials.
- The runner never edits `<naxHome>/config.json` except through `koda-runner vault enable` and `vault disable`; concurrent edits by other tools during those commands are not guarded beyond the atomic rename.
- The CLI gets no provider-key commands and keeps printing the raw ruling skip reason.
- GitLab merge requests get no `w-index` pre-check; rulings are GitHub-only today.
- Agents (MCP tools) get no provider-key tools.
- The `w-index` pre-check does not verify the marker comment's author.
- A model switch inside one open native session to a provider koda holds no key for is not re-resolved; the next session open re-resolves (the per-session exec source has no file fallback).
- A runner whose `runner.json` overrides capabilities (`StaticCapabilityProbe`) never reports `providerVault`.

## Stories

### US-001: Encrypted provider credential storage

Workdir: `apps/api`. No dependencies. Prisma models `ProviderCredential` and `ProviderCredentialIssue` + migration;
config namespace `providerCredentials` with `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` (Joi hex length 64, optional);
`SecretStore` interface and `LocalSecretStore`; repository behind `PROVIDER_CREDENTIAL_REPOSITORY`;
`ProviderCredentialsModule`.

### US-002: Resolve and issue the most specific key

Workdir: `apps/api`. Depends on US-001. `ProviderCredentialsService` with `isEnabled`, `resolve` (REPO, then PROJECT,
then GLOBAL, active rows only), `issueKey` (decrypt for a hand-out) and `create`/`update`/`remove` domain methods
used by the routes (key validation, sealing, `P2002` -> duplicate).

### US-003: Create and list GLOBAL provider keys

Workdir: `apps/api`. Depends on US-002. Catalog keys `fleet.credential.create|update|delete` (global) in
`NEW_KEY_SCOPES`; `FleetEntityType` gains `provider_credential`; `FleetProviderCredentialsController` GET and POST;
route command for create with redaction; DTOs; activity and audit; i18n namespace `providerCredentials` (en, zh);
openapi regen.

### US-004: Rotate, disable and delete GLOBAL provider keys

Workdir: `apps/api`. Depends on US-003. PATCH and DELETE on `/fleet/provider-credentials/:id`; route commands for
update (key redacted) and delete; activity and audit.

### US-005: Manage PROJECT and REPO provider keys

Workdir: `apps/api`. Depends on US-004. Catalog keys `project.credential.read|create|update|delete` (project);
`project.credential.` joins `HIGH_RISK_PREFIXES`; `ProjectProviderCredentialsController` with the four routes, route
commands, tenant isolation, openapi regen.

### US-006: Hand provider keys to runners through sync

Workdir: `apps/api`. Depends on US-002. Protocol types; parser limit; `SyncService` grants with fence, state,
vault-off, scope and resolution; `findThreadCredentialScope`; `ProviderCredentialIssue` dedupe and `credential.issued`;
the idle check.

### US-007: Credential board shows koda keys and runner vault state

Workdir: `apps/api`. Depends on US-002. `providerVault` parsed in `parseCapabilitiesCore`; `buildCredentialBoard`
and `CredentialBoardDto` gain `kodaKeys` and per-runner `providerVault`; openapi regen.

### US-008: Runner provider-key sockets and cache

Workdir: `apps/runner`. Depends on US-006. `CredentialServer.listenProviderKeys`; `ProviderKeyCache`; broker
`serveProviderKeys`, `providerKeyGranted`, `releaseProviderKeys`; `SyncLoop` optional provider deps, idle and wake;
daemon wiring.

### US-009: nax exec helper and fleet job env

Workdir: `apps/runner`. Depends on US-008. `provider-cred` internal command (`runProviderCred`); host executor (both
spawn sites, `resumeCredentials`, `cleanup`, `releaseCredentials`) and config job serve the provider-key socket, set
`KODA_PROVIDER_CRED_SOCKET`, and release it.

### US-010: Runner vault enable and disable, and the providerVault capability

Workdir: `apps/runner`. Depends on US-009. `vault enable|disable` commander commands writing `<naxHome>/config.json`
atomically; `NaxProbeDeps.vaultHelper` and its daemon wiring; the `providerVault` flag.

### US-011: Native thread sessions use koda keys

Workdir: `apps/runner`. Depends on US-009. `ThreadJobRun` serves the provider-key socket before both session opens,
releases it in `start()`'s `finally` and in `abandon()`, and passes `providerKeys` into `open`; `ThreadSessionFactory.open` derives the provider and sets the per-session exec
`credentials` on a grant.

### US-012: Web admin provider keys page and board column

Workdir: `apps/web`. Depends on US-004, US-007. Page `/admin/fleet/provider-keys` (list, add, rotate, disable/enable,
delete, approval-pending notice) gated on `fleet.credential.*`; board koda column and "vault off" runner marker.

### US-013: Web project provider keys card

Workdir: `apps/web`. Depends on US-005, US-012. `SettingsProviderKeysCard.vue` on project settings with PROJECT and
per-REPO rows, gated on `project.credential.*`, with the approval-pending notice.

### US-014: Rulings refuse items nax can never settle

Workdir: `apps/api`. No dependencies. `ruleTarget` refuses `ci` items; `RulingJobTarget.repo` from `findTarget` and
`lockTarget`; `assertItemIndex` with `GitHubAppClient.listIssueComments`; `preflight` used by the controller, the route
command and the assistant ruling tool before `create`; i18n keys (en, zh).

### US-015: Web hides Rule on CI items and explains unknown-item

Workdir: `apps/web`. Depends on US-014. `FleetJobOpenItems.vue` hides Rule on `ci` items; the `unknown-item` skip
label explains the missing item index (en, zh).

### Context Files

**US-001**
- `apps/api/src/common/utils/encryption.util.ts` — encrypt/decrypt to reuse
- `apps/api/src/config/vcs.config.ts` — config namespace pattern
- `apps/api/src/config/env.validation.ts` — Joi entry for the new env
- `apps/api/prisma/schema.prisma` — where the models go
- `apps/api/src/vcs/prisma-vcs.repository.ts` — repository precedent

**US-002**
- `apps/api/src/fleet/provider-credentials/provider-credential.domain.ts` — created by US-001, read here
- `apps/api/src/fleet/provider-credentials/prisma-provider-credential.repository.ts` — created by US-001, read here
- `apps/api/src/fleet/provider-credentials/secret-store.ts` — created by US-001, read here
- `apps/api/src/vcs/vcs-connection.service.ts` — sealing and duplicate mapping precedent

**US-003**
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`
- `apps/api/src/vcs/vcs-route.commands.ts` — route command with redaction
- `apps/api/src/approvals/route/redact-secret.ts` — `redactSecret`
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — activity and audit precedent
- `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` — `FleetEntityType`

**US-004**
- `apps/api/src/fleet/provider-credentials/fleet-provider-credentials.controller.ts` — created by US-003, extended here
- `apps/api/src/fleet/provider-credentials/provider-credential-route.commands.ts` — created by US-003, extended here
- `apps/api/src/vcs/vcs-route.commands.ts` — update variant precedent

**US-005**
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `HIGH_RISK_PREFIXES`
- `apps/api/src/vcs/vcs.controller.ts` — project route precedent
- `apps/api/src/fleet/provider-credentials/fleet-provider-credentials.controller.ts` — created by US-003, mirrored here
- `apps/api/src/fleet/provider-credentials/provider-credential-route.commands.ts` — created by US-003, extended here

**US-006**
- `packages/fleet-protocol/src/index.ts` — sync wire types
- `apps/api/src/fleet/sync/sync.service.ts` — `grantTokens` and the idle check
- `apps/api/src/fleet/sync/sync-request.parser.ts` — `parseTokenRequest`, `SYNC_LIMITS`
- `apps/api/src/fleet/sync/fence.service.ts` — fence
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadTokenScope`

**US-007**
- `apps/api/src/fleet/common/capabilities-core.ts` — `parseCapabilitiesCore`
- `apps/api/src/fleet/dashboard/credential-board.ts` — board derivation
- `apps/api/src/fleet/dashboard/credential-board.service.ts` — board service
- `apps/api/src/fleet/dashboard/dto/credential-board.dto.ts` — board DTO

**US-008**
- `apps/runner/src/credentials/cred-server.ts` — socket protocol
- `apps/runner/src/credentials/broker.ts` — per-job servers
- `apps/runner/src/credentials/token-cache.ts` — cache pattern to mirror
- `apps/runner/src/sync/sync-loop.ts` — request/response wiring, idle and wake
- `apps/runner/src/daemon/daemon.ts` — broker and sync loop wiring

**US-009**
- `apps/runner/src/internal-commands.ts` — internal command dispatch
- `apps/runner/src/credentials/git-credential.ts` — socket client precedent (`requestCredential`)
- `apps/runner/src/executor/host-executor.ts` — fleet job env and cleanup
- `apps/runner/src/executor/config-job/config-job.ts` — config job env and cleanup

**US-010**
- `apps/runner/src/main.ts` — commander commands
- `apps/runner/src/config/runner-config.ts` — `naxHome`
- `apps/runner/src/capabilities/nax-probe.ts` — `NaxProbeDeps`
- `apps/runner/src/capabilities/create-probe.ts` — probe construction
- `apps/runner/src/self-command.ts` — the runner's own argv

**US-011**
- `apps/runner/src/thread/session-factory.ts` — the open path
- `apps/runner/src/thread/thread-job-run.ts` — thread job lifecycle and session opens
- `apps/runner/src/credentials/broker.ts` — provider-key socket (changed by US-008)
- `apps/runner/src/daemon/daemon.ts` — factory wiring

**US-012**
- `apps/web/pages/admin/fleet/credentials.vue` — board page
- `apps/web/pages/admin/fleet/repos.vue` — admin fleet page pattern
- `apps/web/composables/useFleetRepos.ts` — saved-or-pending write pattern
- `apps/web/i18n/locales/en.json` — locale keys

**US-013**
- `apps/web/pages/[project]/settings.vue` — settings page
- `apps/web/components/SettingsVcsCard.vue` — card pattern
- `apps/web/composables/useProviderCredentials.ts` — created by US-012, reused here
- `apps/web/i18n/locales/en.json` — locale keys

**US-014**
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — `ruleTarget`, `create`
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts` — `findTarget`
- `apps/api/src/fleet/rulings/fleet-rulings.controller.ts` — preflight call site
- `apps/api/src/fleet/rulings/fleet-ruling-route.commands.ts` — route command call site
- `apps/api/src/fleet/assistant/tools/pr-ruling-tools.ts` — assistant call site

**US-015**
- `apps/web/components/fleet/FleetJobOpenItems.vue` — Rule action and skip reason
- `apps/web/i18n/locales/en.json` — `fleet.rulings.skipReason`

### Creates

**US-001**
- `apps/api/src/config/provider-credentials.config.ts`
- `apps/api/src/fleet/provider-credentials/provider-credential.domain.ts`
- `apps/api/src/fleet/provider-credentials/secret-store.ts`
- `apps/api/src/fleet/provider-credentials/prisma-provider-credential.repository.ts`
- `apps/api/src/fleet/provider-credentials/provider-credentials.module.ts`

**US-002**
- `apps/api/src/fleet/provider-credentials/provider-credentials.service.ts`

**US-003**
- `apps/api/src/fleet/provider-credentials/fleet-provider-credentials.controller.ts`
- `apps/api/src/fleet/provider-credentials/provider-credential-route.commands.ts`
- `apps/api/src/fleet/provider-credentials/dto/provider-credential.dto.ts`
- `apps/api/src/i18n/en/providerCredentials.json`
- `apps/api/src/i18n/zh/providerCredentials.json`

**US-005**
- `apps/api/src/fleet/provider-credentials/project-provider-credentials.controller.ts`

**US-008**
- `apps/runner/src/credentials/provider-key-cache.ts`

**US-009**
- `apps/runner/src/credentials/provider-cred.ts`

**US-010**
- `apps/runner/src/commands/vault.ts`

**US-012**
- `apps/web/pages/admin/fleet/provider-keys.vue`
- `apps/web/composables/useProviderCredentials.ts`

**US-013**
- `apps/web/components/SettingsProviderKeysCard.vue`

### Modifies

**US-001**
None. New models, config and module only; no existing assertion pins their absence.

**US-002**
None. A new service only.

**US-003**
- `apps/api/src/permissions/catalog.spec.ts` — its mirrored `NEW_KEY_SCOPES` gains `fleet.credential.create`, `fleet.credential.update` and `fleet.credential.delete` with scope `global`; the catalog length assertion counts them.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — the role matrix gains `fleet.credential.create|update|delete`, held by Owner and Admin through `*` and by no other role.
- `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` — `FleetEntityType` gains `'provider_credential'`; every other member unchanged.
- `apps/api/prisma/schema.prisma` — the `FleetActivity.entityType` comment lists `provider_credential`.
- `openapi.json` — regenerated for the new routes.
- `apps/cli/src/generated/sdk.gen.ts` — regenerated by `bun run generate` after the API spec export; never hand-edited.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate` after the API spec export; never hand-edited.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains GLOBAL create and list (one happy path and one error case each).

**US-004**
- `openapi.json` — regenerated for PATCH and DELETE.
- `apps/cli/src/generated/sdk.gen.ts` — regenerated by `bun run generate`; never hand-edited.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate`; never hand-edited.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains GLOBAL rotate, disable and delete (one happy path and one error case each).

**US-005**
- `apps/api/src/permissions/catalog.spec.ts` — its mirrored `NEW_KEY_SCOPES` gains `project.credential.read|create|update|delete` with scope `project`, and its mirrored `HIGH_RISK_PREFIXES` gains `project.credential.`; the length assertion counts the new keys.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — gains `project.credential.read|create|update|delete`: Project Admin holds all four through `*`; every other project role holds `project.credential.read` through `*.read` and no write key.
- `openapi.json` — regenerated for the project routes.
- `apps/cli/src/generated/sdk.gen.ts` — regenerated by `bun run generate`; never hand-edited.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate`; never hand-edited.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains the PROJECT and REPO lifecycle (one happy path and one error case per route).

**US-006**
- `apps/api/src/fleet/sync/sync-token-fence.spec.ts` — its sync service fakes gain the provider-credential service and `findThreadCredentialScope` stubs; its token-fence assertions are unchanged.
- `apps/api/src/fleet/sync/sync.service.token-purpose.spec.ts` — its sync service fakes gain the provider-credential service stub; its assertions are unchanged.

**US-007**
- `apps/api/src/fleet/fleet-openapi.contract.spec.ts` — its expected `CredentialBoardDto` property list gains `kodaKeys` (sorted: `generatedAt`, `kodaKeys`, `profiles`, `providers`, `runners`, `warnDays`); its other assertions are unchanged.
- `apps/api/src/fleet/dashboard/credential-board.spec.ts` — its expected board shape gains `kodaKeys` and a per-runner `providerVault` boolean; every existing cell expectation unchanged.
- `openapi.json` — regenerated for the board DTO.
- `apps/cli/src/generated/types.gen.ts` — regenerated by `bun run generate`; never hand-edited.

**US-008**
- `apps/runner/test/unit/daemon-thread-wiring.spec.ts` — its daemon wiring fakes gain the provider-key cache; its wiring assertions are unchanged.

**US-009**
- `apps/runner/test/unit/host-executor.spec.ts` — where a case injects a fake with `serveProviderKeys`, its env assertions also expect `KODA_PROVIDER_CRED_SOCKET`; fakes without the optional methods keep today's env.
- `apps/runner/test/unit/config-job.spec.ts` — where a case injects a fake with `serveProviderKeys`, the nax env also carries `KODA_PROVIDER_CRED_SOCKET`; fakes without it keep today's env.

**US-010**
- `apps/runner/src/capabilities/nax-probe.spec.ts` — its expected capability object omits `providerVault` when no `vaultHelper` is injected; every other expected field unchanged.

**US-011**
None. The provider-key methods are optional on `CredentialProvider`, so existing thread job fakes with only `acquire` and `release` keep working unchanged.

**US-012**
None. New page and composable; the board page gains a column without changing existing assertions.

**US-013**
None. New card; the settings page gains one card without changing existing assertions.

**US-014**
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.spec.ts` — its accepted-ruling fixtures use a non-`ci` item; the existing refusal order is unchanged.
- `apps/api/src/fleet/rulings/fleet-pr-rulings.snapshot.spec.ts` — its `findTarget` and `lockTarget` fakes gain the `repo` field.
- `apps/api/src/fleet/git-broker/fleet-http-client.ts` — `FleetHttpClient.request` gains an optional per-request timeout override so the `w-index` comments read can use 5 s; without an override it keeps `httpTimeoutMs` and still refuses redirects.

**US-015**
- `apps/web/tests/components/FleetJobOpenItems.spec.ts` — any case expecting a Rule action on an open item of kind `ci` becomes: no Rule action for `ci`; Rule stays for every other kind.
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — parity holds with the changed `unknown-item` label in en and zh.

### Seams

- US-002 `ProviderCredentialsService.resolve` is called by US-006's `SyncService` (seam ACs in US-006 through `POST /fleet/runner/sync`).
- US-002 write methods are called by US-003, US-004 and US-005 controllers (seam ACs through the HTTP routes).
- US-006 `ProviderKeyGrant` on `SyncResponse` is consumed by US-008's `ProviderKeyCache` (seam AC in US-008 through the real `SyncLoop`).
- US-008 `serveProviderKeys` is called by US-009's host executor and US-011's `ThreadJobRun` (seam ACs there with a real `CredentialBroker`).
- US-009 `runProviderCred` talks to US-008's socket (seam AC in US-009 against a real provider-key socket).
- US-007 `kodaKeys` and `providerVault` on `CredentialBoardDto` are rendered by US-012.
- US-014 `assertItemIndex` is called from the existing rulings controller and route command (seam AC in US-014 through the HTTP route).

## Acceptance Criteria

### US-001: Encrypted provider credential storage

- [unit] `LocalSecretStore.open(LocalSecretStore.seal('sk-test-abcdef123456').encryptedKey)` returns `sk-test-abcdef123456`.
- [unit] `LocalSecretStore.seal('sk-test-abcdef123456').last4` is `3456`.
- [unit] `LocalSecretStore.seal` returns a `fingerprint` of exactly 12 lowercase hex characters.
- [unit] Two `LocalSecretStore.seal` calls on the same key under the same master key return the same `fingerprint`.
- [unit] Two `LocalSecretStore.seal` calls on the same key return different `encryptedKey` values.
- [unit] `LocalSecretStore.seal` returns an `encryptedKey` in the `iv:tag:ciphertext` hex format of `encryptToken`.
- [unit] Env validation accepts a missing `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`.
- [unit] Env validation refuses a `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` that is not 64 hex characters.
- [unit] The `providerCredentials` config namespace exposes `encryptionKey` from `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`, and `undefined` when it is unset.
- [integration] Inserting two `ProviderCredential` rows with the same `scopeKey` and `providerId` fails the second insert with Prisma error code `P2002`.
- [integration] A GLOBAL row (`scopeKey: 'global'`) and a PROJECT row (`scopeKey: 'project:<id>'`) for the same `providerId` coexist.
- [integration] Inserting two `ProviderCredentialIssue` rows with the same `jobId`, `credentialId` and `fingerprint` fails the second with `P2002`.
- [unit] Compiling `ProviderCredentialsModule` with mocked `PrismaService`, `TRANSACTION_MANAGER` and config succeeds and the module exports no repository token.

### US-002: Resolve and issue the most specific key

- [unit] With the `providerCredentials` `encryptionKey` unset, `ProviderCredentialsService.isEnabled()` returns false.
- [unit] `resolve({ projectId: 'p1', repoId: 'r1', providerId: 'openrouter' })` returns the REPO key when active REPO, PROJECT and GLOBAL keys exist for `openrouter`.
- [unit] `resolve` with `repoId: 'r1'` returns the PROJECT key when the only REPO key for `r1` is disabled.
- [unit] `resolve` with `repoId: null` returns the GLOBAL key when no PROJECT key exists for `p1`.
- [unit] `resolve` returns null when the only `openrouter` key is a PROJECT key of another project.
- [unit] `resolve` returns null when the only `openrouter` key is a disabled GLOBAL key.
- [unit] `resolve` returns null when the vault is off, and does not call the repository.
- [unit] `issueKey(credential)` returns the decrypted plaintext of a credential sealed by `LocalSecretStore`.
- [unit] `issueKey` returns null when decryption throws.
- [unit] `issueKey` logs a warning containing the credential id and not the ciphertext when decryption throws.
- [unit] `create` refuses a key shorter than 16 characters with a validation error naming `key`.
- [unit] `create` refuses a key containing whitespace with a validation error naming `key`.
- [unit] `create` maps a repository `P2002` error to a conflict with code `fleet.providerCredentials.duplicate`.
- [unit] `create` with the vault off throws a 503 error with code `fleet.providerCredentials.vaultOff`.

### US-003: Create and list GLOBAL provider keys

- [integration] `POST /fleet/provider-credentials` by a global Admin with `{ providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef123456' }` returns 201 with `scope: 'GLOBAL'` and `last4: '3456'`.
- [integration] The `POST /fleet/provider-credentials` response body has neither a `key` nor an `encryptedKey` field.
- [integration] `GET /fleet/provider-credentials` returns the created row with `name`, `last4`, `fingerprint` and `disabled: false`, and no `key` field.
- [integration] `POST /fleet/provider-credentials` by a user without `fleet.credential.create` returns 403.
- [integration] `POST /fleet/provider-credentials` with `providerId: 'Bad Id'` returns 400 naming `providerId`.
- [integration] A second `POST /fleet/provider-credentials` for the same `providerId` returns 409 with code `fleet.providerCredentials.duplicate`.
- [integration] With the vault off, `POST /fleet/provider-credentials` returns 503 with code `fleet.providerCredentials.vaultOff`.
- [integration] `POST /fleet/provider-credentials` records one `credential.created` activity row with entityType `provider_credential` whose payload keys are exactly `providerId`, `scope`, `name` and `fingerprint`.
- [integration] `POST /fleet/provider-credentials` records one audit entry with key `fleet.credential.create` and the credential id as resource id.
- [integration] `POST /fleet/provider-credentials` by an agent principal holding `fleet.credential.create` returns an approval request and creates no `ProviderCredential` row.
- [integration] The approval request created for that agent `POST` stores a body whose `key` is the `redactSecret` value, not `sk-or-abcdef123456`.
- [integration] Redeeming that approved request with a body carrying key `sk-or-zyxwvu987654` creates a row whose `last4` is `7654`.
- [unit] `PERMISSION_CATALOG` gives `fleet.credential.create` scope `global` and risk `high`.
- [unit] The en and zh API i18n files both carry `fleet.providerCredentials.duplicate` and `fleet.providerCredentials.vaultOff`.

### US-004: Rotate, disable and delete GLOBAL provider keys

- [integration] `PATCH /fleet/provider-credentials/:id` with a new `key` returns 200 with a `fingerprint` different from the old one.
- [integration] The rotate `PATCH` records one `credential.rotated` activity row whose payload keys are exactly `providerId`, `scope`, `name` and `fingerprint`.
- [integration] The rotate `PATCH` records one audit entry with key `fleet.credential.update`.
- [integration] `PATCH /fleet/provider-credentials/:id` with `{ disabled: true }` returns 200 with `disabled: true`.
- [integration] `PATCH /fleet/provider-credentials/:id` with `{ disabled: true }` records `credential.disabled`.
- [integration] `PATCH /fleet/provider-credentials/:id` with `{ disabled: false }` on a disabled key returns 200 with `disabled: false`.
- [integration] `PATCH /fleet/provider-credentials/:id` with `{ name: 'renamed' }` returns 200 with `name: 'renamed'` and the same `fingerprint`.
- [integration] After `DELETE /fleet/provider-credentials/:id`, `GET /fleet/provider-credentials` no longer lists the row.
- [integration] `DELETE /fleet/provider-credentials/:id` records `credential.deleted`.
- [integration] `PATCH /fleet/provider-credentials/:id` with the id of a PROJECT credential returns 404.
- [integration] `DELETE /fleet/provider-credentials/:id` with the id of a REPO credential returns 404.
- [integration] An agent rotate `PATCH` stores an approval request whose body `key` is the `redactSecret` value.
- [integration] `PATCH /fleet/provider-credentials/:id` by a user without `fleet.credential.update` returns 403.

### US-005: Manage PROJECT and REPO provider keys

- [integration] `POST /projects/:slug/provider-credentials` by a Project Admin without `repoId` returns 201 with `scope: 'PROJECT'` and that project's id.
- [integration] `POST /projects/:slug/provider-credentials` with the `repoId` of a repo in the project returns 201 with `scope: 'REPO'` and that `repoId`.
- [integration] `POST /projects/:slug/provider-credentials` with the `repoId` of a repo in another project returns 404 with code `fleet.repos`.
- [integration] `POST /projects/:slug/provider-credentials` by a Developer returns 403.
- [integration] `GET /projects/:slug/provider-credentials` by a Developer returns 200 with rows that have no `key` field.
- [integration] `GET /projects/:slug/provider-credentials` lists the project's PROJECT and REPO rows and no GLOBAL row.
- [integration] `PATCH /projects/:slug/provider-credentials/:id` for a credential of another project returns 404.
- [integration] `PATCH /projects/:slug/provider-credentials/:id` with the id of a GLOBAL credential returns 404.
- [integration] `DELETE /projects/:slug/provider-credentials/:id` for a credential of another project returns 404 and leaves it in place.
- [integration] `PATCH /projects/:slug/provider-credentials/:id` with a new `key` returns 200 with a new `fingerprint` and records `credential.rotated`.
- [integration] `DELETE /projects/:slug/provider-credentials/:id` returns 200 and records `credential.deleted` with the project's `projectId`.
- [integration] An agent `POST /projects/:slug/provider-credentials` stores an approval request whose body `key` is the `redactSecret` value.
- [unit] `PERMISSION_CATALOG` gives `project.credential.create` risk `high` and scope `project`.
- [unit] `PERMISSION_CATALOG` gives `project.credential.read` risk `low` and scope `project`.

### US-006: Hand provider keys to runners through sync

- [integration] `POST /fleet/runner/sync` with `providerRequests: [{ jobId, leaseEpoch, providerId: 'openrouter' }]` for the runner's RUNNING job, with an active GLOBAL `openrouter` key named `fleet`, returns one `providerKeys` entry with that `jobId`, `providerId` and the plaintext `key`.
- [integration] That grant carries `account: 'koda:global:fleet'` and the credential's `fingerprint`.
- [integration] That grant's `expiresAt` is 10 minutes after the sync time.
- [integration] The same sync with no resolvable key returns `providerKeyErrors: [{ jobId, providerId: 'openrouter', reason: 'none' }]`.
- [integration] A provider request for a job not in a runner-held state returns reason `job_not_active`.
- [integration] A provider request with a stale `leaseEpoch` returns no grant.
- [integration] A provider request with a stale `leaseEpoch` abandons the job, as a stale git token request does.
- [integration] With the vault off, a provider request returns reason `vault_off`.
- [integration] A provider request for a REPO thread job is granted the REPO key of the thread's `repoId`.
- [integration] A provider request for a PROJECT thread job, where a REPO key exists for a repo of the project and a PROJECT key exists, is granted the PROJECT key.
- [integration] A provider request for a WORKSPACE thread job, with a PROJECT key on the thread's `projectId` and a GLOBAL key, is granted the PROJECT key.
- [integration] The first grant for a job records one `credential.issued` activity row on that job with actor type `RUNNER` and payload `{ providerId, scope, name, fingerprint }`.
- [integration] A second sync granting the same credential with the same fingerprint to the same job records no second `credential.issued` row.
- [integration] A sync whose only content is a provider grant returns without waiting for the long-poll timeout.
- [unit] `parseSyncRequest` refuses a `providerRequests` array longer than 64 entries.

### US-007: Credential board shows koda keys and runner vault state

- [unit] `parseCapabilitiesCore` with `providerVault: true` returns capabilities with `providerVault: true`.
- [unit] `parseCapabilitiesCore` with `providerVault: 'yes'` returns capabilities without `providerVault`.
- [unit] `buildCredentialBoard` gives a runner whose capabilities carry `providerVault: true` the board flag `providerVault: true`.
- [unit] `buildCredentialBoard` gives a runner without `providerVault` the board flag `providerVault: false`.
- [integration] `GET /fleet/credential-board` lists each active GLOBAL key under `kodaKeys` as `{ providerId, name, last4, updatedAt }` with no `key` field.
- [integration] `GET /fleet/credential-board` omits disabled GLOBAL keys from `kodaKeys`.
- [integration] `GET /fleet/credential-board` omits PROJECT and REPO keys from `kodaKeys`.
- [integration] `GET /fleet/credential-board` with the vault off returns `kodaKeys: []`.

### US-008: Runner provider-key sockets and cache

- [unit] A socket from `CredentialServer.listenProviderKeys` answers the line `provider openrouter` with the provider reply's JSON on one line.
- [unit] A provider-key socket answers `provider Bad!` with `{ ok: false, reason: 'bad request' }` and does not call the provider reply.
- [unit] A provider-key socket answers `get` with `{ ok: false, reason: 'bad request' }`.
- [unit] `serveProviderKeys(job)` for a job whose clone URL is `git@github.com:o/n.git` returns a socket path that exists.
- [unit] Two `serveProviderKeys` calls for the same job and epoch return the same path and open one socket.
- [unit] A `provider openrouter` request on the job's socket queues a `ProviderKeyRequest` with the job's `jobId`, `leaseEpoch` and `openrouter`.
- [unit] That request resolves `{ ok: true, key, expiresAt, account }`, with `expiresAt` in epoch milliseconds, once `ProviderKeyCache.apply` receives the matching grant.
- [unit] A second request for the same provider within the lease is served from the cache without queuing a new request.
- [unit] A request within 60 s of the cached grant's `expiresAt` queues a new request.
- [unit] A request resolves `{ ok: false, reason: 'none' }` when the sync answers `none` for a provider never served to the job.
- [unit] A request resolves `{ ok: false, reason: 'revoked' }` when the sync answers `none` for a provider served to the job before.
- [unit] A request resolves `{ ok: false, reason: 'error' }` when no answer arrives within 55 s.
- [unit] `releaseProviderKeys(job)` removes the socket file and drops the job's cached grants.
- [integration] The real `SyncLoop` with the broker's provider cache sends queued requests in `providerRequests`, is not idle while they are queued, and applies `providerKeys` from a stubbed server response so a waiting socket request resolves ok.

### US-009: nax exec helper and fleet job env

- [unit] `runProviderCred(['get'])` with stdin `{"version":1,"providerId":"openrouter"}` and a socket answering `{ ok: true, key: 'k1', expiresAt: 1, account: 'koda:global:fleet' }` writes `{"version":1,"kind":"api-key","key":"k1","expiresAt":1,"account":"koda:global:fleet"}` and returns 0.
- [unit] `runProviderCred(['--socket', <path>, 'get'])` uses `<path>` even when `KODA_PROVIDER_CRED_SOCKET` names another socket.
- [unit] `runProviderCred(['get'])` with neither `KODA_PROVIDER_CRED_SOCKET` nor `--socket` writes `{"version":1,"decline":true}` and returns 0.
- [unit] `runProviderCred` with a socket answering reason `none` writes the decline reply and returns 0.
- [unit] `runProviderCred` with a socket answering reason `revoked` returns 1 with nothing written to stdout.
- [unit] `runProviderCred` with a socket path nothing listens on returns 1 with nothing written to stdout.
- [unit] The host executor calls `serveProviderKeys` for a RUN job and the nax env carries `KODA_PROVIDER_CRED_SOCKET` equal to the returned path.
- [unit] The host executor's FIX step spawn (`spawnFixStep`) env carries `KODA_PROVIDER_CRED_SOCKET`.
- [unit] The host executor calls `releaseProviderKeys` for the job in `cleanup()`.
- [unit] The host executor calls `releaseProviderKeys` for the job in `releaseCredentials()` (the abandon path).
- [unit] The host executor's `resumeCredentials` for a readopted job calls `serveProviderKeys` and gets the same path as before the restart.
- [unit] The config job's nax env carries `KODA_PROVIDER_CRED_SOCKET` equal to the path `serveProviderKeys` returned.
- [integration] `runProviderCred` against a real provider-key socket from `CredentialBroker.serveProviderKeys`, with the cache granting `k1`, writes the api-key reply with `key: 'k1'`.

### US-010: Runner vault enable and disable, and the providerVault capability

- [unit] `vault enable` on a `config.json` holding `{ "agent": { "x": 1 } }` leaves `{ "agent": { "x": 1 }, "auth": { "source": "exec", "exec": { "command": [...self argv, "provider-cred"], "timeoutMs": 60000 }, "onChange": "warn" } }`.
- [unit] `vault enable` with no `config.json` creates one holding only that `auth` block.
- [unit] `vault enable` writes through a temporary file in the same directory and renames it onto `config.json`.
- [unit] `vault enable` on a `config.json` that is not valid JSON exits non-zero and leaves the file byte-identical.
- [unit] `vault disable` removes `auth` and keeps every other key.
- [unit] The daemon's `vaultHelper` returns true when `config.json`'s `auth.exec.command` equals `[...self argv, "provider-cred"]`.
- [unit] The daemon's `vaultHelper` returns false when `auth.exec.command` names another helper.
- [unit] The capability probe with a `vaultHelper` resolving true reports `providerVault: true`.
- [unit] The capability probe with no `vaultHelper` omits `providerVault`.

### US-011: Native thread sessions use koda keys

- [unit] `ThreadSessionFactory.open` for a native thread on model `openrouter/qwen3` calls `providerKeys.granted('openrouter')`.
- [unit] When `granted` resolves true, `open` builds native backend options with `credentials: { kind: 'exec', command: [...self argv, 'provider-cred', '--socket', <providerKeys.socket>], timeoutMs: 60000 }`.
- [unit] When `granted` resolves false, `open` builds native backend options without `credentials`.
- [unit] When the thread pins no model, `open` calls `granted` with the provider of the runner's default model.
- [unit] `open` for an ACP thread never calls `granted`.
- [unit] `open` with no `providerKeys` builds native backend options without `credentials`.
- [unit] `open` for a native model id with no `/` builds native backend options without `credentials` and never calls `granted`.
- [unit] `ThreadJobRun` for a PROJECT thread calls `serveProviderKeys` before opening the session.
- [unit] `ThreadJobRun` calls `releaseProviderKeys` for the job when `start()` returns.
- [unit] `ThreadJobRun.abandon()` calls `releaseProviderKeys` for the job.
- [integration] A REPO thread turn through `ThreadJobRun` with a real `CredentialBroker`, whose provider cache grants `openrouter`, opens the native session with exec `credentials` whose `--socket` is a socket that answers `provider openrouter` with the grant.

### US-012: Web admin provider keys page and board column

- [unit] `/admin/fleet/provider-keys` lists rows from `GET /fleet/provider-credentials` showing `providerId`, `name`, `last4`, `fingerprint` and disabled state.
- [unit] Submitting the add form calls `POST /fleet/provider-credentials` with `{ providerId, name, key }`.
- [unit] After a successful add, the key input is empty.
- [unit] The add form refuses a `providerId` with uppercase letters with a translated validation message and sends no request.
- [unit] Rotate calls `PATCH /fleet/provider-credentials/:id` with `{ key }` only.
- [unit] Disable calls `PATCH /fleet/provider-credentials/:id` with `{ disabled: true }`.
- [unit] Enable calls `PATCH /fleet/provider-credentials/:id` with `{ disabled: false }`.
- [unit] Delete calls `DELETE /fleet/provider-credentials/:id` only after the confirmation is accepted.
- [unit] A write answered with an approval request shows the translated pending notice and adds no row.
- [unit] The add control is hidden when `useGlobalPermissions().permissions.value.has('fleet.credential.create')` is false.
- [unit] A refused request shows `extractApiError(err)` through the app toast.
- [unit] The credential board page shows a koda column with each `kodaKeys` entry's `name` and `last4` on its provider row.
- [unit] The credential board page shows a "vault off" marker for a runner with `providerVault: false`.

### US-013: Web project provider keys card

- [unit] `SettingsProviderKeysCard` lists rows from `GET /projects/:slug/provider-credentials`, PROJECT rows under a Project heading and REPO rows under their repo's name.
- [unit] Adding a project key calls `POST /projects/:slug/provider-credentials` with `{ providerId, name, key }` and no `repoId`.
- [unit] Adding a repo key calls `POST /projects/:slug/provider-credentials` with the chosen repo's `repoId`.
- [unit] Rotate calls `PATCH /projects/:slug/provider-credentials/:id` with `{ key }` only.
- [unit] Disable calls `PATCH /projects/:slug/provider-credentials/:id` with `{ disabled: true }`.
- [unit] Delete calls `DELETE /projects/:slug/provider-credentials/:id` only after the confirmation is accepted.
- [unit] A write answered with an approval request shows the translated pending notice and adds no row.
- [unit] The add control is hidden when `useProjectPermissions(slug).permissions.value.has('project.credential.create')` is false.
- [unit] A refused request shows `extractApiError(err)` through the app toast.

### US-014: Rulings refuse items nax can never settle

- [unit] `ruleTarget` for an open item whose `kind` is `ci` throws a conflict with code `fleet.rulings.notRulable`.
- [unit] `assertItemIndex` for a GitHub target whose PR comments include one containing `<!-- nax-bot:v1 key=w-index -->` resolves.
- [unit] `assertItemIndex` for a GitHub target whose 3 PR comments contain no such marker throws a conflict with code `fleet.rulings.noItemIndex`.
- [unit] `assertItemIndex` resolves when `listIssueComments` throws.
- [unit] `assertItemIndex` resolves when `listIssueComments` returns 100 comments and none carries the marker.
- [unit] `assertItemIndex` resolves without a forge read when the target repo has no GitHub installation id.
- [unit] `findTarget` and `lockTarget` both return the job's repo `provider`, `owner`, `name` and `githubInstallationId` under `repo`.
- [unit] The assistant ruling tool refuses with `fleet.rulings.noItemIndex` when `preflight` throws it, and creates no ruling.
- [unit] `GitHubAppClient.listIssueComments(token, 'o', 'n', 7)` requests `GET /repos/o/n/issues/7/comments?per_page=100` with the given token and returns each comment's `body`.
- [unit] `GitHubAppClient.listIssueComments` throws a provider error on a non-200 response.
- [unit] `GitHubAppClient.listIssueComments` aborts the request after 5 seconds.
- [integration] `POST /projects/:slug/fleet/jobs/:id/rulings` for a `ci` item returns 409 with code `fleet.rulings.notRulable` and creates no ruling.
- [integration] `POST /projects/:slug/fleet/jobs/:id/rulings` for a finding on a GitHub draft whose stubbed comments lack the marker returns 409 with code `fleet.rulings.noItemIndex`.
- [unit] The en and zh API i18n files both carry `fleet.rulings.notRulable` and `fleet.rulings.noItemIndex`.

### US-015: Web hides Rule on CI items and explains unknown-item

- [unit] `FleetJobOpenItems` renders no Rule action for an open item whose `kind` is `ci`.
- [unit] `FleetJobOpenItems` renders the Rule action for an open item whose `kind` is `finding`.
- [unit] `FleetJobOpenItems` renders the skip reason `unknown-item` with the en label "This PR has no nax item index (published before nax 0.91.2); re-run to republish".
- [unit] The zh locale carries a translation for `fleet.rulings.skipReason.unknown-item`.
