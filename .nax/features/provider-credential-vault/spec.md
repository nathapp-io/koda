<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Provider credential vault (C10)

Closes: #371, #394

## Summary

An admin adds a provider API key (OpenRouter, DeepSeek, OpenAI, ...) once in koda, and every runner's fleet jobs and
native thread sessions use it, with no `nax auth login` on the machine. Keys exist at three scopes: GLOBAL
(fleet-wide), PROJECT and REPO; the most specific active key wins. koda stores each key encrypted, never shows it again
after it is saved, and records which job or thread was handed which key (by name and fingerprint). Runners serve the
key to nax through nax-agent's `credentials.source: "exec"` helper contract over the existing per-job credential
socket. A machine-local `nax auth` credential keeps working for any provider koda holds no key for.

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
  is off: management routes refuse with 503 and hand-outs answer `none`; the API still boots.
- Uniqueness uses a computed `scopeKey` string (`global`, `project:<projectId>`, `repo:<repoId>`) with
  `@@unique([scopeKey, providerId])`, because Postgres treats NULL columns as distinct.
- Fingerprint = first 12 hex chars of HMAC-SHA256(master key, plaintext key); `last4` = last 4 chars of the key.
- Hand-out lease `expiresAt = now + 10 min`. One `credential.issued` activity row per (job, credential, fingerprint).
- Thread jobs resolve from the thread's own `projectId` and `repoId` (null for PROJECT and WORKSPACE threads); fleet jobs
  from `FleetJob.projectId` and `FleetJob.repoId`.
- Project-scope keys are `project.credential.read|create|update|delete`; `project.credential.` joins
  `HIGH_RISK_PREFIXES`. Global writes are `fleet.credential.create|update|delete` (the prefix is already high risk).
- The runner never edits nax config on its own; `koda-runner vault enable|disable` does, atomically.
- Helper timeout 60000 ms (nax's schema maximum); the socket holds a provider reply open up to 55 s.
- Per-job value redaction covers shipped job/thread log lines and diagnostics; bundle files are out of scope (the key
  is never in the job env or on disk).
- #394: refuse `ci` items (409 `fleet.rulings.notRulable`); pre-check the `w-index` marker with a forge read that fails
  open; the web hides Rule on `ci` items and explains `unknown-item`. The CLI keeps printing the raw skip reason.

### Integration

Symbols this feature only reads (verified):

- `encryptToken(plaintext: string, masterKey: string): string` and `decryptToken(ciphertext: string, masterKey:
  string): string` in `apps/api/src/common/utils/encryption.util.ts` (AES-256-GCM, 32-byte hex key).
- `vcsConfig` / `VCS_CFG` / `IVcsConfig` in `apps/api/src/config/vcs.config.ts`; `VCS_ENCRYPTION_KEY:
  Joi.string().hex().length(64).optional()` in `apps/api/src/config/env.validation.ts:32` — the pattern for the new key.
- `FleetActivityService.record(entry: FleetActivityEntry): Promise<void>` (`apps/api/src/fleet/activity/
  fleet-activity.service.ts`); a payload key matching `/token|secret|key|password|credential/i` throws, so payloads
  use `providerId`, `scope`, `name`, `fingerprint` only.
- `FenceService.holds(job, runnerId, leaseEpoch)` and `RUNNER_HELD_STATES` (`apps/api/src/fleet/sync/fence.service.ts`,
  `apps/api/src/fleet/jobs/job-state.ts`).
- `findThreadTokenScope(jobId)` (`apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts:265`).
- `GitHubAppClient.mintThreadReadToken(installationId, repoName)` (pull_requests:read) and `getPullRequest(token, owner,
  name, number)` in `apps/api/src/fleet/git-broker/github-app-client.ts`.
- `@ApprovalGated({ redeem: true })` + `@ApprovalRedeemHeader()` on high-risk writes (precedent
  `apps/api/src/vcs/vcs.controller.ts:68-70`).
- nax helper contract (`@nathapp/nax-agent` 0.91.7, `native/credentials/exec-source.ts`, `helper-protocol.ts`): argv
  `[...command, "get"]`; stdin `{"version":1,"providerId":"<id>"}`; reply `{"version":1,"kind":"api-key","key":"...",
  "expiresAt":<epoch ms>,"account":"..."}` or `{"version":1,"decline":true}`; non-zero exit = failure. A decline for a
  provider that already holds a lease is invalid. `kind` must be `api-key`; `key` <= 8192 chars; `account` <= 200 chars.
- nax `auth` is global-only (`nax/src/config/global-only-keys.ts:53`): it is read only from
  `<NAX_GLOBAL_CONFIG_DIR>/config.json`. Its shape: `auth: { source: "file" | "exec", exec?: { command: string[],
  timeoutMs: number }, onChange: "warn" | "refuse" }`. The process-wide store asks the helper first and falls back to
  the credentials file on a decline.
- nax-agent per-session source: `NativeBackendOptions.credentials?: { kind: "exec"; command: readonly string[];
  timeoutMs?: number; onChange?: "warn" | "refuse" }` — exec only, no file fallback.
- Runner: `CredentialBroker` (`apps/runner/src/credentials/broker.ts`), `TokenCache`
  (`credentials/token-cache.ts`), `socketPathFor` (`credentials/socket-dir.ts`), `withoutCredentialVars`
  (`credentials/credential-env.ts`), `naxCredentialsConfig(naxHome)` (`thread/nax-credentials.ts`).

The baselines below exist only to locate the code. Never implement a baseline; implement the target.

- `SyncRequest` / `SyncResponse` (`packages/fleet-protocol/src/index.ts:246`, `:301-313`).
  Baseline: `SyncRequest.tokenRequests: TokenRequest[]`; `SyncResponse { jobAcks, commands, gitTokens, gitTokenErrors,
  unknownJobIds, archivedThreadIds?, nextPollAfterMs? }`.
  Target: adds `SyncRequest.providerRequests?: ProviderKeyRequest[]` with `ProviderKeyRequest { jobId: string;
  leaseEpoch: number; providerId: string }`; adds `SyncResponse.providerKeys?: ProviderKeyGrant[]` with
  `ProviderKeyGrant { jobId; providerId; key; expiresAt: string; account: string; fingerprint: string }` and
  `SyncResponse.providerKeyErrors?: ProviderKeyError[]` with `ProviderKeyError { jobId; providerId; reason: 'none' |
  'job_not_active' | 'vault_off' }`. `SYNC_LIMITS.providerRequests = 64` in
  `apps/api/src/fleet/sync/sync-request.parser.ts`.
- `RunnerCapabilities` (`packages/fleet-protocol/src/index.ts:82`, parsed in `apps/api/src/fleet/common/
  capabilities-core.ts:214`). Baseline: `threadModes?: true`. Target: also `providerVault?: true`, parsed the same way.
- `CredentialServer.listen(path, reply)` (`apps/runner/src/credentials/cred-server.ts:56`).
  Baseline: `listen(path: string, reply: () => Promise<CredentialReply>)`; `serve()` refuses any line other than `get`.
  Target: `listen(path, reply, providerReply?: (providerId: string) => Promise<ProviderReply>)` with `ProviderReply =
  { ok: true; key: string; expiresAt: number; account: string } | { ok: false; reason: 'none' | 'revoked' | 'error' }`;
  `serve()` answers `get` as before and `provider <providerId>` through `providerReply`.
- `dispatchInternal(argv)` (`apps/runner/src/internal-commands.ts`). Baseline: handles `git-cred` and `shim`. Target:
  also handles `provider-cred`.
- `ThreadSessionFactory.open(input)` (`apps/runner/src/thread/session-factory.ts:108`). Baseline: native
  `backendOptions` carry no `credentials`. Target: native `backendOptions` carry `credentials: { kind: 'exec', command,
  timeoutMs: 60000 }` when koda resolves a key for the session model's provider.
- `FleetPrRulingsService.ruleTarget(projectId, jobId, dto)` (`apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts:84`).
  Baseline: refuses `notDraft`, `notLatest`, `unknownItem`, `invalidText`, `settled`. Target: also refuses
  `notRulable` (item kind `ci`) and `noItemIndex` (no `w-index` marker on the PR).

Patterns to follow: `apps/api/src/vcs/` (encrypted secret + project routes + approval gate),
`apps/api/src/fleet/repos/fleet-repos.service.ts` (fleet CRUD with activity), `apps/runner/src/credentials/`
(per-job socket and cache), `SettingsVcsCard.vue` (project settings card).

### Approach

**Storage (api).** Model `ProviderCredential` (`id`, `scope` `GLOBAL|PROJECT|REPO` as a string, `scopeKey`,
`projectId?`, `repoId?`, `providerId`, `name`, `encryptedKey`, `last4`, `fingerprint`, `createdById`, `updatedById`,
`disabledAt?`, timestamps), `@@unique([scopeKey, providerId])`, `@@index([providerId])`. `providerId` matches
`^[a-z0-9][a-z0-9._-]{0,47}$`; `name` 1-64 chars; a key is 8-8192 chars with no whitespace. A `SecretStore` interface
(`seal(plaintext) -> { encryptedKey, last4, fingerprint }`, `open(encryptedKey) -> plaintext`) with one implementation,
`LocalSecretStore`, over `encryptToken`/`decryptToken` and the config namespace `providerCredentials`
(`PROVIDER_CREDENTIAL_ENCRYPTION_KEY`).

**Resolution.** `ProviderCredentialsService.resolve({ projectId, repoId | null, providerId })` returns the active
(`disabledAt` null) REPO key for `repoId`, else the PROJECT key, else the GLOBAL key, else null.

**Management.** Global routes `GET|POST /fleet/provider-credentials`, `PATCH|DELETE /fleet/provider-credentials/:id`
(`fleet.credential.read|create|update|delete`). Project routes `GET|POST /projects/:slug/provider-credentials`,
`PATCH|DELETE /projects/:slug/provider-credentials/:id` (`project.credential.read|create|update|delete`); a POST with
`repoId` creates a REPO key for a repo of that project. PATCH takes any of `name`, `key` (rotate), `disabled`
(boolean). Every response row is `{ id, scope, projectId, repoId, providerId, name, last4, fingerprint, disabled,
createdBy, updatedAt }` and never the key. Writes are `@ApprovalGated({ redeem: true })` and record `FleetActivity`
(`credential.created|rotated|updated|disabled|enabled|deleted`, entityType `provider_credential`).

**Hand-out (api).** `SyncService` handles `providerRequests` like `tokenRequests`: fence (a stale epoch abandons, as
for tokens), job state in `RUNNER_HELD_STATES` (else `job_not_active`), vault off (`vault_off`), resolve (null =
`none`), else a grant with `account = koda:<scope lowercase>:<name>` and `expiresAt = now + 10 min`, plus the
deduped `credential.issued` activity row on the job (`payload { providerId, scope, name, fingerprint }`).

**Runner, fleet jobs.** The broker serves `provider <id>` on each job socket. A `ProviderKeyCache` (mirroring
`TokenCache`) queues `providerRequests` on the sync batch and applies `providerKeys`/`providerKeyErrors`. The socket
reply waits up to 55 s for an answer, serves a cached grant until 60 s before `expiresAt`, and remembers which
providers it has served for the job: once served, a later `none` becomes `revoked`. The helper `koda-runner
provider-cred get` reads the nax request from stdin, uses env `KODA_PROVIDER_CRED_SOCKET` (or `--socket <path>`), and
maps: env and flag both absent -> decline; `none` -> decline; ok -> the api-key reply; `revoked`, `error`, socket
failure -> exit 1 with a one-line stderr message. Fleet job env (run, plan, review, fix, config jobs) gains
`KODA_PROVIDER_CRED_SOCKET=<job socket>`.

**Runner, nax config.** `koda-runner vault enable` writes `auth: { source: "exec", exec: { command: [<self>,
"provider-cred"], timeoutMs: 60000 }, onChange: "warn" }` into `<naxHome>/config.json`, keeping every other key, via a
temp file + rename; `vault disable` removes `auth`. The capability probe reports `providerVault: true` exactly when
`config.json`'s `auth.exec.command` is `[<self>, "provider-cred"]`.

**Runner, threads.** At native session open the factory derives `providerId` from the session model id (the text
before the first `/`), asks the broker for that provider on the thread job, and on a grant opens with
`credentials: { kind: 'exec', command: [<self>, 'provider-cred', '--socket', <thread job socket>], timeoutMs: 60000 }`;
on `none` it opens without `credentials` (process-wide store, machine-local). Every open (first turn, resume, mode or
model switch) runs this check.

**Redaction (runner).** A per-job registry of served key values; the log shipper and `sanitizeDiagnostic` callers for
that job replace each with `[koda-key:<fingerprint>]`.

**Visibility.** Credential board gains `kodaKeys: { providerId, name, last4, updatedAt }[]` (active GLOBAL keys) and a
per-runner `providerVault` flag; the admin page shows a "koda" column and "vault off" for runners without it. The
admin page `/admin/fleet/provider-keys` manages GLOBAL keys; project settings gain a "Provider keys" card with
PROJECT and REPO rows.

**#394.** `ruleTarget` refuses `kind === 'ci'` before any forge read. For GitHub repos it then lists the PR's issue
comments (new `GitHubAppClient.listIssueComments(token, owner, name, number)`, first 100) with the thread-read token
and refuses `noItemIndex` when no comment body contains `key=w-index`; a forge error accepts the ruling. Web
`FleetJobOpenItems.vue` hides Rule on `ci` items and the `fleet.rulings.skipReason.unknown-item` label explains
("This PR has no nax item index (published before nax 0.91.2); re-run to republish").

### Failure Handling

| Case | Behaviour |
|:--|:--|
| Master key unset | Management routes 503 `fleet.providerCredentials.vaultOff`; hand-outs answer `vault_off`; helper declines; API boots |
| Master key wrong length | Boot fails (env validation), as for `VCS_ENCRYPTION_KEY` |
| Ciphertext cannot be decrypted | Hand-out answers `none` and logs a warning with the credential id only |
| Duplicate key at the same scope and provider | 409 `fleet.providerCredentials.duplicate` |
| REPO key for a repo of another project | 404 `fleet.repos` |
| Key revoked during a run | Runner replies `revoked`; helper exits 1; nax fails the call |
| Socket unreachable / job ended | Helper exits 1 with a stderr line, never declines |
| Helper run outside a koda job | Helper declines; nax uses the credentials file |
| Provider reply not ready in 55 s | Socket answers `error`; helper exits 1 |
| `w-index` forge read fails | Ruling accepted (fail open) |

## Out of Scope

- OAuth or subscription logins (Claude, ChatGPT, Copilot, Gemini) are not stored or served by koda; nax's exec helper accepts only `kind: "api-key"`.
- ACP thread backends (Claude Code, Codex, Cursor) keep their own sign-ins on the runner host and never receive koda keys.
- An LLM proxy or gateway in front of providers (one koda key for all providers) is not built.
- Spend caps or rate limits per provider key are not enforced; existing C1 job budgets are unchanged.
- HashiCorp Vault, OpenBao and cloud KMS backends are not built; only the local encrypted `SecretStore` exists.
- Re-encrypting stored keys under a new master key (master key rotation) is not built.
- Secrecy from the agent is not claimed: the agent's Bash runs as the runner uid and can reach the job socket.
- Placement does not prefer or require runners with `providerVault`; a job on a runner without the helper uses that machine's own credentials.
- Value redaction of bundle files and of nax's own output files is not done; only shipped log lines and diagnostics are redacted.
- The runner never edits `<naxHome>/config.json` except through `koda-runner vault enable` and `vault disable`.
- The CLI gets no provider-key commands and keeps printing the raw ruling skip reason.
- GitLab merge requests get no `w-index` pre-check; rulings are GitHub-only today.
- Agents (MCP tools) get no provider-key tools.

## Stories

### US-001: Encrypted provider credential storage

Workdir: `apps/api`. No dependencies. Prisma model `ProviderCredential` + migration; config namespace
`providerCredentials` with `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` (Joi hex length 64, optional); `SecretStore` interface
and `LocalSecretStore`; repository behind `PROVIDER_CREDENTIAL_REPOSITORY`; `ProviderCredentialsModule`.

### US-002: Resolve and issue the most specific key

Workdir: `apps/api`. Depends on US-001. `ProviderCredentialsService` with `isEnabled`, `resolve` (REPO, then PROJECT,
then GLOBAL, active rows only) and `issueKey` (decrypt for a hand-out).

### US-003: Manage GLOBAL provider keys

Workdir: `apps/api`. Depends on US-002. Catalog keys `fleet.credential.create|update|delete` (global);
`FleetProviderCredentialsController` (`/fleet/provider-credentials`), DTOs, approval gating, activity rows, i18n
namespace `providerCredentials` (en, zh), openapi regen.

### US-004: Manage PROJECT and REPO provider keys

Workdir: `apps/api`. Depends on US-003. Catalog keys `project.credential.read|create|update|delete` (project);
`project.credential.` added to `HIGH_RISK_PREFIXES`; `ProjectProviderCredentialsController`
(`/projects/:slug/provider-credentials`), the repo-belongs-to-project check, openapi regen.

### US-005: Hand provider keys to runners through sync

Workdir: `apps/api`. Depends on US-002. Protocol types `ProviderKeyRequest`, `ProviderKeyGrant`, `ProviderKeyError`;
parser limit; `SyncService` grants with fence, state, vault-off and resolution checks; thread-job scope; deduped
`credential.issued` activity.

### US-006: Credential board shows koda keys and runner vault state

Workdir: `apps/api`. Depends on US-002. `RunnerCapabilities.providerVault` parsed in `parseCapabilitiesCore`;
`buildCredentialBoard` output and `CredentialBoardDto` gain `kodaKeys` and per-runner `providerVault`; openapi regen.

### US-007: Runner job sockets answer provider key requests

Workdir: `apps/runner`. Depends on US-005. `CredentialServer` `provider <id>` line; `ProviderKeyCache` on the sync
batch; broker provider reply with the 55 s wait, the cache and the served set (`revoked`).

### US-008: nax exec helper and job env

Workdir: `apps/runner`. Depends on US-007. `provider-cred` internal command (`runProviderCred`);
`KODA_PROVIDER_CRED_SOCKET` in fleet job and config job env.

### US-009: Runner vault enable and disable, and the providerVault capability

Workdir: `apps/runner`. Depends on US-008. `vault enable|disable` commander commands writing `<naxHome>/config.json`
atomically with the `provider-cred` helper command; the probe's `providerVault` flag.

### US-010: Native thread sessions use koda keys

Workdir: `apps/runner`. Depends on US-007. `ThreadSessionFactory.open` derives the provider, asks the broker, and sets
the per-session exec `credentials` on a grant.

### US-011: Runner redacts served keys from shipped output

Workdir: `apps/runner`. Depends on US-007. Per-job served-value registry; the log shipper and job diagnostics replace
served values with `[koda-key:<fingerprint>]`.

### US-012: Web admin provider keys page and board column

Workdir: `apps/web`. Depends on US-003, US-006. Page `/admin/fleet/provider-keys` (list, add, rotate, disable/enable,
delete) gated on `fleet.credential.*`; board koda column and "vault off" runner marker.

### US-013: Web project provider keys card

Workdir: `apps/web`. Depends on US-004. `SettingsProviderKeysCard.vue` on project settings with PROJECT and per-REPO
rows, gated on `project.credential.*`.

### US-014: Rulings refuse items nax can never settle

Workdir: `apps/api`. No dependencies. `ruleTarget` refuses `ci` items and drafts without a `w-index` marker;
`GitHubAppClient.listIssueComments`; i18n keys (en, zh).

### US-015: Web hides Rule on CI items and explains unknown-item

Workdir: `apps/web`. Depends on US-014. `FleetJobOpenItems.vue` hides Rule on `ci` items; the `unknown-item` skip
label explains the missing item index (en, zh).

### Context Files

**US-001**
- `apps/api/src/common/utils/encryption.util.ts` — encrypt/decrypt to reuse
- `apps/api/src/config/vcs.config.ts` — config namespace pattern
- `apps/api/src/config/env.validation.ts` — Joi entry for the new env
- `apps/api/prisma/schema.prisma` — where the model goes
- `apps/api/src/vcs/prisma-vcs.repository.ts` — repository precedent

**US-002**
- `apps/api/src/fleet/provider-credentials/provider-credential.domain.ts` — created by US-001, read here
- `apps/api/src/fleet/provider-credentials/prisma-provider-credential.repository.ts` — created by US-001, read here
- `apps/api/src/fleet/provider-credentials/secret-store.ts` — created by US-001, read here

**US-003**
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`
- `apps/api/src/fleet/dashboard/fleet-credential-board.controller.ts` — global route precedent
- `apps/api/src/vcs/vcs.controller.ts` — approval gate precedent
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — activity recording precedent
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — endpoint lifecycle coverage

**US-004**
- `apps/api/src/permissions/catalog.ts` — `NEW_KEY_SCOPES`, `HIGH_RISK_PREFIXES`
- `apps/api/src/vcs/vcs.controller.ts` — project route precedent
- `apps/api/src/fleet/provider-credentials/fleet-provider-credentials.controller.ts` — created by US-003, mirrored here
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — repo lookup

**US-005**
- `packages/fleet-protocol/src/index.ts` — sync wire types
- `apps/api/src/fleet/sync/sync.service.ts` — `grantTokens` precedent
- `apps/api/src/fleet/sync/sync-request.parser.ts` — `parseTokenRequest`, `SYNC_LIMITS`
- `apps/api/src/fleet/sync/fence.service.ts` — fence
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findThreadTokenScope`

**US-006**
- `apps/api/src/fleet/common/capabilities-core.ts` — `parseCapabilitiesCore`
- `apps/api/src/fleet/dashboard/credential-board.ts` — board derivation
- `apps/api/src/fleet/dashboard/credential-board.service.ts` — board service
- `apps/api/src/fleet/dashboard/dto/credential-board.dto.ts` — board DTO

**US-007**
- `apps/runner/src/credentials/cred-server.ts` — socket protocol
- `apps/runner/src/credentials/broker.ts` — per-job servers and replies
- `apps/runner/src/credentials/token-cache.ts` — cache pattern to mirror
- `apps/runner/src/sync/sync-loop.ts` — request/response wiring
- `apps/runner/src/sync/batch.ts` — request batching

**US-008**
- `apps/runner/src/internal-commands.ts` — internal command dispatch
- `apps/runner/src/executor/host-executor.ts` — fleet job env
- `apps/runner/src/executor/config-job/config-job.ts` — config job env
- `apps/runner/src/credentials/git-credential.ts` — socket client precedent (`requestCredential`)

**US-009**
- `apps/runner/src/main.ts` — commander commands
- `apps/runner/src/config/runner-config.ts` — `naxHome`
- `apps/runner/src/capabilities/nax-probe.ts` — capability flags
- `apps/runner/src/self-command.ts` — the runner's own argv

**US-010**
- `apps/runner/src/thread/session-factory.ts` — the open path
- `apps/runner/src/thread/thread-job-run.ts` — thread job credentials and session opens
- `apps/runner/src/credentials/broker.ts` — provider replies (changed by US-007)
- `apps/runner/src/daemon/daemon.ts` — factory wiring

**US-011**
- `apps/runner/src/logs/log-shipper.ts` — shipped lines
- `apps/runner/src/diagnostics.ts` — `sanitizeDiagnostic`
- `apps/runner/src/credentials/broker.ts` — where values are served

**US-012**
- `apps/web/pages/admin/fleet/credentials.vue` — board page
- `apps/web/pages/admin/fleet/repos.vue` — admin fleet page pattern
- `apps/web/i18n/locales/en.json` — locale keys

**US-013**
- `apps/web/pages/[project]/settings.vue` — settings page
- `apps/web/components/SettingsVcsCard.vue` — card pattern
- `apps/web/i18n/locales/en.json` — locale keys

**US-014**
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts` — `ruleTarget`
- `apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts` — `findTarget` (repo, openItems)
- `apps/api/src/fleet/git-broker/github-app-client.ts` — `mintThreadReadToken`, `getPullRequest`

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
- `apps/api/src/fleet/provider-credentials/dto/provider-credential.dto.ts`
- `apps/api/src/i18n/en/providerCredentials.json`
- `apps/api/src/i18n/zh/providerCredentials.json`

**US-004**
- `apps/api/src/fleet/provider-credentials/project-provider-credentials.controller.ts`

**US-007**
- `apps/runner/src/credentials/provider-key-cache.ts`

**US-008**
- `apps/runner/src/credentials/provider-cred.ts`

**US-009**
- `apps/runner/src/commands/vault.ts`

**US-011**
- `apps/runner/src/credentials/served-secrets.ts`

**US-012**
- `apps/web/pages/admin/fleet/provider-keys.vue`
- `apps/web/composables/useProviderCredentials.ts`

**US-013**
- `apps/web/components/SettingsProviderKeysCard.vue`

### Modifies

**US-001**
- `apps/api/src/config/env.validation.spec.ts` — if it pins the exact set of env keys, it gains optional `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` (64 hex); other keys unchanged.

**US-002**
None. A new service only; no existing assertion pins its absence.

**US-003**
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — the role matrix gains `fleet.credential.create`, `fleet.credential.update` and `fleet.credential.delete`, held by Owner and Admin through `*` and by no other role.
- `openapi.json` — regenerated for the new global routes.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains the GLOBAL provider-credential lifecycle (create, list without key, rotate, disable, delete) with one error case per endpoint.

**US-004**
- `apps/api/src/permissions/catalog.spec.ts` — its mirrored `HIGH_RISK_PREFIXES` list gains `project.credential.`; every other prefix unchanged.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — the role matrix gains `project.credential.read|create|update|delete`: Project Admin holds all four through `*`; every other project role holds `project.credential.read` through `*.read` and no write key.
- `openapi.json` — regenerated for the new project routes.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains the PROJECT and REPO provider-credential lifecycle with one error case per endpoint.

**US-005**
- `apps/api/src/fleet/sync/sync-request.parser.spec.ts` — if it pins the exact accepted request keys, an optional valid `providerRequests` array is now accepted; an over-limit or malformed array is still refused.

**US-006**
- `apps/api/src/fleet/common/capabilities.spec.ts` — if it pins the exact parsed capability keys, `providerVault: true` is kept when reported and absent otherwise.
- `apps/api/src/fleet/dashboard/credential-board.spec.ts` — its expected board shape gains `kodaKeys` and a per-runner `providerVault` boolean; every existing cell expectation unchanged.
- `openapi.json` — regenerated for the board DTO.

**US-007**
- `apps/runner/test/unit/cred-server.spec.ts` — its case asserting every non-`get` line answers `bad request` becomes: `provider <id>` with a valid id is answered through the provider reply; any other line, and `provider` with an invalid id, still answers `bad request`.
- `apps/runner/src/sync/sync-loop.spec.ts` — if it pins the exact request body, the body may also carry `providerRequests` from the provider cache, and omits it when the cache is empty.

**US-008**
- `apps/runner/test/unit/host-executor.spec.ts` — if it pins the exact nax env, the env also carries `KODA_PROVIDER_CRED_SOCKET` set to the job socket path.
- `apps/runner/test/unit/config-job.spec.ts` — if it pins the exact nax env, the env also carries `KODA_PROVIDER_CRED_SOCKET` set to the job socket path.

**US-009**
- `apps/runner/src/capabilities/nax-probe.spec.ts` — its expected capabilities gain `providerVault: true` only when the nax config has the koda helper; absent otherwise.

**US-010**
- `apps/runner/test/unit/thread-session-factory.spec.ts` — its expected native backend options gain `credentials` only when the injected provider lookup grants a key; unchanged otherwise.

**US-011**
- `apps/runner/src/logs/log-shipper.spec.ts` — shipped lines for a job whose socket served a key have that key value replaced by `[koda-key:<fingerprint>]`; lines for other jobs unchanged.

**US-012**
None. New page and composable only; the board page gains a column without changing existing assertions.

**US-013**
None. New card only; the settings page gains one card without changing existing assertions.

**US-014**
- `apps/api/src/fleet/rulings/fleet-pr-rulings.service.spec.ts` — its accepted-ruling fixtures must use a non-`ci` item and a stubbed forge read that returns a `key=w-index` comment; refusal order otherwise unchanged.

**US-015**
- `apps/web/tests/components/FleetJobOpenItems.spec.ts` — any case expecting a Rule action on an open item of kind `ci` becomes: no Rule action for `ci`; Rule stays for every other kind.
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — parity holds with the changed `unknown-item` label in en and zh.

### Seams

- US-002 `ProviderCredentialsService.resolve` is called by US-005's `SyncService` (seam ACs in US-005 through the runner sync route).
- US-002 `ProviderCredentialsService` writes are called by US-003 and US-004 controllers (seam ACs through the HTTP routes).
- US-005 `ProviderKeyGrant` on `SyncResponse` is consumed by US-007's `ProviderKeyCache` (seam AC in US-007 through the sync loop).
- US-007 broker provider reply is called by US-008's helper over the socket and by US-010's factory (seam ACs in US-008 and US-010).
- US-007 served values feed US-011's registry (seam AC in US-011 through the broker reply and the log shipper).
- US-006 `kodaKeys` and `providerVault` on `CredentialBoardDto` are rendered by US-012.
- US-015 consumes `kind` already on each open item and the existing skip-reason label lookup.

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
- [unit] The `providerCredentials` config namespace exposes `encryptionKey` read from `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`, and `undefined` when it is unset.
- [integration] Inserting two `ProviderCredential` rows with the same `scopeKey` and `providerId` fails the second insert with a unique-constraint error.
- [integration] A GLOBAL row (`scopeKey: 'global'`) and a PROJECT row (`scopeKey: 'project:<id>'`) for the same `providerId` coexist.
- [unit] Compiling `ProviderCredentialsModule` with mocked `PrismaService`, `TRANSACTION_MANAGER` and config resolves the `PROVIDER_CREDENTIAL_REPOSITORY` token inside the module.

### US-002: Resolve and issue the most specific key

- [unit] With the `providerCredentials` `encryptionKey` unset, `ProviderCredentialsService.isEnabled()` returns false.
- [unit] With a 64-hex `encryptionKey`, `ProviderCredentialsService.isEnabled()` returns true.
- [unit] `resolve({ projectId: 'p1', repoId: 'r1', providerId: 'openrouter' })` returns the REPO key when active REPO, PROJECT and GLOBAL keys exist for `openrouter`.
- [unit] `resolve` with `repoId: 'r1'` returns the PROJECT key when the only REPO key for `r1` is disabled.
- [unit] `resolve` with `repoId: null` returns the GLOBAL key when no PROJECT key exists for `p1`.
- [unit] `resolve` returns null when the only `openrouter` key is a PROJECT key of another project.
- [unit] `resolve` returns null when the only `openrouter` key is a disabled GLOBAL key.
- [unit] `resolve` returns null when the vault is off, and does not call the repository.
- [unit] `issueKey(credential)` returns the decrypted plaintext of a credential sealed by `LocalSecretStore`.
- [unit] `issueKey` returns null when decryption throws.
- [unit] `issueKey` logs a warning containing the credential id and not the ciphertext when decryption throws.

### US-003: Manage GLOBAL provider keys

- [integration] `POST /fleet/provider-credentials` by a global Admin with `{ providerId: 'openrouter', name: 'fleet', key: 'sk-or-abcdef123456' }` returns 201 with `scope: 'GLOBAL'` and `last4: '3456'`.
- [integration] The `POST /fleet/provider-credentials` response body has neither a `key` nor an `encryptedKey` field.
- [integration] `GET /fleet/provider-credentials` returns the created row with `name`, `last4`, `fingerprint` and `disabled: false`, and no `key` field.
- [integration] `POST /fleet/provider-credentials` by a user without `fleet.credential.create` returns 403.
- [integration] `POST /fleet/provider-credentials` with `providerId: 'Bad Id'` returns 400 naming `providerId`.
- [integration] `POST /fleet/provider-credentials` with a key containing a space returns 400 naming `key`.
- [integration] A second `POST /fleet/provider-credentials` for the same `providerId` returns 409 with code `fleet.providerCredentials.duplicate`.
- [integration] `PATCH /fleet/provider-credentials/:id` with a new `key` returns 200 with a `fingerprint` different from the old one.
- [integration] The rotate `PATCH` records one `credential.rotated` activity row whose payload keys are exactly `providerId`, `scope`, `name` and `fingerprint`.
- [integration] `PATCH /fleet/provider-credentials/:id` with `{ disabled: true }` returns 200 with `disabled: true`.
- [integration] After `DELETE /fleet/provider-credentials/:id`, `GET /fleet/provider-credentials` no longer lists the row.
- [integration] `DELETE /fleet/provider-credentials/:id` records `credential.deleted`.
- [integration] With the vault off, `POST /fleet/provider-credentials` returns 503 with code `fleet.providerCredentials.vaultOff`.
- [integration] `POST /fleet/provider-credentials` by an agent principal holding `fleet.credential.create` creates an approval request and no `ProviderCredential` row.
- [unit] The en and zh API i18n files both carry `fleet.providerCredentials.duplicate` and `fleet.providerCredentials.vaultOff`.

### US-004: Manage PROJECT and REPO provider keys

- [integration] `POST /projects/:slug/provider-credentials` by a Project Admin without `repoId` returns 201 with `scope: 'PROJECT'` and that project's id.
- [integration] `POST /projects/:slug/provider-credentials` with the `repoId` of a repo in the project returns 201 with `scope: 'REPO'` and that `repoId`.
- [integration] `POST /projects/:slug/provider-credentials` with the `repoId` of a repo in another project returns 404 with code `fleet.repos`.
- [integration] `POST /projects/:slug/provider-credentials` by a Developer returns 403.
- [integration] `GET /projects/:slug/provider-credentials` by a Developer returns 200 with rows that have no `key` field.
- [integration] `GET /projects/:slug/provider-credentials` lists the project's PROJECT and REPO rows and no GLOBAL row.
- [integration] `PATCH /projects/:slug/provider-credentials/:id` for a credential of another project returns 404.
- [integration] `PATCH /projects/:slug/provider-credentials/:id` with a new `key` returns 200 with a new `fingerprint` and records `credential.rotated`.
- [integration] `DELETE /projects/:slug/provider-credentials/:id` returns 200 and records `credential.deleted` with the project's `projectId`.
- [unit] `PERMISSION_CATALOG` gives `project.credential.create` risk `high` and scope `project`.
- [unit] `PERMISSION_CATALOG` gives `project.credential.read` risk `low` and scope `project`.

### US-005: Hand provider keys to runners through sync

- [integration] A runner sync with `providerRequests: [{ jobId, leaseEpoch, providerId: 'openrouter' }]` for its RUNNING job, with an active GLOBAL `openrouter` key named `fleet`, returns one `providerKeys` entry with that `jobId`, `providerId` and the plaintext `key`.
- [integration] That grant carries `account: 'koda:global:fleet'` and the credential's `fingerprint`.
- [integration] That grant's `expiresAt` is 10 minutes after the sync time.
- [integration] The same sync with no resolvable key returns `providerKeyErrors: [{ jobId, providerId: 'openrouter', reason: 'none' }]` and no grant.
- [integration] A provider request for a job not in a runner-held state returns reason `job_not_active`.
- [integration] A provider request with a stale `leaseEpoch` returns no grant and abandons the job, as a stale git token request does.
- [integration] With the vault off, a provider request returns reason `vault_off`.
- [integration] A provider request for a REPO thread job is granted the REPO key of the thread's `repoId`.
- [integration] A provider request for a PROJECT thread job, where a REPO key exists for a repo of the project and a PROJECT key exists, is granted the PROJECT key.
- [integration] The first grant for a job records one `credential.issued` activity row on that job with payload `{ providerId, scope, name, fingerprint }`.
- [integration] A second sync granting the same credential with the same fingerprint to the same job records no second `credential.issued` row.
- [integration] After the key is rotated, the next grant to the same job records a new `credential.issued` row with the new fingerprint.
- [unit] `parseSyncRequest` refuses a `providerRequests` array longer than 64 entries.
- [unit] `parseSyncRequest` refuses a provider request whose `providerId` does not match `^[a-z0-9][a-z0-9._-]{0,47}$`.

### US-006: Credential board shows koda keys and runner vault state

- [unit] `parseCapabilitiesCore` with `providerVault: true` returns capabilities with `providerVault: true`.
- [unit] `parseCapabilitiesCore` with `providerVault: 'yes'` returns capabilities without `providerVault`.
- [unit] `buildCredentialBoard` gives a runner whose capabilities carry `providerVault: true` the board flag `providerVault: true`.
- [unit] `buildCredentialBoard` gives a runner without `providerVault` the board flag `providerVault: false`.
- [integration] `GET /fleet/credential-board` lists each active GLOBAL key under `kodaKeys` as `{ providerId, name, last4, updatedAt }` with no `key` field.
- [integration] `GET /fleet/credential-board` omits disabled GLOBAL keys from `kodaKeys`.
- [integration] `GET /fleet/credential-board` omits PROJECT and REPO keys from `kodaKeys`.
- [integration] `GET /fleet/credential-board` with the vault off returns `kodaKeys: []`.

### US-007: Runner job sockets answer provider key requests

- [unit] A `CredentialServer` given a provider reply answers the line `provider openrouter` with that reply's JSON on one line.
- [unit] A `CredentialServer` answers `provider Bad!` with `{ ok: false, reason: 'bad request' }` and does not call the provider reply.
- [unit] A `CredentialServer` given both replies still answers `get` through the git reply.
- [unit] The broker's provider reply for a job queues a `ProviderKeyRequest` with the job's `jobId`, `leaseEpoch` and the provider id.
- [unit] The broker's provider reply resolves `{ ok: true, key, expiresAt, account }` once `ProviderKeyCache.apply` receives the matching grant.
- [unit] The broker's provider reply serves a cached grant without queuing a new request while it is more than 60 s before `expiresAt`.
- [unit] The broker's provider reply queues a new request once the cached grant is within 60 s of `expiresAt`.
- [unit] The broker's provider reply resolves `{ ok: false, reason: 'none' }` when the sync answers `none` for a provider never served to the job.
- [unit] The broker's provider reply resolves `{ ok: false, reason: 'revoked' }` when the sync answers `none` for a provider served to the job before.
- [unit] The broker's provider reply resolves `{ ok: false, reason: 'error' }` when no answer arrives within 55 s.
- [unit] Releasing a job's credentials drops its cached grants and served set.
- [integration] The real `SyncLoop` sends queued provider requests in `providerRequests` and applies `providerKeys` from a stubbed server response to the cache, so a waiting provider reply resolves ok.

### US-008: nax exec helper and job env

- [unit] `runProviderCred` with stdin `{"version":1,"providerId":"openrouter"}` and a socket answering `{ ok: true, key: 'k1', expiresAt: 1, account: 'koda:global:fleet' }` writes `{"version":1,"kind":"api-key","key":"k1","expiresAt":1,"account":"koda:global:fleet"}` and returns exit code 0.
- [unit] `runProviderCred` with neither `KODA_PROVIDER_CRED_SOCKET` nor `--socket` writes `{"version":1,"decline":true}` and returns 0.
- [unit] `runProviderCred` with a socket answering reason `none` writes the decline reply and returns 0.
- [unit] `runProviderCred` with a socket answering reason `revoked` returns 1 with nothing written to stdout.
- [unit] `runProviderCred` with a socket path nothing listens on writes nothing to stdout and returns 1.
- [unit] `dispatchInternal(['provider-cred', 'get'])` runs the provider helper and returns its exit code.
- [unit] The env the host executor builds for a RUN job carries `KODA_PROVIDER_CRED_SOCKET` equal to that job's socket path.
- [unit] The env the config job builds for nax carries `KODA_PROVIDER_CRED_SOCKET` equal to that job's socket path.
- [integration] `runProviderCred` against a real `CredentialServer` whose provider reply grants `k1` writes the api-key reply with `key: 'k1'` (seam: helper to socket).

### US-009: Runner vault enable and disable, and the providerVault capability

- [unit] `vault enable` on a `config.json` holding `{ "agent": { "x": 1 } }` leaves `{ "agent": { "x": 1 }, "auth": { "source": "exec", "exec": { "command": [<self argv>, "provider-cred"], "timeoutMs": 60000 }, "onChange": "warn" } }`.
- [unit] `vault enable` with no `config.json` creates one holding only that `auth` block.
- [unit] `vault enable` writes through a temporary file in the same directory and renames it onto `config.json`.
- [unit] `vault enable` on a `config.json` that is not valid JSON exits non-zero and leaves the file byte-identical.
- [unit] `vault disable` removes `auth` and keeps every other key.
- [unit] The capability probe reports `providerVault: true` when `config.json`'s `auth.exec.command` equals `[<self argv>, "provider-cred"]`.
- [unit] The capability probe omits `providerVault` when `auth.exec.command` names another helper.

### US-010: Native thread sessions use koda keys

- [unit] `ThreadSessionFactory.open` for a native thread on model `openrouter/qwen3` asks the injected provider lookup for provider `openrouter` on the thread's `jobId`.
- [unit] When the lookup grants a key, `open` builds native backend options with `credentials: { kind: 'exec', command: [<self argv>, 'provider-cred', '--socket', <thread job socket>], timeoutMs: 60000 }`.
- [unit] When the lookup answers `none`, `open` builds native backend options without `credentials`.
- [unit] When the thread pins no model, `open` asks the lookup for the provider of the runner's default model.
- [unit] `open` for an ACP thread never calls the provider lookup.
- [unit] Two opens of the same thread each call the provider lookup.
- [integration] A thread turn through `ThreadJobRun` with a broker stub granting `openrouter` opens the native session with exec `credentials`.

### US-011: Runner redacts served keys from shipped output

- [unit] After the broker serves key `sk-or-abcdef123456` with fingerprint `abc123def456` to job `j1`, the log shipper ships the `j1` line `token sk-or-abcdef123456 used` as `token [koda-key:abc123def456] used`.
- [unit] The log shipper leaves a line for job `j2` unchanged when only `j1` was served that key.
- [unit] A diagnostic built for job `j1` replaces the served key with `[koda-key:abc123def456]`.
- [unit] After the job's credentials are released, the registry holds no values for `j1`.
- [integration] A key served through the real broker provider reply to `j1` is redacted from the next shipped `j1` log line.

### US-012: Web admin provider keys page and board column

- [unit] `/admin/fleet/provider-keys` lists rows from `GET /fleet/provider-credentials` showing `providerId`, `name`, `last4`, `fingerprint` and disabled state.
- [unit] Submitting the add form calls `POST /fleet/provider-credentials` with `{ providerId, name, key }`.
- [unit] After a successful add, the key input is empty.
- [unit] The add form refuses a `providerId` with uppercase letters with a translated validation message and sends no request.
- [unit] Rotate calls `PATCH /fleet/provider-credentials/:id` with `{ key }` only.
- [unit] Disable calls `PATCH /fleet/provider-credentials/:id` with `{ disabled: true }`.
- [unit] Enable calls `PATCH /fleet/provider-credentials/:id` with `{ disabled: false }`.
- [unit] Delete calls `DELETE /fleet/provider-credentials/:id` only after the confirmation is accepted.
- [unit] The add control is hidden when `useGlobalPermissions().has('fleet.credential.create')` is false.
- [unit] Rotate and disable controls are hidden when `useGlobalPermissions().has('fleet.credential.update')` is false.
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
- [unit] The add control is hidden when `useProjectPermissions(slug).has('project.credential.create')` is false.
- [unit] A refused request shows `extractApiError(err)` through the app toast.

### US-014: Rulings refuse items nax can never settle

- [unit] `ruleTarget` for an open item whose `kind` is `ci` throws a conflict with code `fleet.rulings.notRulable`.
- [unit] `ruleTarget` for a `ci` item does not call `mintThreadReadToken`.
- [unit] `ruleTarget` for a non-`ci` item on a GitHub draft whose PR comments include a body containing `key=w-index` returns the target.
- [unit] `ruleTarget` for a non-`ci` item on a GitHub draft whose PR comments contain no body with `key=w-index` throws a conflict with code `fleet.rulings.noItemIndex`.
- [unit] `ruleTarget` returns the target when `listIssueComments` throws.
- [unit] `ruleTarget` returns the target without a forge read when the repo has no GitHub installation id.
- [unit] `GitHubAppClient.listIssueComments(token, 'o', 'n', 7)` requests `GET /repos/o/n/issues/7/comments?per_page=100` with the given token and returns each comment's `body`.
- [unit] `GitHubAppClient.listIssueComments` throws a provider error on a non-200 response.
- [integration] `POST /projects/:slug/fleet/jobs/:id/rulings` for a `ci` item returns 409 with code `fleet.rulings.notRulable` and creates no ruling.
- [unit] The en and zh API i18n files both carry `fleet.rulings.notRulable` and `fleet.rulings.noItemIndex`.

### US-015: Web hides Rule on CI items and explains unknown-item

- [unit] `FleetJobOpenItems` renders no Rule action for an open item whose `kind` is `ci`.
- [unit] `FleetJobOpenItems` renders the Rule action for an open item whose `kind` is `finding`.
- [unit] `FleetJobOpenItems` renders the skip reason `unknown-item` with the en label "This PR has no nax item index (published before nax 0.91.2); re-run to republish".
- [unit] The zh locale carries a translation for `fleet.rulings.skipReason.unknown-item`.
