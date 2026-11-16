# GitLab parity for the koda fleet

Date: 2026-11-16. Status: design, for owner approval. Base: koda main `6d704c1e`.

## 1. Intent

The owner wants to use koda on GitLab repositories the way koda already works on GitHub. Today koda's fleet is
built around the GitHub App: GitLab repos can sync tickets and run `RUN` jobs, but every newer feature refuses
them. The goal is parity, "as close as GitHub", for gitlab.com (the default) and for self-hosted GitLab.

The first live target is `freqtrade/quant-crypto-trader` on gitlab.com. It is used only to prove the work end to
end on koda-wk. Nothing in the design is specific to it.

## 2. Goals, non-goals, anti-goals

**Goals**

- Every fleet feature that works for a GitHub repo works for a GitLab repo, with the same API, CLI and web
  surfaces. Section 5 lists each feature and its GitLab equivalent.
  - jobs: REVIEW, FIX, AGENT, RUN;
  - auto-review, fix-checks and the FIX protected-branch gate;
  - flows, PR rulings and review events;
  - threads with project code, the project brief and the knowledge index;
  - MR state refresh and PR attribution.
- A GitLab repo can live on gitlab.com or on any self-hosted GitLab. gitlab.com is the default.
- One koda project can hold several GitLab repos, as it can several GitHub repos.
- Credentials keep GitHub's read/write split: a job that only reads never receives a credential that can write.

**Non-goals (this arc)**

- Minting a short-lived token per job (GitLab project/group access tokens minted through the API). On gitlab.com
  this needs Premium or Ultimate, and both of the owner's groups are Free. Deferred; the design keeps a seam for it
  (section 6.4).
- Inbound GitLab webhooks. Not needed: GitHub auto-review, review events and MR state are already poll-driven
  (`fleet-pr-review.poller.ts`, `review-event-mint.poller.ts`, `fleet-pr-state.refresher.ts`). The 2026-09-27
  Track 3 ruling (GitLab is polling plus outbound) stands.
- Bitbucket or any other forge.
- Changing ticket sync (`vcs/`). It already works on GitLab by polling. It is touched only where it shares the
  per-project token (section 6.3).

**Anti-goals (a failure even if it works)**

- A read-only job (AGENT, a thread, knowledge indexing) ends up holding the write token, through a fallback or a
  cache hit.
- A credential appears in a log line, an error body, an audit summary, an activity row or a job artifact.
- GitHub behaviour changes. Every GitHub path must stay byte-for-byte the same in what it calls and returns.
- A self-hosted host is reached with a token stored for another host.

## 3. Constraints

- GitLab.com Free: no project/group access tokens. Free private groups have a 5-member limit, and each of the
  owner's groups has 1 member today, so a separate bot account fits.
- GitLab deploy tokens can clone (`read_repository`) but cannot call the REST API, and koda's read paths need the
  API (MRs, files, trees, discussions, pipelines). So the read credential is a personal or access token with
  `read_api` + `read_repository`, not a deploy token.
- No GitLab scope gives "comment on MRs but not push". On GitLab, the token a REVIEW job uses can therefore write.
  See section 6.2 for how that is contained.
- nax already supports GitLab (`packages/nax/src/forge/*`): bot review, bot fix and MR publishing work on GitLab
  today (store-erp uses them). **One nax gap:** `forgeFromRemoteUrl` classifies by host name containing `github` or
  `gitlab`. When neither matches, it falls back to "whichever of gh/glab is installed", and the koda runner has
  both. A self-hosted host like `git.corp.example` is therefore unclassified. Filed as nax #2957: accept an
  explicit forge kind (for example `NAX_FORGE_KIND=gitlab`), which the runner then sets per job (section 8). Until
  it ships, self-hosted hosts whose name contains `gitlab` work, and others are refused at repo registration with a
  clear reason.
- koda is single-replica. In-process caches and pollers are acceptable, as on GitHub.

## 4. Approaches considered

| | Approach | Trade-off | Outcome |
|:--|:--|:--|:--|
| A | One bot token per repo for every job type, extending today's single GitLab token | Simplest setup. Read-only becomes a koda promise: AGENT and threads would hold a token that can push. | Rejected |
| B | Two tokens per repo from the same bot identity: **read** (`read_api`, `read_repository`) and **write** (`api`, `write_repository`) | Closest to GitHub's per-purpose split; GitLab itself refuses a read job's writes. One extra token to create per repo. | **Chosen by the owner** |
| C | Mint short-lived scoped tokens per job, like GitHub installation tokens | True parity, but needs Premium or self-hosted. | Deferred by the owner; seam kept |

Owner decisions in the conversation:

- B, with C deferred.
- Self-hosted GitLab in scope; gitlab.com the default.
- If the write token belongs to a human account instead of a separate bot, **allow it with a warning** (section
  6.5). Do not refuse.
- Self-hosted host rule A: HTTPS only, private and LAN addresses allowed, metadata, link-local and loopback
  refused, no redirects (section 6.1).
- File the nax forge-kind issue (done: nax #2957).

## 5. Feature map: GitHub today, GitLab after

"Read" and "write" name the two stored tokens. Every GitHub App call below already exists in
`fleet/git-broker/github-app-client.ts`.

| Feature (caller) | GitHub call | GitLab equivalent | Token |
|:--|:--|:--|:--|
| Repo registration (`fleet-repos.service.ts` `verifyRepo`) | installation lookup | `GET /projects/:path` (id, `path_with_namespace`, `default_branch`, archived) plus `GET /user` for each token | both, at save |
| REVIEW job credential (`git-token.broker.ts` purpose `review`) | `mintReviewToken` | stored write token | write |
| AGENT credential (purpose `read`) | `mintReadOnlyToken` | stored read token | read |
| Project/thread read-only mint (`readOnly`) | `mintReadOnlyToken` | stored read token, with `repoId` | read |
| FIX credential (purpose `fix`) | `isBranchProtected` then `mintInstallationToken` | protected-branch check (below), then the write token | read for the check, write for the job |
| FIX protected-branch gate (`isBranchProtected`) | ruleset/classic protection | `GET /projects/:id/protected_branches/:branch` (Free tier fields only): protected when the branch is listed, `allow_force_push` is false, and no `push_access_levels` entry has an `access_level` at or below the bot's effective level from `GET /projects/:id/members/all/:bot_id`, which includes inherited group membership. Per-user and per-group push entries (Premium) also count as allowing push when they name the bot. `fixAllowUnprotected` overrides it, as on GitHub. | read |
| Auto-review PR listing (`fleet-pr-review.pass.ts` `listOpenPullRequests`) | open PRs | `GET /projects/:id/merge_requests?state=opened` | read |
| PR state (`fleet-pr-state.refresher.ts`, rulings, flows: `getPullRequest`) | PR + checks | `GET /projects/:id/merge_requests/:iid` plus `head_pipeline` | read |
| Review events (`review-event.minter.ts` `getReviewThread`, `getRepoRole`) | GraphQL review thread, collaborator permission | `GET .../merge_requests/:iid/discussions/:id` (note authors, resolved); `GET /projects/:id/members/all/:user_id` access level | read |
| Rulings (`fleet-pr-rulings.service.ts` `listIssueComments`) | issue comments | `GET .../merge_requests/:iid/notes` | read |
| PR attribution comment (`pr-attribution.service.ts` `commentOnPullRequest`) | issue comment | `POST .../merge_requests/:iid/notes` | write |
| Flows: branch head, file reads, tree (`getBranchHead`, `getFile`, `getTree`/`getSubtree`) | contents API | `GET /repository/branches/:b`, `GET /repository/files/:path?ref=`, `GET /repository/tree?recursive=true` (paginated) | read |
| Flows: feature branch and calls commits (`createBranch`, `putFile`) | git data API | `POST /repository/branches`, `POST/PUT /repository/files/:path` (commit with message) | write |
| Flows: own-commit checks (`isSingleFileCommit`, `isOwnCallsRun`) | compare | `GET /repository/compare?from=&to=` (commits, diffs) with the same rules: linear, every message carries the marker, only the declared paths | read |
| Project brief (`project-brief.service.ts`) | files | files/tree as above | read |
| Knowledge index (`knowledge-repo-indexer.ts`) | tree + files | tree + files as above | read |
| Thread project code (`project-repos-assign.ts`) | bare mirror with a read token | same mirror, read token, `username: oauth2` | read |
| Repo config files (`fleet-repo-files.router.ts`) | already routed | already has a GitLab reader; move it to the per-repo read token | read |
| CI checks for fix-checks and flows | check runs, statuses | `GET /projects/:id/pipelines?sha=` and `GET /pipelines/:id/jobs` | read |
| RUN identity (`host-executor.ts` `runIdentityEnv`) | login-only via the gh shim | login-only via the glab shim (nax `forge/identity.ts` is forge-neutral); `NAX_FORGE_LOGIN` = bot username | write (shim) |
| REVIEW/FIX bot login (`assign-payload.ts`) | `<slug>[bot]` | the write token's username, stored at save | n/a |

**GitLab client.** A partial client already exists: `fleet/git-broker/gitlab-access-checker.ts`, with
`commentOnMergeRequest`, `getMergeRequest`, `getBranchHead`, `listTree`, `getFile` and `verifyRepo`. It is used by
`fleet-pr-state.refresher.ts`, `fleet-repos.service.ts`, `gitlab-fleet-repo-files.reader.ts` and
`pr-attribution.service.ts`, but it reads one global `vcsConfig.gitlabApiUrl` and addresses projects by
`owner/name`. It is **extended, not replaced**:

- every method takes the repo's GitLab connection (host + project id) instead of the global URL and `owner/name`;
- the missing calls from the table above are added;
- the current callers move to the new signature.

Method names and return types match the GitHub client where they can be shared. The error mapping is the same:
404 is `repo_not_found`, 401 is `gitlab_token_invalid`, 403 is `app_permissions_insufficient`, anything else is
`provider_error`. Call sites choose GitHub or GitLab through one small router per concern, as
`fleet-repo-files.router.ts` already does.

**What "connected" means on GitLab.** Several guards check `githubInstallationId === null`, not just the provider
(`fleet-repos.service.ts:93,127,149`, the knowledge indexer, flows, rulings, `project-repos-assign.ts`). The GitLab
equivalent of "installed" is that the repo has its GitLab record and both tokens are stored and not marked
`invalid`. A small shared predicate (for example `isForgeConnected(repo)`) answers it for both forges, and each
guard uses it. `fixAllowUnprotected` and `fixTrustDetectedChecks` apply to GitLab repos as they do to GitHub ones.

The remaining GitHub-only guards are removed:

- `fleet-jobs.service.ts:100` and `dispatch-job-tool.ts:100`;
- `git-token.broker.ts:70`;
- `fleet-repos.service.ts:93,127,149`;
- `project-repos-assign.ts:53`, `project-brief.service.ts:91`, `knowledge-repo-indexer.ts:79`;
- `fleet-flow-feature-passes.ts:87,251`, plus the hard-coded `provider: 'github'` at `fleet-flow-advance.service.ts:905`;
- `fleet-pr-rulings.service.ts:122`, `prisma-fleet-pr-ruling.repository.ts:67,115,135`;
- `host-executor.ts:289`.

## 6. Credentials

### 6.1 What is stored

A new per-repo record holds the GitLab connection of one fleet repo:

- `host`: the web base URL. Default `https://gitlab.com`. The API base is `<host>/api/v4`. **Host rule (owner
  decision A):**
  - `https://` only. Plain `http://` is refused.
  - LAN and private addresses (RFC 1918, unique-local IPv6) are allowed, since self-hosted GitLab is usually
    internal.
  - Link-local and cloud-metadata addresses (`169.254.0.0/16`, `fe80::/10`, `100.100.100.200`,
    `fd00:ec2::254`) and loopback are refused.
  - The check runs on the resolved addresses at save and again on every outbound call, so DNS changes cannot get
    around it.
  - GitLab calls never follow redirects: a 3xx is a `provider_error`. A token is only ever sent to the exact host it
    was saved for.
  - The runner gets the host in the job assign and uses it as given. It does not re-resolve a different host.
- `gitlabProjectId`: numeric, from `GET /projects/:path` at save. API calls use the id, so a renamed or moved
  project keeps working.
- `readToken` and `writeToken`: encrypted with the existing VCS encryption key, the same way as today's
  `VcsConnection.encryptedToken`.
- `readTokenUser`, `writeTokenUser`: the GitLab user id and username `GET /user` returns for each token.
- Optional `readTokenExpiresAt`, `writeTokenExpiresAt` from `GET /personal_access_tokens/self` when the host
  answers it.
- `writeTokenIsBot`: section 6.5.

`FleetRepo` uniqueness changes from `(provider, owner, name)` to `(provider, host, owner, name)`. GitHub rows get
`host = https://github.com` in the migration. The GitHub path keeps reading its existing config, and the column
only takes part in the key.

**Repo identity lookups (builder-check answer, my call).** Lookups that start from a URL carry the host, and so do
`findByIdentity` and `findIdentity` (`fleet-repos.service.ts:239-255`). The nax flow entry's `remoteUrl`
resolution parses the host from the URL. For a GitHub URL the host is always `https://github.com`, so GitHub
results do not change. Lookups that start from a repo id (most of the fleet) are untouched.
`prNumberFor({provider, owner, name}, url)` only picks the PR/MR URL pattern by provider and needs no host. The
hard-coded `provider: 'github'` at `fleet-flow-advance.service.ts:905` becomes the repo's real provider.

### 6.2 Which job gets which token

| Use | Token | Notes |
|:--|:--|:--|
| AGENT, threads (`readOnly`), knowledge, brief, flows reads, pollers, review-event lookup | read | Never falls back to write. With no read token stored, the mint fails `gitlab_read_token_missing`. |
| RUN, FIX, flows writes, attribution comments | write | FIX runs the protected-branch check with the read token first, as GitHub does. |
| REVIEW | write | GitLab has no comment-only scope. Contained the same way GitHub's broader tokens are: nax bot review never pushes (its own guard), and the runner's existing review profile is unchanged. Recorded as a known difference in the docs. |

The broker cache keys stay as they are (`<jobId>:<epoch>:<purpose>` and so on). A stored token has no real
expiry, so the broker gives each issued token the existing `gitlabTokenTtlSec` lifetime, as it does today.
Replacing a repo's token **evicts every cached broker entry for that repo**, so a rotated token is never served
from cache. The runner's credential shim already sends `GITLAB_HOST` for a non-gitlab.com host
(`runner/src/credentials/shim.ts`).

**Request shapes stay the same as GitHub's (builder-check answer).** The AGENT credential (`purpose: 'read'`) is
repo-less, exactly as on GitHub (`git-token.broker.ts:62-66`), and is answered with the job repo's read token.
Per-repository `readOnly` mints for project/thread sessions carry `repoId` as they do on GitHub. In a multi-repo
project, each one is answered with that repo's own read token, so the runner's matching does not change.

### 6.3 Migration from today's per-project token

Today one GitLab token lives on the project's `VcsConnection` and serves both ticket sync and the one GitLab fleet
repo (`gitlab-token.source.ts`). After this change:

- Fleet code reads only the per-repo record. `gitlab-token.source.ts` leaves the fleet path (the broker's
  `gitlab.resolve(projectId, owner, name)` branch at `git-token.broker.ts:105-106` is replaced).
- Ticket sync keeps its `VcsConnection` token unchanged (out of scope).
- **No legacy fallback (my call).** koda-wk is the only koda install, and it has no GitLab fleet repo. A GitLab
  fleet repo without its record is "not connected": every mint fails `gitlab_credentials_missing`, and the repo page
  asks for the two tokens. The migration creates no record and keeps no RUN-only path.
- The "one GitLab fleet repo per project" rule (spec §7.1) is removed.

### 6.4 Seam for per-job minting (deferred)

A `GitLabCredentialSource` interface answers "give me a read or write token for this repo". The stored-token
implementation is the only one now. A future minting implementation (project access tokens on Premium or
self-hosted) replaces it without touching the broker or the callers.

### 6.5 Bot identity and the human-account warning

koda identifies its own work on GitLab by the **write token's user**. Wherever the GitHub code compares against the
bot login (`<slug>[bot]`, built in `assign-payload.ts:37`), the GitLab path compares against the write token's
username, and the job assign carries it the same way. That covers:

- the review bot login nax uses to recognise its own notes;
- PR authorship checks in rulings and review events, including the K2 rule that the approver differs from the MR
  author;
- any author check on FIX.

The rules themselves are not new; only the identity they compare against is.

At save, koda decides whether that user looks like a bot:

- GitLab `bot: true` (project/group access token bot users), or
- the username equals `FLEET_GITLAB_BOT_NAME`, or
- an admin ticks "this is a dedicated bot account" in the form.

When none of these hold, the save **succeeds with a warning** (owner decision). The warning reads, in substance:
"This token belongs to a person. koda will treat every MR this account opens, including ones opened by hand, as
its own: FIX may push to them and the not-a-defect approver check cannot tell you apart." The repo record keeps
`writeTokenIsBot = false`, and the repo page shows a persistent warning badge. The same warning appears in
`koda fleet repo add` output and in an audit entry on the save. Nothing else changes in behaviour.

The read token may belong to any user. Its user is recorded only for display.

## 7. Surfaces

- **API:** the fleet repo create and update DTOs accept, for `provider: 'gitlab'`, `host` (optional, default
  gitlab.com), `readToken` and `writeToken` (write-only fields, never returned), and `confirmBotAccount`
  (optional boolean). The repo read DTO adds:
  - `host`;
  - the token usernames, `writeTokenIsBot`, and each token's expiry date when known;
  - a `credentials` status per token: `ok`, `missing`, `invalid` or `expiring`.

  Rotating a token is an update with a new value. The permission keys and risk tiers are the same as for GitHub
  repo setup: creating a repo, and replacing its credentials, are credential writes at tier `high`, as today.
- **CLI:** `koda fleet repo add --provider gitlab [--host <url>] --read-token-file <f> --write-token-file <f>
  [--confirm-bot]`. Tokens are read from files or stdin, never from argv.
- **Web:** the repo registration form gets the GitLab fields, the bot warning and the badge. Wherever a GitHub-only
  reason is shown today ("not a GitHub repository", "github app required"), a GitLab repo now gets the feature
  instead.
- **Health:** no separate poller. Any GitLab call that gets a 401 marks that token `invalid` on the repo, so the
  admin sees it before the next job fails. The existing pollers make such calls regularly. Running jobs are not
  touched: they fail on their own if the token is dead. A token whose `expiresAt` is within 14 days shows
  `expiring`. A successful save or rotation clears `invalid`.
- **Docs:** a GitLab setup guide covering the bot account, the two tokens and their scopes, the Developer role,
  protecting the default branch, self-hosted host, and the known REVIEW difference.

## 8. Runner and nax

- `host-executor.ts`: `runIdentityEnv` and `reviewEnv` handle `gitlab`. They use the glab shim and set
  `NAX_FORGE_LOGIN` to the write token's username.
- The job assign carries the repo `host`. `clone-url.ts` builds the clone URL from the repo's host, not from the
  global `VCS_GITLAB_API_URL`. That global setting stays only as the default for ticket sync.
- **nax dependency:** an explicit forge kind for self-hosted hosts (section 3), nax #2957. The runner sets it
  per job once nax supports it. Until then, registration refuses a GitLab host whose name lacks `gitlab` with
  `gitlab_host_unclassified`.

## 9. Verification

- Unit and integration specs for the GitLab client, with recorded GitLab response shapes for every call in
  section 5: success, pagination, 401, 403 and 404.
- A broker spec proving read jobs never receive the write token, including the cache and "no read token" cases.
- GitHub regression: the existing GitHub specs must pass unchanged.
- **Live check on koda-wk with `freqtrade/quant-crypto-trader`:**
  1. register with a bot account's two tokens;
  2. a RUN job opens an MR;
  3. auto-review reviews it, and a FIX job fixes a finding on a protected default branch;
  4. an AGENT job and a thread read the code and are refused a push;
  5. a flow runs end to end;
  6. the knowledge index builds;
  7. a ruling round-trips.

  A second registration with a human-account token shows the warning. Self-hosted gets a smaller live check
  against a throwaway GitLab CE container on the Mac, if one is practical. Otherwise unit coverage only, noted in
  the result.

## 10. Left to the builder

- How to split this into nax features. Suggested order:
  1. credentials and repo registration (6, 7) plus the GitLab client;
  2. jobs (REVIEW, FIX, AGENT, RUN identity) and the broker;
  3. read features (threads, brief, knowledge, rulings, review events);
  4. flows and CI checks.

  Each step is about 5 to 7 stories.
- The exact names of the new table, columns and error codes, following existing conventions.
- Whether the GitLab client shares a base class with the GitHub one or only the method shapes.
- Pagination limits for tree and MR listing, matching the GitHub caps already in place.
