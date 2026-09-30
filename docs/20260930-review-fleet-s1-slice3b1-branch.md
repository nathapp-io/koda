# Whole-Branch Code Review: fleet S1 slice 3b-1 — runner git credential broker

**Date:** 2026-09-30
**Branch:** `feat/fleet-s1-slice3b-1-git-credentials`, head `58cf79ad` — PR [#174](https://github.com/nathapp-io/koda/pull/174), **not merged**
**Range:** `19ac4fc7` (main, slice 3a fixes) → `58cf79ad`, 15 commits, 59 files, +5,476/−68 (≈3,250 lines of that is the plan document itself)
**Plan:** `docs/superpowers/plans/2026-09-30-fleet-s1-slice-3b-1-git-credentials.md` (decisions D78–D94)
**Specs:** `2026-09-30-fleet-s1-slice-3-runner-design.md` §3.1/§4; `2026-09-29-fleet-s1-dispatch-design.md` §5.5/§6.3/§7.2/§7.3

**Method:**
- One independent read-only whole-branch reviewer over the full range, in passes (credentials core → daemon/sync/executor/supervisor wiring → tests and harness); all 59 changed files read; every token path traced end to end; D78–D94 checked one by one against the code.
- Gates actually run by the reviewer: `bun run type-check` and `bun run lint` (clean), `bun run test` (762 pass, 0 fail — baseline at `19ac4fc7` was 662), and `KODA_DB_TESTS=1 bun run test:integration` (17 pass, 0 fail, test Postgres up).
- Three load-bearing findings re-verified by hand at head `58cf79ad` before this document was written (`git-credential.ts:73-83`, `host-executor.ts:157` vs `:69`, `main.ts:14-15`).

**Verdict: READY TO MERGE — Yes.** 0 Critical, 0 Important, 7 Minor (hardening polish; none blocks merge). No behavioral deviation from any plan decision.

---

## Remediation update: 2026-09-30, same-day fixes on the branch

Every actionable minor was fixed on the branch the same day (see the status table; commits follow the review). Minor 5 was left unchanged — it is a deliberate plan decision (Task 2: token expiry is the server's wall clock, so the cache is always given `Date.now()`, never the injectable test clock). The two tests the earlier SDD review owed "when cred-server.ts is next open" (`job ended`, `reply too large`) landed with these fixes.

| Finding | Status | Evidence |
|:--|:--|:--|
| Minor 1 — helper can exit non-zero | **Fixed** | `runGitCred` wraps its body in try/catch and returns 0 on any failure (`git-credential.ts`); test "a stdin read failure still exits 0 with nothing and never asks the socket". |
| Minor 2 — `finishPlan` has no cancel probe | **Fixed** | `FinishPlanOptions.isCancelled` on the `JobExecutor` seam; `job-run.finish()` feeds `cancelRequested \|\| halted` (the same probe prepare got), a cancelled wait ends the job CANCELLED (the verdict `planVerdict` itself gives a cancel) and a halt records no transition at all. Tests: two in `job-run.spec.ts` (cancel → `RUNNING/UPLOADING/CANCELLED`; halt → only `RUNNING`, no upload) and the pass-through test in `host-executor.spec.ts`. |
| Minor 3 — raw `ENOTDIR` escapes `ensureSocketDir` | **Fixed** | The `lstat` failure is wrapped in a `SocketDirError` naming the directory and errno; test "a plain file as a parent component is refused as a SocketDirError". |
| Minor 4 — 64-byte guard counts UTF-16 units | **Fixed** | Server guard uses `Buffer.byteLength(buffered, 'utf8')` (`cred-server.ts`); the client's 16 KiB reply guard now measures bytes too. Test: `ß`.repeat(33) (66 bytes, 33 chars) → `bad request`. |
| Minor 5 — broker on raw `Date.now()` | **No change** | Deliberate (plan Task 2): token expiry is the server's wall clock; the injected `now` may be frozen in tests. |
| Minor 6 — `pathWithout` misses symlink aliases | **Fixed** | Entries are compared after `realpath` (falling back to `resolve` for missing entries); test drops a real symlink alias of the shim dir. |
| Minor 7 — operator token vars reach nax's env | **Fixed** | `withoutCredentialVars` drops `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN` from the environment nax is spawned with; the shims remain the only token path. Test: an env dump from a real fake-nax run shows the operator's `GH_TOKEN`/`GITLAB_TOKEN` gone and `NAX_GLOBAL_CONFIG_DIR` intact. |
| Owed — `job ended` untested | **Added** | `broker.spec.ts`: after `tokens.drop` with the socket still live, the reply is `{ ok: false, reason: 'job ended' }`. |
| Owed — `reply too large` untested | **Added** | `git-credential.spec.ts`: a 20 KB token reply → `{ ok: false, reason: 'reply too large' }`. |

**Gates after the fixes:** type-check and lint clean; **771 unit tests pass, 0 fail** (762 before, +9); **17 integration tests pass, 0 fail** against the real API (`KODA_DB_TESTS=1`, Postgres up, API rebuilt). The still-open SDD carry items for 3b-2 are unchanged: a socketDir ownership re-check inside `CredentialServer.listen`, and a `log.warn` when spawn's `acquire({ wait: false })` fails.

---

## What this branch is

The runner holds no git credentials of its own. Per-job tokens are requested over sync (`tokenRequests`, ≤64/sync), refreshed within 240 s of expiry, and kept only in daemon memory (`TokenCache`). A `CredentialBroker` serves each `(jobId, leaseEpoch)` from its own mode-0600 unix socket in a checked `socketDir` (default `/tmp/koda-runner-<uid>`, mode 0700, refused if symlinked, foreign-owned or group-accessible). `koda-runner git-cred` is the git credential helper; `<jobDir>/bin/gh`/`glab` shims inject the token into the one child's environment; nax gets the shims first on `PATH` and never a token variable. The integration harness now serves repos through an authenticated git-HTTP front (`git http-backend` behind Basic auth), so every scenario exercises the helper.

**Commits reviewed (oldest first):** `49d214c9` plan, `e6c7b9d4` plan review fixes, `b5259487` TokenCache, `7beb79f7` sync token requests, `3fc0dc52` socket dir + CredentialServer, `e2616c45` git-cred helper, `aec5a34d` gh/glab shim, `2514d3a4` internal commands + job files, `1fd68658` CredentialBroker, `955905f8` network git through the helper, `123a860c` executor/supervisor seams, `d8b5b861` daemon socket dir, `c2fbdfea` integration, `3989f069` docs, `58cf79ad` prepare ends its token wait on halt.

---

## Strengths

- **Token confinement is genuinely airtight as far as it can be traced.** The token value appears in exactly four places: `TokenCache.entries` (memory), the socket JSON reply (`cred-server.ts:20`), the helper's stdout (`git-credential.ts:81`), and the one shim child's env (`shim.ts:62`). Every error/log/file path was traced: server errors are logged as reason codes only (`daemon.ts:136`), socket provider throws are replaced with the fixed word `error` (`cred-server.ts:36-37`), the helper refuses to print usernames/tokens containing newline/NUL (`git-credential.ts:80`), and the shims and clone config carry only the socket path. Unit and integration suites assert the negative (`JSON.stringify(env)).not.toContain(TOKEN)`, journal bytes and log lines scanned — `host-executor-auth.spec.ts:81`, `credentials.integration.spec.ts:40-46`).
- **The staging-then-rename socket swap (`cred-server.ts:56-91`) is a subtle piece done right.** A server bound to the public path would unlink a newer server's socket when closing late; binding to a random staging name, chmod 0600 before rename, and the inode check in `close()` (`cred-server.ts:89-90`) solve stale-file replacement, two-epoch takeover, and the restarted-daemon race at once — each with a test (`cred-server.spec.ts:106-135`, `broker.spec.ts:105-114`).
- **All five of the plan's Review Focus failure modes have real tests**: near-expiry token cool-down (`token-cache.spec.ts:70-77`), foreign-host silence proven through real `git credential fill` (`credential-cli.spec.ts:39-49`), stale socket replacement plus end-to-end readopt push after `runner.crash()` (`broker.spec.ts:105`, `credentials.integration.spec.ts:69-88`), argv byte-for-byte through the shim script with quotes/`$`/backtick/newline (`credential-cli.spec.ts:53-74`), and symlink/world-readable socketDir refusal that makes zero server calls (`daemon-socket-dir.spec.ts`).
- **Tests verify real behavior**: real `git http-backend` behind Basic auth (`test/helpers/git-http.ts`), real unix sockets, real shim scripts spawning real subprocesses via `bun src/main.ts`, real clones/fetches/pushes over authenticated HTTP, and a real API in integration. Nothing security-relevant is mock-tested. The "wake() must not abort a sync carrying token requests" invariant has a dedicated test (`sync-loop.spec.ts`), as does "a failed sync delivers nothing".
- **The head-commit fix is correct and tested**: `prepareAndSpawn` feeds `|| this.halted` into prepare's cancel probe (`job-run.ts:191-194`), so an abandon during a first-token wait releases the repo mutex immediately instead of deadlocking `abandon()` — the new `job-run.spec.ts` test proves the wait ends at the next poll with no bogus transition.
- **Docs are accurate and consistent**: `.nax/mono/apps/runner/context.md`, the regenerated AGENTS/CLAUDE/GEMINI/codex files, and the design-spec amendment blocks (D89/D91 supersession, D78/D79/D82 amendment) all match the code.

---

## Issues

### Critical (Must Fix)

None found. No confinement violation, no local-user token-capture path, no lifecycle hang.

### Important (Should Fix)

None found. Specifically looked at and cleared: the socket-dir TOCTOU (0700 directory plus sticky `/tmp` closes it), the bind→chmod window on the staging socket (unreachable by another uid inside a 0700 dir), concurrent same-key `acquire` (check-then-insert is synchronous in one JS turn, `broker.ts:107-122`), token/epoch fencing in `apply` (unrequested or dropped jobIds ignored, `token-cache.ts:94-96`), and shutdown ordering (`closeAll`'s `closing` flag ends any in-flight token wait within one 250 ms poll).

### Minor (Nice to Have)

1. **Helper can exit non-zero if reading stdin throws** — `apps/runner/src/credentials/git-credential.ts:73-83`. D80 says the helper "always exits 0", but if `readStdin` (i.e. `Bun.stdin.text()`) rejects, `runGitCred`'s promise rejects, propagates through `dispatchInternal` at `main.ts:14`, and the process exits non-zero with a stack trace — git then treats the whole helper chain as fatal instead of "no credential". Wrap the body in a try/catch that returns 0 (silence) on any unexpected failure. Rare, but it is the one hole in an otherwise total "always exit 0" guarantee. *(Two-line change; reasonable to fix before merge.)*
2. **`finishPlan`'s acquire has no cancel probe** — `apps/runner/src/executor/host-executor.ts:157`. `acquire(job, { wait: true })` passes no `isCancelled` (prepare at line 69 does). A `requestCancel` racing a PLAN job whose token is unavailable waits out the full `tokenWaitMs` (120 s) and the job then ends FAILED (`git token: …`) rather than CANCELLED. Halt/stop is already covered (`closeAll` sets `closing`); only user-cancel is not. Pass an `isCancelled` probe from the run, or accept and document the edge. *(Carry into 3b-2, which touches this seam.)*
3. **Raw `ENOTDIR` instead of `SocketDirError`** — `apps/runner/src/credentials/socket-dir.ts:38`. When a parent path component is a plain file, `mkdir`'s ENOTDIR is swallowed and `lstat` then rejects with a raw `ENOTDIR`; the daemon still refuses to start, but with a less actionable message. Wrap the `lstat` failure.
4. **The 64-byte request guard measures UTF-16 code units, not bytes** — `apps/runner/src/credentials/cred-server.ts:29`. A multibyte client over 64 bytes but under 64 chars without a newline would not get the immediate `bad request`. No legitimate client does this; noted only because D79 words it as "bytes".
5. **Broker/TokenCache run on raw `Date.now()`** — `apps/runner/src/daemon/daemon.ts:107,133`, while the rest of the daemon uses the injectable `now` clock. Tests compensate with short injected timings; a single injectable clock would keep the repo's testability convention uniform. (Deliberate per the plan — token expiry is server wall clock — so this is convention, not defect.)
6. **`pathWithout` cannot strip a different symlink alias of the shim dir** — `apps/runner/src/credentials/shim.ts:22-25`. If such an alias preceded the real `gh` on PATH, `Bun.which` could find the shim again and re-exec itself. Contrived (the daemon controls nax's PATH); a cheap hardening is to also drop entries whose `realpath` equals the binDir's.
7. **Operator-set token variables reach nax's environment** — `apps/runner/src/executor/host-executor.ts:110`. nax's env is `{ ...process.env, ... }`, so an operator-set `GH_TOKEN`/`GITLAB_TOKEN` in the daemon's own environment reaches nax and every gh child. This is pre-existing env inheritance, not a brokered-token leak (D88 only forbids *setting* a token), but since 3b-1's whole point is "the runner holds no git credentials", scrubbing token-shaped variables from nax's env would make the invariant self-contained. *(Fold into 3b-2.)*

---

## Verification evidence

| Gate | Result |
|:--|:--|
| `cd apps/runner && bun run type-check` | clean |
| `cd apps/runner && bun run lint` | clean |
| `cd apps/runner && bun run test` | **762 pass, 0 fail** (53 files, 1,699 expectations; baseline at `19ac4fc7` was 662) |
| `KODA_DB_TESTS=1 bun run test:integration` (Postgres up, API built) | **17 pass, 0 fail** (4 files, 40.7 s), incl. the new credentials spec (RUN/PLAN through helper and shims, forge-refused token → `git token: app_permissions_insufficient` before any clone, crash→readopt→re-served socket→successful push) and the D94 recovery scenario |

Everything else was inspected by reading: all 59 changed files, token paths traced end to end, D-decisions checked one by one, file/function size limits, no `console.log` outside allowed files, no non-null assertions, no `any`, no `eslint-disable`, immutable-style Map handling in `TokenCache`/`CredentialBroker` all verified. Nothing was mutated in the working tree.

## Deviations from the plan

None found. All of D78–D94 are implemented as decided (including the two pre-implementation plan amendments in `e6c7b9d4`: staged socket rename, shared shims kept while a sibling epoch lives, stop ordering). All tasks 0–12 are present. Code-vs-sketch differences are only the sanctioned kind (e.g. the `no-credentials.ts` helper for `file://` HostExecutor specs, which D83 implies). D83's early return in `acquire` correctly happens before `tokens.want()`, so a `file:` URL neither requests a token nor creates a socket.

## Declined to judge (out of scope, for the executor's record)

- Token scope for same-host submodule/other-repo use — the helper answers per protocol+host exactly as D80 fixes; whether the minted token is repo-scoped is a server-side property outside this branch.
- Server-side minting/reuse logic (`sync.service.ts`, `git-token.broker.ts`) — the plan explicitly requires no server change; already on main.
- Linux `SO_PEERCRED` peer-uid checks on socket connections — D78's mechanism is mode+ownership; peercred is hardening beyond the spec.
- 3b-2 scope items (capability probe, install-service, AppArmor, merge gate, live check) — explicitly deferred by the plan's numbering note.
- Bun's stdout-flush-on-`process.exit` semantics for the helper — platform behavior, empirically covered by the real-git credential tests passing.
- Insertion-order bias of the 64-request cap slice — self-balancing via cool-downs and releases; no realistic starvation.

## Recommendations

- Fix Minor 1 (helper try/catch) before merge if convenient — two lines, completes D80's "always exits 0".
- Carry Minor 2 (finishPlan cancel probe) and Minor 7 (env scrub) into the 3b-2 plan; both touch seams 3b-2 will modify anyway.
- Minors 3–6 are ride-alongs for a later hygiene pass; none is urgent.
- The `git http-backend` test helper (`test/helpers/git-http.ts`) is reusable infrastructure — the runner context's test section already points at it; nothing more to do unless another app needs authenticated git fixtures.

## Assessment

**Ready to merge?** Yes.

**Reasoning:** The security invariant holds on every path that could be traced and is enforced by real-behavior tests at each boundary; all plan decisions, lifecycle fixes (including the halt-during-prepare fix), and the five Review Focus modes are implemented and verified, with clean type-check/lint and 779 passing tests across unit and integration. The remaining findings are hardening polish, none of which blocks merge.
