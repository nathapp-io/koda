# SPEC: GitLab repo credentials and registration (GitLab parity F1)

## Summary

Feature 1 of 4 of GitLab parity for the koda fleet. The design was approved by the owner on 2026-11-16:
`docs/superpowers/specs/2026-11-16-gitlab-parity-design.md`. This feature gives each GitLab fleet repo its own
connection: its host (gitlab.com or self-hosted), its GitLab project id, and two tokens from one bot identity.

- A **read** token (`read_api` + `read_repository`, and no write scope).
- A **write** token (`api` + `write_repository`).

All existing GitLab fleet paths move onto that per-repo connection, off the per-project `VcsConnection` token:

- registration and the reachability check;
- the git broker's RUN mint and the clone URL;
- the MR state refresher, the PR attribution comment and the `.nax/` config reader.

The feature also adds credential rotation, the host rule, the human-account warning, and CLI and web support.
REVIEW, FIX, AGENT and the other GitHub-only features stay GitHub-only here. Features 2 to 4 open them on top of
this connection.

## Motivation

- The owner wants koda to work on GitLab repos as close to GitHub as possible, on gitlab.com and on self-hosted
  GitLab. The first live target is `freqtrade/quant-crypto-trader` on gitlab.com.
- Today a GitLab fleet repo borrows its project's ticket-sync token (`GitLabTokenSource.resolve(projectId, owner,
  name)`, `apps/api/src/fleet/git-broker/gitlab-token.source.ts`). That gives one token for every purpose, one
  GitLab repo per project, and one global GitLab URL (`VCS_GITLAB_API_URL`). A read-only job cannot be given a
  token GitLab itself would refuse writes for, so the git broker refuses every purpose and read-only request for
  GitLab (`git-token.broker.ts:70-71`).
- gitlab.com Free has no project access tokens to mint per job (deferred by the owner). The read/write split
  therefore comes from two stored tokens per repo.

## Design

### Data model

`FleetRepo` gains `host String @default("https://github.com")`. Its uniqueness changes from
`@@unique([provider, owner, name])` to `@@unique([provider, host, owner, name])`. Migration
`20261216090000_fleet_repo_gitlab_credentials`:

- adds the column;
- sets `host = 'https://gitlab.com'` on existing `provider = 'gitlab'` rows; GitHub rows keep the default;
- swaps the unique index;
- creates the table below.

```prisma
model FleetRepoGitlabCredential {
  id                  String    @id @default(cuid())
  repoId              String    @unique
  repo                FleetRepo @relation(fields: [repoId], references: [id], onDelete: Cascade)
  gitlabProjectId     Int
  encryptedReadToken  String
  encryptedWriteToken String
  readTokenUserId     Int
  readTokenUsername   String
  writeTokenUserId    Int
  writeTokenUsername  String
  writeTokenIsBot     Boolean
  readTokenExpiresAt  DateTime?
  writeTokenExpiresAt DateTime?
  readTokenInvalidAt  DateTime?
  writeTokenInvalidAt DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}
```

`FleetRepo` gains the back-relation `gitlabCredential FleetRepoGitlabCredential?`. Tokens are encrypted with
`encryptToken` / `decryptToken` (`apps/api/src/common/utils/encryption.util.ts`) under the existing
`VCS_ENCRYPTION_KEY` (`vcsConfig.encryptionKey`), like `VcsConnection.encryptedToken`. No existing row gets a
credential record. An existing GitLab fleet repo is "not connected" until an admin adds tokens (design §6.3, no
legacy fallback; koda-wk has no GitLab fleet repo).

### Credential store

`GitLabRepoCredentials` (`apps/api/src/fleet/git-broker/gitlab-repo-credentials.ts`) is the only reader and writer
of the table, through the module-private `PrismaGitlabCredentialRepository`
(`apps/api/src/fleet/git-broker/prisma-gitlab-credential.repository.ts`). Its methods:

- `save(repoId: string, input: GitLabCredentialInput): Promise<void>` upserts and clears both `*InvalidAt` fields
  of the tokens it replaces. `GitLabCredentialInput` carries `gitlabProjectId` plus, for each token it replaces,
  the token and its verified user, expiry and (write only) `isBot`. Either token may be absent on a rotation.
- `resolve(repo: { id: string; host: string }, kind: 'read' | 'write'): Promise<GitLabAccess>` returns
  `{ token, target: { apiBase: string; projectId: number } }`, where `apiBase = host + '/api/v4'`. It throws
  `RepoCheckException('gitlab_credentials_missing')` when the repo has no record, and
  `RepoCheckException('vcs_encryption_key_missing')` when the key is unset.
- `call<T>(repo, kind, fn: (access: GitLabAccess) => Promise<T>): Promise<T>` resolves, runs `fn`, and when `fn`
  throws `RepoCheckException('gitlab_token_invalid')` calls `markInvalid(repo.id, kind)` before rethrowing.
- `markInvalid(repoId: string, kind: 'read' | 'write'): Promise<void>` sets that token's `*InvalidAt` to now.
- `assertKeyConfigured(): void` throws `RepoCheckException('vcs_encryption_key_missing')` when
  `vcsConfig.encryptionKey` is unset.

`GitLabAccess` is `{ token: string; target: { apiBase: string; projectId: number } }` everywhere in this spec.
`*InvalidAt` clears only when `save` replaces that token. A later successful call does not clear it, because the
admin is expected to rotate the token.
`resolve` takes `host?: string`. An absent host means `https://gitlab.com`, so a repo object that does not carry
the column (older fixtures, narrow selects) still resolves against the default. A stored token that fails to
decrypt under the configured key throws `RepoCheckException('gitlab_token_invalid')`, as
`GitLabTokenSource.resolve` does today, and marks nothing.

**How the repo row carries the credential (no secrets).** `PrismaFleetRepoRepository` loads `gitlabCredential`
with a select that leaves out both encrypted columns. It maps the result to the optional
`FleetRepoRecord.gitlabCredential?: GitLabCredentialView | null`, with these fields:

- `gitlabProjectId`;
- `readTokenUsername`, `writeTokenUsername`, `writeTokenIsBot`;
- both expiries and both `*InvalidAt` fields.

`FleetRepoRecord` also gains `host?: string`, where absent means `https://github.com` for GitHub rows.

`gitlabTokenStatus(expiresAt: Date | null, invalidAt: Date | null, now: Date): 'ok' | 'invalid' | 'expiring'`
(`gitlab-repo-credentials.ts`) is pure:

- `invalid` when `invalidAt` is set;
- otherwise `expiring` when `expiresAt` is 14 days or less after `now`;
- otherwise `ok`.

`FleetRepoDto.from(r, now = new Date())` builds the `gitlab` field from `r.gitlabCredential` with it.

### Host rule (owner decision A)

`parseGitLabHost(input: string): string` (`apps/api/src/fleet/git-broker/gitlab-host.ts`) returns the canonical
form: lower-case scheme and host, an optional port and path prefix, no trailing slash. It throws
`RepoCheckException('gitlab_host_invalid')` for:

- a non-`https:` scheme;
- userinfo, a query or a fragment;
- an unparseable value.

An absent host means `https://gitlab.com`.

`assertGitLabHostAllowed(host: string): Promise<void>` resolves the host name (`dns.lookup`, all addresses) and
throws `RepoCheckException('gitlab_host_blocked')` when any resolved address is blocked.
For each address, `assertGitLabHostAllowed` itself first checks a literal block list (`fd00:ec2::254`, the AWS
IPv6 metadata address). Only then does it ask `classifyAddress(address, allowedCidrs)`
(`apps/api/src/webhook/outbound/address-classifier.ts`, unchanged), with
`allowedCidrs = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']`. The order matters, because in
`classifyAddress` an allow-listed CIDR wins over its blocked ranges, and `fd00:ec2::254` is inside `fc00::/7`. Loopback, link-local (`169.254.0.0/16`, `fe80::/10`, which covers
the metadata address `169.254.169.254`) and CGNAT (`100.64.0.0/10`, which covers `100.100.100.200`) stay blocked
by the classifier itself.

`isClassifiableGitLabHost(host)` is true when the host name contains `gitlab`. Until nax #2957 ships, registration
refuses other names with `RepoCheckException('gitlab_host_unclassified')`.

### GitLab client

`GitLabAccessChecker` (`apps/api/src/fleet/git-broker/gitlab-access-checker.ts`) stops reading
`vcsConfig.gitlabApiUrl` and stops addressing projects by `owner/name`. Every request it sends first awaits
`assertGitLabHostAllowed` for the target's host. `FleetHttpClient` already refuses to follow redirects. The error
mapping is shared by every method:

- 401 is `gitlab_token_invalid`;
- 403 is `app_permissions_insufficient`;
- 404 keeps each method's current meaning, and for `getTokenSelf` a 404 is `gitlab_token_invalid` (as `verifyRepo` maps it today);
- any other status is `provider_error`.

### Registration and check

`CreateFleetRepoDto` gains, for `provider: 'gitlab'` only:

- `host?: string`;
- `readToken: string` and `writeToken: string`, both 1 to 512 characters and never returned;
- `confirmBotAccount?: boolean`.

A GitHub create that carries any of these fields gets 400 `fleet.repoGitlabFieldsOnGitHub`. A GitLab create
without both tokens gets 400 from validation.

`FleetReposService.prepareCreate` verifies a GitLab repo before its transaction, in this order (first failure wins,
each a `RepoCheckException` 422):

1. Host: `parseGitLabHost`, then `isClassifiableGitLabHost`, then `assertGitLabHostAllowed`.
2. `GET /personal_access_tokens/self` with each token. For the write token the scopes must include both `api` and
   `write_repository`, otherwise `gitlab_scope_missing`. For the read token the scopes must include `read_api` and
   `read_repository`, otherwise `gitlab_scope_missing`. A read token that also has `api` or `write_repository` is
   refused with `gitlab_read_token_writable`. `expires_at` gives the expiry.
3. `GET /user` with each token gives `{ id, username, bot }`.
4. `GET /projects/<url-encoded owner/name>` with the write token. Developer access or above is needed, otherwise
   `gitlab_access_insufficient`. The response gives the canonical path, `default_branch` and the numeric `id`.
5. `GET /projects/<id>` with the read token must answer 200, otherwise `gitlab_read_token_no_access`.

`writeTokenIsBot` is true when any of these hold:

- `/user` answered `bot: true` for the write token;
- its username equals `fleetConfig.gitlabBotName`;
- `confirmBotAccount` is true.

`prepareCreate` calls `GitLabRepoCredentials.assertKeyConfigured()` before step 1, so a missing key costs no
outbound call. Inside the existing `txManager.run` closure, `GitLabRepoCredentials.save(row.id, …)` runs right
after `repo.create`. The response is then built from `repo.findById(row.id)`, so the create response carries
`gitlab`, including `warnings`.

When it is false the save still succeeds (owner decision: allow with a warning). The `fleet.repo.create` audit
summary becomes `registered gitlab; write token belongs to a person (<username>)` instead of `registered gitlab`.

`FleetRepoDto` gains `host: string` and
`gitlab: { projectId: number; readToken: GitLabTokenSummaryDto; writeToken: GitLabTokenSummaryDto & { isBot: boolean }; warnings: string[] } | null`:

- `GitLabTokenSummaryDto` is `{ username, expiresAt: string | null, status: 'ok' | 'invalid' | 'expiring' }`;
- `warnings` is `['write_token_human']` when `isBot` is false, otherwise `[]`;
- `gitlab` is `null` for a GitHub repo and for a GitLab repo with no record.

`FleetReposService.prepareCheck` for a GitLab repo re-runs steps 2, 4 and 5 against the stored tokens and the
stored `gitlabProjectId`, using `GitLabRepoCredentials.resolve` and the client directly. It does not use
`call`, so `prepare` writes nothing. The existing returned closure compares the re-read row with `row` using
`isDeepStrictEqual`. That comparison now leaves out `gitlabCredential` on both sides, so a token marked invalid
by another caller in between does not turn the check into a conflict. When the verdict is `gitlab_token_invalid`
for a token kind, the closure calls `GitLabRepoCredentials.markInvalid(repoId, kind)` after that comparison and
before returning the result. It does not run step 3 and writes nothing else.

### Rotation

`PATCH /fleet/repos/:id/gitlab-credentials` with `{ readToken?, writeToken?, confirmBotAccount? }`:

- At least one token is required, otherwise 400 `fleet.repoGitlabCredentialsEmpty`.
- The route needs the new global catalog key `fleet.repo.credentials.update`, tier `high` through the
  `fleet.repo.` prefix in `HIGH_RISK_PREFIXES`.
- The host check (step 1) runs on the stored host. Then each supplied token gets exactly these calls:
  - new write token: `getTokenSelf` with the write-scope rule, `getCurrentUser`, and
    `findProject(apiBase, token, <stored gitlabProjectId>)`. Developer access or above is needed, otherwise
    `gitlab_access_insufficient`; a `repo_not_found` becomes `gitlab_project_mismatch`.
  - new read token: `getTokenSelf` with the read-scope and not-writable rules, `getCurrentUser`, and
    `findProject(apiBase, token, <stored gitlabProjectId>)`. A `repo_not_found` becomes
    `gitlab_read_token_no_access`.
- Rotation goes through the same approval route machinery as the other repo writes. It adds
  `FLEET_REPO_ROUTE_VARIANTS.gitlabCredentials = 'rest:fleet-repos.gitlab-credentials'`, the controller route in
  `fleet-repos.controller.ts`, and `'fleet.repo.credentials.update': ['global']` in the scope map of
  `permissions/catalog.ts`.
- On success it calls `GitLabRepoCredentials.save`, then `GitTokenBroker.evictRepo(repoId)`, and records audit
  `fleet.repo.credentials.update` with summary `read token replaced`, `write token replaced` or `read and write
  tokens replaced`.
- A GitHub repo gets 400 `fleet.repoNotGitlab`.

### Approval redaction

Both secret-bearing routes register `redeem.redact` with `redactSecret`
(`apps/api/src/approvals/route/redact-secret.ts`), exactly as `provider-credential-route.commands.ts` does, so no
approval request row ever stores a token:

- `fleet.repo.create` redacts `readToken` and `writeToken`;
- `fleet.repo.credentials.update` redacts whichever tokens are present.

### Broker and clone URL

`GitTokenBroker.fresh` (`git-token.broker.ts`) answers a GitLab mint with no `purpose` and no `readOnly` (the RUN
write mint) from `GitLabRepoCredentials.resolve(repo, 'write')`, with `username: 'oauth2'` and the existing
`gitlabTokenTtlSec` lifetime. GitLab purpose and read-only requests stay refused here; feature 2 opens them.
`GitTokenBroker.evictRepo(repoId)` drops every cached token minted for that repo. To find them, each cache entry
records the id of the repo it was minted for (the cache value becomes `{ token: GitToken, repoId: string }`; the
returned `GitToken` is unchanged). `evict(jobId)` keeps its key-prefix rule.

`cloneUrlFor(repo, cfg)` (`clone-url.ts`) builds a GitLab clone URL from `repo.host` when present.
`FleetRepoRef` (`jobs/domain/fleet-job.domain.ts`) gains `host?: string`. `PrismaFleetJobRepository.findRepo` and
`findProjectRepos` (`jobs/prisma-fleet-job.repository.ts`) select it. `placement.service.ts` and
`project-repos-assign.ts` pass that repo to `cloneUrlFor` unchanged. `RefreshRepo`
(`tickets/prisma-fleet-tickets.repository.ts`) gains `host?: string` from its select. The attribution and files
reader already receive a `FleetRepoRef`. Every GitLab read path passes `host` through to `resolve`, whose
`https://gitlab.com` default covers a missing value.

After the API contract changes in US-004 and US-005, `bun run generate` from the repo root regenerates `openapi.json` and `apps/cli/src/generated/`, which US-007 uses.

`vcs_connection_missing` and `vcs_connection_mismatch` stay in `RepoCheckReason`, `REASONS` and the web locales, although nothing in the fleet throws them after US-006.

### Integration

Read only (verified at koda main `6d704c1e`):

- `FleetHttpClient.request(method, url, headers, body?, options?)` (`git-broker/fleet-http-client.ts`): it uses
  `redirect: 'manual'` and maps a 3xx to `provider_unreachable`.
- `classifyAddress(address: string, allowedCidrs: readonly string[]): AddressVerdict` and
  `isInsideAllowedCidrs` (`webhook/outbound/address-classifier.ts`).
- `encryptToken(plaintext, masterKey)` and `decryptToken` (`common/utils/encryption.util.ts`).
- `redactSecret` (`approvals/route/redact-secret.ts`) and the `redeem: { redact }` pattern in
  `fleet/provider-credentials/provider-credential-route.commands.ts`.
- `RepoCheckException(reason)` (422, `git-broker/repo-check.exception.ts`). Its `RepoCheckReason` union gains
  `gitlab_credentials_missing`, `gitlab_host_invalid`, `gitlab_host_blocked`, `gitlab_host_unclassified`,
  `gitlab_read_token_writable`, `gitlab_read_token_no_access` and `gitlab_project_mismatch`, and
  `RepoCheckResultDto`'s `REASONS` list (`repos/dto/repo-check-result.dto.ts`) gains the same. New API messages
  go into `src/i18n/en/fleet.json` and `src/i18n/zh/fleet.json`. The web shows each reason from
  `fleet.repoReason.<reason>` in `apps/web/i18n/locales/{en,zh}.json` (read by `RepoReachabilityBadge.vue`), where the new reasons get strings (US-008).
- `HIGH_RISK_PREFIXES` and the scope map in `permissions/catalog.ts`.

The baseline exists only to locate the code. Implement the target, never the baseline.

- `GitLabAccessChecker`
  - Baseline: `commentOnMergeRequest(owner, name, iid, body, token)`, `getMergeRequest(token, owner, name, iid)`,
    `getBranchHead(token, owner, name, branch)`, `listTree(token, owner, name, path, ref)`,
    `getFile(token, owner, name, path, ref)` and `verifyRepo(owner, name, token)`. All use
    `vcsConfig.gitlabApiUrl` and `owner/name`.
  - Target:
    - `commentOnMergeRequest(access: GitLabAccess, iid, body): Promise<boolean>`;
    - `getMergeRequest(access, iid): Promise<VcsPrStatus | null>`;
    - `getBranchHead(access, branch): Promise<string>`;
    - `listTree(access, path, ref): Promise<ForgeTreeEntry[]>`;
    - `getFile(access, path, ref): Promise<ForgeFile | null>`;
    - `getTokenSelf(apiBase, token): Promise<{ scopes: string[]; expiresAt: Date | null }>`;
    - `getCurrentUser(apiBase, token): Promise<{ id: number; username: string; bot: boolean }>`;
    - `findProject(apiBase, token, pathOrId: string | number): Promise<{ id: number; owner: string; name: string; defaultBranch: string; accessLevel: number }>`.

    `verifyRepo` is removed.
- `FleetReposService`
  - Baseline: constructor injects `GitLabTokenSource`; `verifyGitLab(projectId, owner, name)` resolves the project
    `VcsConnection` token.
  - Target: the constructor parameters are, in order: `repo` (`FLEET_REPO_REPOSITORY`), `github`
    (`GitHubAppClient`), `gitlab` (`GitLabAccessChecker`), `credentials` (`GitLabRepoCredentials`, replacing
    `GitLabTokenSource`), `broker` (`GitTokenBroker`, added for `evictRepo`), `fleetConfig` (`@Inject(FLEET_CFG)`
    `Pick<IFleetConfig, 'gitlabBotName'>`, added), `activity`, `txManager`, `audit`, `permissions`. GitLab create
    and check run the verification above. `findByIdentity`
    keeps its signature and matches any host for now (feature 4 adds host matching to the flow entry).
- `GitTokenBroker.fresh`
  - Baseline: the GitLab branch calls `this.gitlab.resolve(repo.projectId, repo.owner, repo.name)` (a
    `GitLabTokenSource`).
  - Target: `GitLabRepoCredentials.resolve(repo, 'write')`.
- `FleetPrStateRefresher.readerFor` (`tickets/fleet-pr-state.refresher.ts`)
  - Baseline: `gitlabTokens.resolve` then `gitlab.getMergeRequest(token, owner, name, number)`.
  - Target: `credentials.call(repo, 'read', (a) => gitlab.getMergeRequest(a, number))`. `RefreshRepo` gains
    `host`.
- `PrAttributionService` (`sync/pr-attribution.service.ts`)
  - Baseline: `gitlab.commentOnMergeRequest(owner, name, number, body, await gitlabTokens.resolve(...))`.
  - Target: `credentials.call(repo, 'write', (a) => gitlab.commentOnMergeRequest(a, number, body))`.
- `GitlabFleetRepoFilesReader` (`repo-config/gitlab-fleet-repo-files.reader.ts`)
  - Baseline: `tokens.resolve(...)` plus the owner/name client calls.
  - Target: `credentials.call(repo, 'read', ...)` with the access-based client calls.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| Host with `http:`, userinfo, query or fragment | 422 `gitlab_host_invalid`; nothing saved, no outbound call |
| Host name without `gitlab` | 422 `gitlab_host_unclassified`; nothing saved, no outbound call |
| Host resolving to a loopback, link-local, metadata or CGNAT address | 422 `gitlab_host_blocked`; no request sent |
| Host that resolves to an allowed address at save and to a blocked one later | the later call fails `gitlab_host_blocked` before sending |
| Token answering 401 at registration or rotation | 422 `gitlab_token_invalid`; nothing saved |
| Stored token answering 401 on a refresher, attribution or files call | that token's `*InvalidAt` set; the call's existing failure path runs |
| Write token missing `api` or `write_repository`; read token missing `read_api` or `read_repository` | 422 `gitlab_scope_missing` |
| Read token that has `api` or `write_repository` | 422 `gitlab_read_token_writable` |
| Write token below Developer on the project | 422 `gitlab_access_insufficient` |
| Read token cannot see the project | 422 `gitlab_read_token_no_access` |
| New write token on rotation cannot see the stored project id | 422 `gitlab_project_mismatch`; nothing saved |
| GitLab repo with no credential record on a mint, refresher, attribution or files call | `gitlab_credentials_missing` |
| `VCS_ENCRYPTION_KEY` unset on registration, rotation or resolve | 422 `vcs_encryption_key_missing`; nothing saved |
| Write token belongs to a person | saved; `writeTokenIsBot` false; `warnings: ['write_token_human']`; audit summary names the person |
| Duplicate `(provider, host, owner, name)` | the existing conflict answer of repo create |

## Out of Scope

- REVIEW, FIX and AGENT jobs, purpose and read-only GitLab mints, and the RUN forge identity for GitLab (feature 2 of GitLab parity).
- Threads with project code, the project brief, the knowledge index, PR rulings and review events on GitLab (feature 3 of GitLab parity).
- Flows, auto-review, fix-checks, the FIX protected-branch gate and CI pipeline status on GitLab (feature 4 of GitLab parity), including host-aware matching in `findByIdentity` for the nax flow entry.
- Minting short-lived GitLab tokens per job (project or group access tokens through the API); deferred by the owner because gitlab.com Free does not offer them.
- Inbound GitLab webhooks; the 2026-09-27 ruling stands and GitLab stays poll-driven.
- Ticket sync (`apps/api/src/vcs/`) and its `VcsConnection` token, which keep working unchanged.
- Self-hosted GitLab hosts whose name lacks `gitlab`; they wait for nax #2957 and are refused with `gitlab_host_unclassified` until then.
- Pinning the TCP connection to the address `assertGitLabHostAllowed` checked; a DNS answer that changes between the check and the connect is not defended against.
- CGNAT addresses (`100.64.0.0/10`, used by some overlay networks) as self-hosted GitLab hosts; they stay blocked.
- Changing `VCS_GITLAB_API_URL`, which ticket sync still reads.
- A background poller for token health; a token is marked invalid only when a call it makes answers 401.
- Migrating any existing GitLab fleet repo onto a credential record; an admin adds its tokens through rotation.
- US-004 only: the registration verification calls are not retried; a transient GitLab failure answers `provider_unreachable` or `provider_error` and the admin repeats the call.
- US-005 only: concurrent rotations of one repo; the last save wins, and both evict the broker cache.
- US-002 only: per-request rate limiting of GitLab API calls; the existing poll intervals bound them.
- US-002 only: `gitlab_credentials_missing` on the refresher, attribution and files paths is not tested separately; each goes through `GitLabRepoCredentials.call`, whose `resolve` refusal is pinned by US-001 AC-8, and each path's existing catch handles it.
- US-004 only: `gitlab_host_blocked` through `prepareCreate` is not tested separately; AC-2 and AC-3 pin that the host step runs before any GitLab call, and US-002 AC-5, AC-6 and AC-8 pin the blocking itself.
- US-004 only: `vcs_encryption_key_missing` at registration and the duplicate-repo conflict are not tested separately; the first is the store's own refusal (US-001 AC-9 covers `resolve`, and `save` uses the same key check), and the second is the existing create conflict on Prisma `P2002` (US-001 AC-3).
- US-004 only: no test asserts token values are absent from log lines; the service logs only repo ids and reason codes, never a token, and the audit summaries are fixed strings pinned by AC-10 and AC-11.
- US-005 only: no test asserts token values are absent from log lines; the service logs only repo ids and reason codes, never a token, and the audit summaries are fixed strings pinned by AC-3 and AC-8.
- US-001 only: a stored token that fails to decrypt under a changed `VCS_ENCRYPTION_KEY` answers `gitlab_token_invalid` and is not marked invalid; re-keying stored tokens is not supported.

## Stories

**US-001: Credential record and store.** Workdir: `apps/api`. No dependencies.
Adds `FleetRepo.host`, the swapped unique index, the `FleetRepoGitlabCredential` model and migration
`20261216090000_fleet_repo_gitlab_credentials`. Also adds `PrismaGitlabCredentialRepository` and
`GitLabRepoCredentials` (`save`, `resolve`, `call`) plus `gitlabTokenStatus`, wired in `GitBrokerModule`. Adds
`FleetRepoRecord.host` and `gitlabCredential`, mapped without the encrypted columns by
`PrismaFleetRepoRepository`, and the `host` and `gitlab` fields of `FleetRepoDto`.

**US-002: Host rule and access-based GitLab client.** Workdir: `apps/api`. Depends on US-001.
Adds `gitlab-host.ts` (`parseGitLabHost`, `assertGitLabHostAllowed`, `isClassifiableGitLabHost`) and the new
`RepoCheckReason` values. Changes `GitLabAccessChecker` to the access-based target signatures with the host check
and the shared error mapping. Moves `FleetPrStateRefresher`, `PrAttributionService` and
`GitlabFleetRepoFilesReader` onto `GitLabRepoCredentials.call`.

**US-003: Broker RUN mint and clone URL from the repo connection.** Workdir: `apps/api`. Depends on US-001, US-002.
Points the GitLab write mint at `GitLabRepoCredentials.resolve(repo, 'write')`, and adds
`GitTokenBroker.evictRepo`. Adds `FleetRepoRef.host` filled from the row, and makes `cloneUrlFor` use it.

**US-004: GitLab registration and check.** Workdir: `apps/api`. Depends on US-001, US-002.
Adds the GitLab fields on `CreateFleetRepoDto`, the five-step verification in `prepareCreate`, bot detection and
the human-account audit summary, the `host` and `gitlab` fields on `FleetRepoDto`, the GitLab `prepareCheck`, the
`fleet.repo.create` redaction, and the en/zh messages `fleet.repoGitlabFieldsOnGitHub`.

**US-005: Credential rotation route.** Workdir: `apps/api`. Depends on US-003, US-004.
Adds `PATCH /fleet/repos/:id/gitlab-credentials`, `UpdateGitlabCredentialsDto`, and
`FleetReposService.rotateGitlabCredentials` with broker eviction and audit. Also adds the catalog key
`fleet.repo.credentials.update`, its approval route command with redaction, and the en/zh messages
`fleet.repoGitlabCredentialsEmpty` and `fleet.repoNotGitlab`.

**US-006: Remove the per-project GitLab token source from the fleet.** Workdir: `apps/api`. Depends on US-002,
US-003, US-004, US-005.
Deletes `gitlab-token.source.ts` and its spec and drops it from `GitBrokerModule`. Deletion only.

**US-007: CLI GitLab registration and rotation.** Workdir: `apps/cli`. Depends on US-004, US-005.
`koda fleet repo add` gains `--host`, `--read-token-file`, `--write-token-file` and `--confirm-bot`. Adds
`koda fleet repo credentials <id>` with the same token flags. Both print the human-account warning.

**US-008: Web GitLab registration, warning badge and rotation dialog.** Workdir: `apps/web`. Depends on US-004,
US-005.
`AddRepoDialog.vue` gains the GitLab fields. The repo admin list shows the host, the token statuses and the
human-account badge. Adds a `RepoGitlabCredentialsDialog.vue` for rotation, and en/zh strings.

### Context Files

**US-001**
- `apps/api/prisma/schema.prisma` — `FleetRepo`, `VcsConnection` (encrypted token column pattern)
- `apps/api/src/fleet/repos/prisma-fleet-repo.repository.ts` — repository pattern in the fleet module
- `apps/api/src/common/utils/encryption.util.ts` — `encryptToken` / `decryptToken`
- `apps/api/src/fleet/git-broker/git-broker.module.ts` — provider wiring
- `apps/api/src/fleet/repos/dto/fleet-repo.dto.ts` — `FleetRepoDto.from`

**US-002**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.ts` — methods being changed
- `apps/api/src/webhook/outbound/address-classifier.ts` — `classifyAddress`
- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.ts` — `readerFor`
- `apps/api/src/fleet/sync/pr-attribution.service.ts` — the GitLab comment branch
- `apps/api/src/fleet/repo-config/gitlab-fleet-repo-files.reader.ts` — `list`, `read`

**US-003**
- `apps/api/src/fleet/git-broker/git-token.broker.ts` — `mint`, `fresh`, `evict`, the cache
- `apps/api/src/fleet/git-broker/clone-url.ts` — `cloneUrlFor`
- `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` — `FleetRepoRef`
- `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` — `findRepo`, `findProjectRepos`

**US-004**
- `apps/api/src/fleet/repos/fleet-repos.service.ts` — `prepareCreate`, `verifyGitLab`, `prepareCheck`
- `apps/api/src/fleet/repos/dto/create-fleet-repo.dto.ts`
- `apps/api/src/fleet/repos/fleet-repo-route.commands.ts` — `fleet.repo.create` command
- `apps/api/src/fleet/provider-credentials/provider-credential-route.commands.ts` — the `redeem.redact` pattern

**US-005**
- `apps/api/src/fleet/repos/fleet-repos.controller.ts` — `configureFixUnprotected` route pattern
- `apps/api/src/fleet/repos/fleet-repo-route.commands.ts`
- `apps/api/src/permissions/catalog.ts` — the scope map, `HIGH_RISK_PREFIXES`
- `apps/api/src/fleet/provider-credentials/provider-credential-route.commands.ts` — `fleet.credential.update` redaction

**US-006**
- `apps/api/src/fleet/git-broker/git-broker.module.ts`

**US-007**
- `apps/cli/src/commands/fleet-repo.ts` — `add` command
- `apps/cli/src/commands/fleet-shared.ts` — validation and output helpers

**US-008**
- `apps/web/components/fleet/AddRepoDialog.vue`
- `apps/web/pages/admin/fleet/repos.vue`
- `apps/web/components/fleet/RepoFixUnprotected.vue` — per-repo dialog pattern
- `apps/web/lib/fleet-types.ts` — `FleetRepo`

### Creates

**US-001**
- `apps/api/prisma/migrations/20261216090000_fleet_repo_gitlab_credentials/migration.sql`
- `apps/api/src/fleet/git-broker/gitlab-repo-credentials.ts`
- `apps/api/src/fleet/git-broker/prisma-gitlab-credential.repository.ts`

**US-002**
- `apps/api/src/fleet/git-broker/gitlab-host.ts`

**US-005**
- `apps/api/src/fleet/repos/dto/update-gitlab-credentials.dto.ts`

**US-008**
- `apps/web/components/fleet/RepoGitlabCredentialsDialog.vue`

### Modifies

**US-001**
- `apps/api/prisma/schema.prisma` — `FleetRepo` gains `host` and the `gitlabCredential` back-relation, its unique index becomes `(provider, host, owner, name)`, and the `FleetRepoGitlabCredential` model is added.
- `apps/api/src/fleet/repos/dto/fleet-repo.dto.spec.ts` — the serialised `FleetRepoDto` gains `host` and `gitlab` (null for GitHub rows); every other field assertion stays.

**US-002**
- `apps/api/src/fleet/git-broker/gitlab-access-checker.spec.ts` — every call moves to the access-based signatures (`GitLabAccess` is a token plus a target of api base and numeric project id); URLs in the assertions become the api base plus /projects/ and the numeric id instead of the url-encoded owner and name; `verifyRepo` cases move to `getTokenSelf`, `getCurrentUser` and `findProject`; a non-200 that was `provider_error` becomes `gitlab_token_invalid` for 401 and `app_permissions_insufficient` for 403.
- `apps/api/src/fleet/tickets/fleet-pr-state.refresher.spec.ts` — the GitLab reader is resolved through `GitLabRepoCredentials.call` with kind `read` instead of `GitLabTokenSource.resolve`; the refresh outcomes stay the same.
- `apps/api/src/fleet/sync/pr-attribution.service.spec.ts` — the GitLab comment is posted through `GitLabRepoCredentials.call` with kind `write`; the posted/failed/skipped outcomes stay the same.
- `apps/api/src/fleet/repo-config/fleet-repo-files.reader.spec.ts` — the GitLab reader is built with `GitLabRepoCredentials` instead of `GitLabTokenSource`, and its forge-refusal cases come from `GitLabRepoCredentials.call`; the GitHub cases and the refusal mapping stay.

**US-003**
- `apps/api/src/fleet/git-broker/git-token.broker.spec.ts` — the GitLab write mint is answered from `GitLabRepoCredentials.resolve(repo, 'write')` instead of `GitLabTokenSource.resolve(projectId, owner, name)`; the `username: 'oauth2'`, TTL and purpose/read-only refusal assertions stay.
- `apps/api/src/fleet/git-broker/git-token.broker.purpose.spec.ts` — the broker's third constructor argument becomes a `GitLabRepoCredentials` mock instead of a `GitLabTokenSource` mock; every purpose assertion stays.
- `apps/api/src/fleet/sync/sync.service.token-purpose.spec.ts` — the `GitTokenBroker` it builds takes a `GitLabRepoCredentials` mock instead of a `GitLabTokenSource` mock; every token-purpose assertion stays.

**US-004**
- `apps/api/src/fleet/repos/fleet-repos.service.spec.ts` — the service is built with the target constructor arguments; GitLab create and check are verified with the stored or supplied tokens through `GitLabAccessChecker.getTokenSelf`, `getCurrentUser` and `findProject` instead of `verifyRepo` and `GitLabTokenSource`; the GitHub cases stay unchanged.
- `apps/api/src/fleet/repos/fleet-repos.auto-review.spec.ts` — `FleetReposService` is built with the target constructor arguments (a `GitLabRepoCredentials` mock in place of the `GitLabTokenSource` mock, plus `GitTokenBroker` and fleet-config mocks after it); every auto-review assertion stays.
- `apps/api/src/fleet/repos/fleet-repos.disable-auto-review.spec.ts` — `FleetReposService` is built with the target constructor arguments (a `GitLabRepoCredentials` mock in place of the `GitLabTokenSource` mock, plus `GitTokenBroker` and fleet-config mocks after it); every assertion stays.
- `apps/api/src/fleet/repos/fleet-repos.fix-checks.spec.ts` — `FleetReposService` is built with the target constructor arguments (a `GitLabRepoCredentials` mock in place of the `GitLabTokenSource` mock, plus `GitTokenBroker` and fleet-config mocks after it); every fix-checks assertion stays.
- `apps/api/src/fleet/repos/fleet-repos.fix-unprotected.spec.ts` — `FleetReposService` is built with the target constructor arguments (a `GitLabRepoCredentials` mock in place of the `GitLabTokenSource` mock, plus `GitTokenBroker` and fleet-config mocks after it); every fix-unprotected assertion stays.
- `apps/api/src/fleet/repos/fleet-repos.rule-override.spec.ts` — `FleetReposService` is built with the target constructor arguments (a `GitLabRepoCredentials` mock in place of the `GitLabTokenSource` mock, plus `GitTokenBroker` and fleet-config mocks after it); every rule-override assertion stays.
- `apps/api/src/approvals/approval-execution.service.spec.ts` — where it builds `FleetReposService`, it passes the target constructor arguments (a `GitLabRepoCredentials` mock in place of the `GitLabTokenSource` mock, plus `GitTokenBroker` and fleet-config mocks after it); every approval assertion stays.
- `apps/api/src/fleet/repos/fleet-repo-route.commands.spec.ts` — the `fleet.repo.create` registration gains `redeem.redact`; its parse and run assertions stay.
- `apps/api/test/integration/fleet/fleet-repos.integration.spec.ts` — the GitLab create cases stop seeding a project `VcsConnection` and send `readToken` and `writeToken` with the forge calls stubbed; the 422 case for a repo the token cannot see stays a 422 with the new reason; the GitHub cases stay.
- `openapi.json` — regenerated by `bun run generate` for the changed create body and repo response.

**US-005**
- `apps/api/src/permissions/catalog.spec.ts` — the closed key lists gain `fleet.repo.credentials.update` next to `fleet.repo.create`; every other assertion stays.
- `apps/api/src/fleet/repos/fleet-repo-route.commands.spec.ts` — the registry gains the `fleet.repo.credentials.update` command with its parse and `redeem.redact`; the existing commands' assertions stay.
- `apps/api/test/integration/fleet/gated-fleet-admin-routes.integration.spec.ts` — the gated `keys` list gains `fleet.repo.credentials.update`; the existing routes' assertions stay.
- `apps/api/src/permissions/__snapshots__/role-matrix.json` — every role block gains the cell for `fleet.repo.credentials.update` with the same values as its `fleet.repo.create` cell; no other cell changes.
- `docs/superpowers/specs/2026-10-18-permission-action-inventory.tsv` — one REST row for PATCH /fleet/repos/:id/gitlab-credentials (area fleet/repos, write, global, key fleet.repo.credentials.update), modelled on the POST /fleet/repos row.
- `openapi.json` — regenerated by `bun run generate` for the new route.

**US-006**
- `apps/api/src/fleet/git-broker/git-broker.module.ts` — `GitLabTokenSource` leaves the providers and exports.

**US-007**
- `apps/cli/src/commands/fleet-repo.spec.ts` — the `add` request body gains the GitLab fields only for `--provider gitlab`; the GitHub body assertions stay unchanged.

**US-008**
- `apps/web/tests/i18n/fleet-locale-parity.spec.ts` — the `ENUMS['fleet.repoReason']` list gains `gitlab_credentials_missing`, `gitlab_host_invalid`, `gitlab_host_blocked`, `gitlab_host_unclassified`, `gitlab_read_token_writable`, `gitlab_read_token_no_access` and `gitlab_project_mismatch`, so it still equals the API's reason values; the other enum lists stay.

### Seams

- US-001 → US-002, US-003, US-004, US-005: `GitLabRepoCredentials` is called by the refresher, attribution, files reader, broker, registration and rotation. Seam ACs: US-002 AC-12, AC-13; US-003 AC-1; US-004 AC-9; US-005 AC-3.
- US-002 → US-004, US-005: `parseGitLabHost`, `assertGitLabHostAllowed`, `getTokenSelf`, `getCurrentUser` and `findProject` are called by registration and rotation. Seam ACs: US-004 AC-2, AC-4; US-005 AC-4.
- US-003 → US-005: `GitTokenBroker.evictRepo` is called by rotation. Seam AC: US-005 AC-6.
- US-004, US-005 → US-007, US-008: the create body, the `gitlab` response field and the rotation route are consumed by the CLI and the web. Seam ACs: US-007 AC-1, AC-5; US-008 AC-2, AC-7.

## Acceptance Criteria

### US-001

- AC-1 [integration] After the migration, `FleetRepoGitlabCredential` rows can be created for a `FleetRepo`, and deleting that `FleetRepo` deletes its credential row.
- AC-2 [integration] Two `FleetRepo` rows with the same `provider`, `owner` and `name` but different `host` values can both be created.
- AC-3 [integration] A second `FleetRepo` with the same `provider`, `host`, `owner` and `name` is refused with Prisma error code `P2002`.
- AC-4 [integration] A `FleetRepo` created without `host` reads back with `host` equal to `https://github.com`.
- AC-5 [unit] `GitLabRepoCredentials.save` followed by `resolve({ id, host: 'https://gitlab.example.com' }, 'write')` returns the saved write token and `target` `{ apiBase: 'https://gitlab.example.com/api/v4', projectId: <saved gitlabProjectId> }`.
- AC-6 [unit] `resolve(repo, 'read')` returns the read token, not the write token, for the same record.
- AC-7 [unit] The repository row written by `save` stores `encryptedReadToken` and `encryptedWriteToken` values that differ from the plaintext tokens and decrypt to them with `decryptToken` under the configured key.
- AC-8 [unit] `resolve` for a repo with no record throws `RepoCheckException` with reason `gitlab_credentials_missing`.
- AC-9 [unit] `resolve` with `vcsConfig.encryptionKey` unset throws `RepoCheckException` with reason `vcs_encryption_key_missing`.
- AC-10 [unit] `call(repo, 'read', fn)` whose `fn` throws `RepoCheckException('gitlab_token_invalid')` sets `readTokenInvalidAt` (and not `writeTokenInvalidAt`) and rethrows the same exception.
- AC-11 [unit] `call(repo, 'write', fn)` whose `fn` throws `RepoCheckException('provider_error')` sets neither `*InvalidAt` field and rethrows.
- AC-12 [unit] A `save` that replaces only the write token clears `writeTokenInvalidAt`, keeps `readTokenInvalidAt`, and keeps the stored read token.
- AC-13 [unit] `gitlabTokenStatus` returns `invalid` when `invalidAt` is set, `expiring` when `expiresAt` is 14 days or less after `now`, and `ok` otherwise (including a null `expiresAt`).
- AC-14 [integration] `PrismaFleetRepoRepository.findById` for a GitLab repo with a credential record returns `gitlabCredential` with the usernames, `writeTokenIsBot` and expiries, and without `encryptedReadToken` or `encryptedWriteToken` keys.
- AC-15 [unit] `FleetRepoDto.from` for a GitLab row whose `gitlabCredential.writeTokenIsBot` is false returns `gitlab.warnings` `['write_token_human']`, and for a GitHub row returns `host` `https://github.com` and `gitlab` `null`.

### US-002

- AC-1 [unit] `parseGitLabHost('HTTPS://GitLab.Example.com:8443/gl/')` returns `https://gitlab.example.com:8443/gl`.
- AC-2 [unit] `parseGitLabHost` throws `RepoCheckException` with reason `gitlab_host_invalid` for `http://gitlab.example.com`, `https://user@gitlab.example.com`, `https://gitlab.example.com/?a=1` and `https://gitlab.example.com/#x`.
- AC-3 [unit] `isClassifiableGitLabHost` is true for `https://gitlab.corp.example` and false for `https://git.corp.example`.
- AC-4 [unit] With `dns.lookup` stubbed to return `192.168.1.20`, `assertGitLabHostAllowed('https://gitlab.lan')` resolves.
- AC-5 [unit] With `dns.lookup` stubbed to return `127.0.0.1`, `169.254.169.254`, `::ffff:169.254.169.254`, `100.100.100.200` or `fd00:ec2::254`, `assertGitLabHostAllowed` throws `RepoCheckException` with reason `gitlab_host_blocked`.
- AC-6 [unit] With `dns.lookup` stubbed to return both `192.168.1.20` and `169.254.169.254`, `assertGitLabHostAllowed` throws `gitlab_host_blocked`.
- AC-7 [unit] `GitLabAccessChecker.getMergeRequest(access, 7)` requests `<apiBase>/projects/<projectId>/merge_requests/7` with header `private-token` set to `access.token`.
- AC-8 [unit] Any `GitLabAccessChecker` method whose host check throws `gitlab_host_blocked` sends no request through `FleetHttpClient.request`.
- AC-9 [unit] A `GitLabAccessChecker` call answered 401 throws `RepoCheckException('gitlab_token_invalid')`, and one answered 403 throws `RepoCheckException('app_permissions_insufficient')`.
- AC-10 [unit] `getTokenSelf(apiBase, token)` returns the `scopes` array and `expiresAt` parsed from `expires_at`, with `expiresAt` `null` when `expires_at` is null.
- AC-11 [unit] `getCurrentUser(apiBase, token)` returns `{ id, username, bot }`, with `bot` false when the response omits it.
- AC-12 [unit] `FleetPrStateRefresher` refreshing a GitLab-repo PR link calls `GitLabRepoCredentials.call` with that repo and kind `read`, and the MR state read through it is applied to the link.
- AC-13 [unit] `PrAttributionService` attributing a GitLab job calls `GitLabRepoCredentials.call` with kind `write` and posts the attribution body through `commentOnMergeRequest(access, iid, body)`.
- AC-14 [unit] `GitlabFleetRepoFilesReader.list` calls `GitLabRepoCredentials.call` with kind `read` and returns the `.nax` entries from `listTree(access, '.nax', baseSha)`.
- AC-15 [unit] A `GitLabAccessChecker` call answered 500 with a JSON body throws a `RepoCheckException` whose response payload is exactly `{ reason: 'provider_error' }`, carrying none of the GitLab body.

### US-003

- AC-1 [unit] `GitTokenBroker.mint` for a GitLab repo with no `purpose` and no `readOnly` returns the token from `GitLabRepoCredentials.resolve(repo, 'write')` with `username: 'oauth2'`.
- AC-2 [unit] `GitTokenBroker.mint` for a GitLab repo with `purpose: 'read'` returns `{ ok: false }` with reason `provider_error` and does not call `GitLabRepoCredentials.resolve`.
- AC-3 [unit] A GitLab mint whose `resolve` throws `gitlab_credentials_missing` returns `{ ok: false }` with reason `gitlab_credentials_missing`.
- AC-4 [unit] After `evictRepo(repoId)`, the next `mint` for a job on that repo calls `GitLabRepoCredentials.resolve` again instead of returning the cached token.
- AC-5 [unit] `evictRepo(repoId)` leaves cached tokens of jobs on other repos in place: their next `mint` returns the cached token without calling `resolve`.
- AC-6 [unit] `cloneUrlFor({ provider: 'gitlab', host: 'https://gitlab.example.com/gl', owner: 'g/sub', name: 'app' }, cfg)` returns `https://gitlab.example.com/gl/g/sub/app.git`.
- AC-7 [unit] `cloneUrlFor` for a GitLab repo without `host` returns the URL built from `cfg.gitlabApiUrl`, as today.
- AC-8 [unit] `cloneUrlFor` for a GitHub repo returns the URL built from `cfg.githubApiUrl`, whatever `host` holds.
- AC-9 [integration] A job assigned on a GitLab repo whose row has `host` `https://gitlab.example.com` carries clone URL `https://gitlab.example.com/<owner>/<name>.git` in its assign payload.
- AC-10 [unit] `GitTokenBroker.mint` for a GitLab repo with `readOnly: true` and no purpose returns `{ ok: false }` and does not call `GitLabRepoCredentials.resolve`.

### US-004

- AC-1 [integration] `POST /api/fleet/repos` with `provider: 'github'` and a `readToken` answers 400 with the `fleet.repoGitlabFieldsOnGitHub` message and creates no row.
- AC-2 [unit] `prepareCreate` for GitLab with host `http://gitlab.example.com` throws `gitlab_host_invalid` before any `GitLabAccessChecker` call.
- AC-3 [unit] `prepareCreate` for GitLab with host `https://git.corp.example` throws `gitlab_host_unclassified` before any `GitLabAccessChecker` call.
- AC-4 [unit] `prepareCreate` for GitLab with no `host` verifies against `https://gitlab.com/api/v4`.
- AC-5 [unit] A write token whose `getTokenSelf` scopes lack `write_repository` makes `prepareCreate` throw `gitlab_scope_missing`.
- AC-6 [unit] A read token whose `getTokenSelf` scopes are `['read_api', 'read_repository', 'api']` makes `prepareCreate` throw `gitlab_read_token_writable`.
- AC-7 [unit] A write token whose `findProject` access level is 20 makes `prepareCreate` throw `gitlab_access_insufficient`.
- AC-8 [unit] A read token for which `findProject(apiBase, readToken, <project id>)` throws `repo_not_found` makes `prepareCreate` throw `gitlab_read_token_no_access`.
- AC-9 [integration] A successful GitLab create stores a `FleetRepo` with the canonical owner, name and default branch from `findProject`, and the given host. It also stores a credential record whose `gitlabProjectId`, token usernames and expiries come from the verification calls.
- AC-10 [unit] A write token whose `getCurrentUser` answers `bot: false` with a username other than `fleetConfig.gitlabBotName`, and no `confirmBotAccount`, is saved with `writeTokenIsBot` false. The `fleet.repo.create` audit summary is `registered gitlab; write token belongs to a person (<username>)`.
- AC-11 [unit] The same write token with `confirmBotAccount: true` is saved with `writeTokenIsBot` true, and the audit summary is `registered gitlab`.
- AC-12 [unit] A write token whose `getTokenSelf` throws `gitlab_token_invalid` makes `prepareCreate` throw `gitlab_token_invalid`, and `GitLabRepoCredentials.save` is not called.
- AC-13 [integration] A successful GitLab create whose write token belongs to a person answers with `gitlab.warnings` `['write_token_human']` and `gitlab.writeToken.username` set, and the response holds no `readToken` or `writeToken` field.
- AC-14 [unit] The `fleet.repo.create` route command's `redeem.redact` returns the input with `readToken` and `writeToken` replaced by the `redactSecret` marker and every other field unchanged.
- AC-15 [unit] `check` for a GitLab repo whose stored read token now answers 401 returns `reachable: false` with reason `gitlab_token_invalid` without a conflict, and calls `GitLabRepoCredentials.markInvalid(repoId, 'read')` only from the returned closure, not from `prepareCheck` itself.

### US-005

- AC-1 [integration] `PATCH /api/fleet/repos/:id/gitlab-credentials` with an empty body answers 400 with the `fleet.repoGitlabCredentialsEmpty` message.
- AC-2 [integration] The same route on a GitHub repo answers 400 with the `fleet.repoNotGitlab` message.
- AC-3 [integration] A valid new `writeToken` replaces the stored write token (a following `GitLabRepoCredentials.resolve(repo, 'write')` returns it), keeps the stored read token, and records audit `fleet.repo.credentials.update` with summary `write token replaced`.
- AC-4 [unit] `rotateGitlabCredentials` with a new write token whose `findProject(apiBase, token, <stored gitlabProjectId>)` throws `repo_not_found` throws `gitlab_project_mismatch` and saves nothing.
- AC-5 [unit] `rotateGitlabCredentials` with a new `readToken` whose scopes include `write_repository` throws `gitlab_read_token_writable` and saves nothing.
- AC-6 [unit] A successful rotation calls `GitTokenBroker.evictRepo` with the repo id after `GitLabRepoCredentials.save`.
- AC-7 [unit] A failed rotation does not call `GitTokenBroker.evictRepo`.
- AC-8 [unit] Rotating both tokens records the audit summary `read and write tokens replaced`.
- AC-9 [unit] A rotated write token that is a person's, with no `confirmBotAccount`, is saved with `writeTokenIsBot` false.
- AC-10 [unit] The `fleet.repo.credentials.update` route command's `redeem.redact` replaces each present token with the `redactSecret` marker and leaves an absent token absent.
- AC-11 [unit] `findCatalogEntry('fleet.repo.credentials.update')` returns an entry with `risk` `high` and `scope` `global`.
- AC-12 [integration] A user without `fleet.repo.credentials.update` gets 403 from the route, and the stored tokens are unchanged.
- AC-13 [integration] An agent principal calling the route gets an approval-pending answer, and the stored `ApprovalRequest` input holds the `redactSecret` marker in place of each submitted token.

### US-006

**Verification note:** the removal is checked by the build/static gate `bun run --cwd apps/api type-check` and `bun run --cwd apps/api lint`. No acceptance criterion asserts an absence.

- AC-1 [unit] `GitBrokerModule` compiles in a module spec with its external collaborators mocked, and resolves `GitLabRepoCredentials` and `GitTokenBroker` without a `GitLabTokenSource` provider.

### US-007

- AC-1 [cli] `koda fleet repo add group/app --provider gitlab --host https://gitlab.example.com --read-token-file r.txt --write-token-file w.txt` sends `POST /fleet/repos` with `host`, `readToken` and `writeToken` read from those files, trimmed of a trailing newline.
- AC-2 [cli] `--read-token-file -` reads the read token from stdin.
- AC-3 [cli] `koda fleet repo add group/app --provider gitlab` without both token files exits 3 and sends no request.
- AC-4 [cli] `koda fleet repo add owner/name --provider github --host https://x` exits 3 and sends no request.
- AC-5 [cli] When the created repo's `gitlab.warnings` contains `write_token_human`, the command writes a warning naming the write token's username to stderr and exits 0.
- AC-6 [cli] `--json` prints the created repo as JSON, with no token values in it.
- AC-7 [cli] `koda fleet repo credentials <id> --write-token-file w.txt` sends `PATCH /fleet/repos/<id>/gitlab-credentials` with only `writeToken`.
- AC-8 [cli] `koda fleet repo credentials <id>` with neither token flag exits 3 and sends no request.
- AC-9 [cli] A token file that does not exist exits 3 with a message naming the file, and sends no request.

### US-008

- AC-1 [unit] In `AddRepoDialog`, choosing provider `gitlab` shows host, read token, write token and "dedicated bot account" inputs; choosing `github` hides them.
- AC-2 [unit] Submitting the GitLab form calls `POST /fleet/repos` with `host`, `readToken`, `writeToken` and `confirmBotAccount`, and leaves `host` out when the field is empty.
- AC-3 [unit] The GitLab form refuses to submit, showing the `fleet.repos.gitlab.tokensRequired` message, when either token is empty.
- AC-4 [unit] After a create whose response has `gitlab.warnings` `['write_token_human']`, the dialog shows the `fleet.repos.gitlab.humanWarning` text with the write token's username.
- AC-5 [unit] The repo admin list shows a GitLab repo's host, and a badge with the `fleet.repos.gitlab.humanBadge` text when `gitlab.writeToken.isBot` is false.
- AC-6 [unit] The repo admin list shows each token's status, using `fleet.repos.gitlab.status.invalid` for an `invalid` token and `fleet.repos.gitlab.status.expiring` for an `expiring` one.
- AC-7 [unit] `RepoGitlabCredentialsDialog` submitting only a new write token calls `PATCH /fleet/repos/<id>/gitlab-credentials` with only `writeToken`.
- AC-8 [unit] `RepoGitlabCredentialsDialog` is offered only for GitLab repos and only when the viewer holds `fleet.repo.credentials.update`.
- AC-9 [unit] A refused rotation shows the API error through `extractApiError` and keeps the dialog open.
- AC-10 [unit] Every new string has an `en` and a `zh` entry under `fleet.repos.gitlab`.
- AC-11 [unit] The repo reachability badge shows the `fleet.repoReason.gitlab_host_blocked` text for a check result with reason `gitlab_host_blocked`, and each of the seven new reasons has an `en` and a `zh` string.
