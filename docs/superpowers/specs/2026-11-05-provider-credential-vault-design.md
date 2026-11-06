# Provider Credential Vault (C10) - Design

Date: 2026-11-05. Issues: #371 (C10 vault), #394 folded in as a small extra (section 9).
Builds on: S1 dispatch spec §9.6 (`docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md`), which this
design schedules and narrows.

## 1. Intent

The admin adds a provider API key (OpenRouter, DeepSeek, OpenAI, ...) **once in koda**, and every runner's fleet jobs
and native thread sessions use it. No more `nax auth login` on each machine. koda records which job or thread used
which key.

Success picture (user, 11-05): a new runner is enrolled and runs a job on a koda-held key with no `nax auth` on the
machine.

This reverses design doc §3 (k) "koda never stores provider credentials", as §9.6 anticipated.

## 2. Goals, non-goals, anti-goals

Goals:
- Central provisioning and rotation of provider **API keys**.
- Scopes: **global (fleet-wide), project, repo** (user: "both"). The most specific key wins.
- Coverage: every nax native agent call the runner makes: fleet jobs (plan, run, bot review, bot fix, config jobs)
  and native thread sessions.
- Attribution: each hand-out recorded against the job/thread with the key's name and fingerprint.

Non-goals (this design):
- OAuth / subscription logins (Claude, ChatGPT, Copilot ...). They stay machine-local. nax's exec helper accepts
  only `kind: "api-key"` (`nax-agent/src/native/credentials/helper-protocol.ts:75`).
- ACP agents (Claude Code, Codex, Cursor) in threads. They keep their own sign-ins on the runner host.
- An LLM proxy / gateway (one koda key in front of providers). Discussed 11-05 (yetone/magpie reviewed) and parked;
  the user chose to do #371 as filed first.
- Spend caps per key (my call: attribution only; existing C1 job budgets still apply). Later.
- HashiCorp Vault / OpenBao / KMS backends. The storage sits behind an interface so they can be added later.

Anti-goals:
- A key ever shown again in full after it is saved (UI, API, logs, activity, bundles, job logs).
- Breaking a runner that has no koda keys: a machine-local `nax auth` credential must keep working.
- Secrecy from the agent is NOT claimed. The nax process must hold the key, and the agent's Bash runs as the same
  uid and can reach the per-job socket (explorer finding, `credentials/socket-dir.ts`, `job-files.ts:11-17`). The gain is
  central provisioning, rotation and attribution (as §9.6 says).

## 3. Decided (user)

- Picture in §1 confirmed.
- Global key plus per-project and per-repo override keys.
- Management and storage as played back 11-05 (section 5), accepted: "look good".
- Back to #371 as filed (exec helper vault), no proxy.

## 4. Grounding (current code)

- nax exec contract (`nax-agent` 0.91.7, already the koda pin): argv `[...command, "get"]`, stdin
  `{"version":1,"providerId":"..."}`, reply `{"version":1,"kind":"api-key","key":"...","expiresAt"?,"account"?}`
  or `{"version":1,"decline":true}`. nax caches the lease, re-asks 60s before `expiresAt`, never logs the key.
- `auth` is **global-only** in nax config (`nax/src/config/global-only-keys.ts:53`): it can be set only in
  `<NAX_GLOBAL_CONFIG_DIR>/config.json`, not in the per-job profile overlay. Fleet jobs run with
  `NAX_GLOBAL_CONFIG_DIR=<naxHome>` (the runner user's shared `~/.nax` by default) (`host-executor.ts:179-182`, `:218`).
- Process-wide store = chained: exec helper first, then the credentials file. A decline falls back to the file
  (`chained-store.ts`).
- Threads run nax-agent in the runner daemon. nax-agent 0.91.7 accepts a **per-session** credential source
  (`session-adapter.ts:100`, `credentials: { kind: "exec", command, timeoutMs?, onChange? }`). That source is
  exec-only: **no file fallback**.
- Per-job git-token broker: unix socket per `(runnerId, jobId, leaseEpoch[, repoId])` under a uid-owned 0700 dir,
  socket 0600, protocol one `get\n` line in / one JSON reply out (`apps/runner/src/credentials/cred-server.ts`).
  Tokens are minted through the runner sync request (`apps/api/src/fleet/sync/sync.service.ts:123-166`), fenced by
  `runnerId + leaseEpoch` (`fence.service.ts`). Threads use the same broker keyed by the thread's job
  (`thread-job-run.ts:294`).
- Encryption: `common/utils/encryption.util.ts` AES-256-GCM, master key `VCS_ENCRYPTION_KEY`.
- Credential board: pure derivation from `Runner.capabilities` (`fleet/dashboard/credential-board.ts`), cells
  `{state, kind: api-key|oauth|exec|ambient|none}`.
- Scopes: `FleetRepo.projectId`; `FleetJob.projectId/repoId`; `ChatThread.projectId` required, `repoId` nullable,
  `kind` REPO|PROJECT|WORKSPACE.
- Permissions: `fleet.credential.read` global exists; `fleet.credential.` is already in `HIGH_RISK_PREFIXES`;
  `vcs.connection.*` are project-scope keys.

## 5. Design

### 5.1 Server: storage and management (api)

- New model `ProviderCredential`: `id`, `scope` GLOBAL|PROJECT|REPO, `projectId?`, `repoId?`, `providerId` (nax
  provider id, e.g. `openrouter`), `name` (label), `encryptedKey`, `last4`, `fingerprint` (short non-reversible
  hash, salted server-side), `createdById`, `updatedById`, timestamps, `disabledAt?`.
  Unique: one active key per `(scope, projectId, repoId, providerId)`.
- `SecretStore` interface (`put`, `get`, `delete`) with one backend now: local encrypted, using
  `encryption.util`. Master key: my call, a new env `PROVIDER_CREDENTIAL_ENCRYPTION_KEY`, separate from
  `VCS_ENCRYPTION_KEY` so they rotate independently; missing key = feature off (routes 503, board says so), not boot
  failure.
- Write-only key: create and rotate take the key; every read returns `name, providerId, scope, last4, fingerprint,
  createdBy, updatedAt, disabled`. Rotate = new key under the same row (fingerprint changes). Disable / delete.
- Routes and permissions (my call, from the permission redesign doc §4: global credentials are Owner/Admin only;
  project-scope secrets follow VCS connections):
  - Global: `fleet.credential.create|update|delete` (global scope), `fleet.credential.read` (exists).
  - Project and repo: `project.credential.create|read|update|delete` (project scope; Project Admin via `*`).
    Repo keys are managed under the repo's project.
  - All writes are high risk (prefix rule) so the P3 approval policy applies. Catalog map + TSV row + role-matrix
    snapshot updated.
- Every create/rotate/disable/delete writes `FleetActivity` (actor, approval fields as for other high-risk writes).
- Web: global page under admin fleet (next to the credential board); project settings tab "Provider keys" with
  project and per-repo rows. Paste-once input, no reveal.

### 5.2 Resolution

For a job or thread with `(projectId, repoId?)` asking for `providerId`: active REPO key for `repoId` -> active
PROJECT key -> active GLOBAL key -> none. Workspace threads (no repo) resolve project then global (my call; the
schema always carries a projectId).

### 5.3 Hand-out (api <-> runner)

- The runner asks for a provider key the way it asks for git tokens: a request on the job's sync call, fenced by
  `runnerId + leaseEpoch` and an active job state. Reply: `{ providerId, key, expiresAt, account }` or `none`.
- `account` = `koda:<scope>:<name>` (shown in nax's auth stamp; never the key).
- Lease: my call, `expiresAt = now + 10 min`, so rotation/disable takes effect within ~10 min for running jobs; nax
  re-asks before expiry.
- Changes during a run (my call; nax treats a decline after a lease as invalid and memoises declines,
  `exec-source.ts:160-230`, so the helper never declines a provider it already served in that job):
  - rotate: the next renewal serves the new key (nax `onChange: "warn"` logs the switch). Seamless.
  - a more specific key deleted while a broader one resolves: the next renewal serves the broader key. Seamless.
  - key disabled or deleted with nothing else resolving: the next renewal exits non-zero with a clear message
    ("koda provider key <name> was disabled"); the job fails loudly at most ~10 min later. No silent fallback to a
    machine-local key mid-run. An open thread session fails its next turn the same way; the next session open
    re-resolves (5.5).
- Every hand-out records one `FleetActivity` row `credential.issued` on the job (providerId, scope, name,
  fingerprint), deduped per (job, credential, fingerprint) so a long run does not write a row every 10 min
  (my call).

### 5.4 Runner: fleet jobs (nax CLI)

- The runner's per-job socket server also answers a new request line `provider <providerId>\n` (the git `get\n`
  line is unchanged). It fetches from koda via the sync path, caches per job lease, replies the helper JSON.
- New runner internal command `koda-runner provider-cred get` = the nax exec helper. It reads the request from
  stdin, finds the job socket from env `KODA_PROVIDER_CRED_SOCKET`, and:
  - env unset (someone ran nax by hand on the machine) -> `decline` (nax falls back to the file).
  - koda has no key for this scope/provider -> `decline`.
  - socket error / job ended -> non-zero exit (nax fails the call loudly; no silent switch to a local key mid-run).
- The runner sets `KODA_PROVIDER_CRED_SOCKET` in the job env (`host-executor.ts`, `config-job.ts`).
- `auth` must live in `<naxHome>/config.json`. My call: the runner never edits it on its own. A runner command
  `koda-runner vault enable` writes `auth: { source: "exec", exec: { command: [<self>, "provider-cred"],
  timeoutMs: 60000 }, onChange: "warn" }` (keeping the rest of the file), and `vault disable` removes it. The
  capability probe reports `providerVault: true|false` (true when that helper is configured).
- Timeout (my call): `timeoutMs: 60000`, nax's schema maximum (`nax/src/config/schemas-auth.ts`). The first
  request per job rides the sync round trip; the socket holds the reply open up to ~55 s (as the git broker waits,
  `runner/src/daemon/tuning.ts:79`, but bounded below the helper timeout), then answers an error. Threads' session
  source uses the same timeout.
- Precedence: chained store = koda key first, local file second. A provider koda has no key for keeps using the
  machine-local credential.

### 5.5 Runner: native thread sessions (nax-agent in the daemon)

- At session open (and re-open: mode switch, model switch) the runner asks koda whether a key resolves for the
  session's provider. If yes, it opens the session with `credentials: { kind: "exec", command: [<self>,
  "provider-cred", "--socket", <thread socket>] }`. If no, it omits `credentials` and the process-wide store
  (machine-local) serves as today. (My call: the per-session source has no file fallback, so the runner decides up
  front.)
- ACP thread backends are unchanged.

### 5.6 Visibility

- Credential board: a new "koda" column per provider showing the resolvable global key (name, last4, updated), and
  each runner's `providerVault` flag. A runner without the helper configured shows "vault off". Project/repo keys are
  listed on the project page, not the global board (my call).
- Job and thread detail: "Provider key: openrouter / koda:project:billing-a (abcd1234)" from the activity rows.

## 6. Security notes

- Key plaintext exists only: in the api process while issuing, in transit on the existing runner TLS channel, in the
  runner's per-job cache, in the nax process. Never on disk on the runner (no files under naxHome, no bundles).
- Redaction (my call): today the runner redacts by pattern and key name only (`runner/src/logger.ts:13`,
  `runner/src/diagnostics.ts:5`); there is no value list. Add a per-job value redactor: every key the job's socket
  served is replaced with `[koda-key:<fingerprint>]` in everything the runner uploads or logs for that job (job log
  lines, `nax.stdout`/`nax.stderr`, bundle text files, diagnostics, thread log lines).
- Agent reachability (section 2 anti-goal): accepted, documented in the admin page copy.
- koda's DB becomes a high-value target; the master key is env-only, never in the DB.

## 7. Left to the builder

- Exact sync request/response field names; whether hand-outs ride the existing token-request array.
- Migration and Prisma enum names; DTO names; openapi regen.
- Where the per-job cache lives (alongside `TokenCache`).
- Web component layout within the existing admin and project settings patterns.

## 8. Left to the builder (checked)

- Whether a thread session knows its provider at open (pinned model vs runner default); if it cannot, open with the
  exec source whenever any koda key resolves for the thread's scope, and let the helper decline unknown providers.
- `vault enable` writes config.json atomically (temp file + rename) so a concurrent nax read never sees a partial file.

## 9. #394 folded in: rulings that can never apply

Problem: koda accepts a ruling on a draft RUN, but nax only settles items in the PR's nax item index (`w-index`
bot comment, nax >= 0.91.2), and never settles `ci` items. Both come back `skipped: unknown-item` only after a
billed FIX.

Decided (my call, following the issue's preferred option plus its comment):
1. `ruleTarget` (`apps/api/src/fleet/rulings/fleet-pr-rulings.service.ts:84`) refuses an item whose `kind === "ci"`
   with 409 `fleet.rulings.notRulable`. No forge read. Web and CLI hide Rule on `ci` items.
2. `ruleTarget` reads the PR's bot comments (GitHub, the existing read token) and refuses 409
   `fleet.rulings.noItemIndex` ("published by an older nax; re-run to republish") when no `w-index` marker exists.
   Forge read failure: fail open (accept), my call, so a GitHub hiccup does not block rulings.
3. Web/CLI render a ruling skipped as `unknown-item` with the explanation ("this PR has no nax item index").
