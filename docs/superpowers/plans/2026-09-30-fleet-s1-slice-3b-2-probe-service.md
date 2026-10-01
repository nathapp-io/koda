# Fleet S1 Slice 3b-2 — Capability Probe, Service Install, Merge Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Numbering.** This is plan 3b-2, the second half of slice 3b (user ruling 2026-09-30: split 3b into 3b-1 and 3b-2, one plan per PR). 3b-1, the git credential broker, is merged (#174). 3b-2 is `NaxCapabilityProbe` (design §3.2), the post-checkout capability check, `install-service`/`uninstall-service` with the AppArmor check (§3.3), the 3b merge gate (§4), the live check (§4, run by a human with approval at launch), and the three minors the 3b-1 final review deferred. Decision numbers continue the fleet S1 register: D1-D20 (slice 2 plans), D21-D59 (3a-1), D60-D74 (3a-2), D75-D77 (`2026-09-30-fleet-s1-slice-3a-deviations.md`), D78-D94 (3b-1). This plan adds **D95-D109**; the whole-branch review added **D110-D113** (below).

**Prerequisite:** 3b-1 is merged (`main` at `29b020eb`, #174). This plan is the only commit on branch `feat/fleet-s1-slice3b-2-probe-service`, cut from that `main`. No server change is needed: the server already validates the capability report (`apps/api/src/fleet/common/capabilities.ts`), places on it (`apps/api/src/fleet/jobs/placement-rules.ts`), and stores `stateReason` up to 500 characters (`apps/api/src/fleet/sync/event-payloads.ts:60`). nax 0.83.1 (released 2026-09-30) is installed on this machine; its JSON contracts are nax `docs/specs/SPEC-cli-json-output.md`, `SPEC-sandbox-probe-json.md` and `SPEC-project-trust-gate.md`.

**Goal:** A runner that reports what its machine can really do by asking nax, refuses a job its machine cannot run before spawning it, runs as a system service on macOS and Linux, and is proven against the released nax.

**Architecture:** A `NaxCli` seam runs nax's read-only JSON commands (`--version`, `config --profile --json`, `auth list --json`, `sandbox probe --json`, `trust check --json`) with a timeout and the job environment rules. Pure mappers turn nax's documents into the protocol's `RunnerCapabilities`. `NaxCapabilityProbe` implements the existing `CapabilityProbe` seam; the daemon probes at start (fatal when nax is missing or too old), every 10 minutes and on SIGHUP, and sends the report when its hash changes. A `JobCheck` runs in `HostExecutor.prepare` after checkout: nax trust, then the job's full profile chain resolved in the clone, compared with the machine's report. `install-service` renders a systemd unit or a launchd plist, checks the service user, workspace trust and, on Linux 24.04+, the AppArmor user-namespace restriction.

**Tech Stack:** Bun 1.4.2 (`Bun.spawn` with `timeout`, `Bun.which`, `bun test`), TypeScript strict ESM, commander 12, nax 0.83.1 JSON commands, systemd, launchd, AppArmor 4 (`apparmor_parser`), `@nathapp/fleet-protocol` (`RunnerCapabilities`, `ProfileNeeds`, `RunnerCredential`).

**Specs:** `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md` ("slice 3 design"; this plan is its §3.2, §3.3 and the 3b lines of §4) and `docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` ("S1 spec": §2.1 capability report and post-checkout check, §4 placement). Precedent plans: `docs/superpowers/plans/2026-09-30-fleet-s1-slice-3b-1-git-credentials.md` (format, register), `...-slice-3a-2-runner-execution.md`.

## Global Constraints

From the specs, the repo rules (`.nax/context.md`, `.nax/mono/apps/runner/context.md`) and slices 3a and 3b-1; every task includes them.

- **nax floor:** nax **0.83.1** or newer (JSON commands, `sandbox probe --json`, `trust`). The daemon and `enroll` refuse an older or missing nax when they probe (D97).
- **Protocol limits** (server validator `apps/api/src/fleet/common/capabilities.ts`): at most 64 profiles, names `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, at most 16 providers per profile, at most 64 credentials, strings 1-200 characters, `credentials[]` keys exactly `providerId, available, stored, exec?, ambient`, `stored` keys exactly `kind, expires?, expired`. A report that breaks one rule is rejected whole (400), which disables placement, so the runner must never send one.
- **The runner never re-derives nax's rules** (S1 spec §2.1 ruling 09-30): which providers a chain needs, whether a credential is usable, whether the sandbox works: nax answers, the runner maps.
- **nax's environment:** every nax call has `NAX_GLOBAL_CONFIG_DIR=<naxHome>` and none of `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN` (3b-1 D88), stdin closed, and a 30 s timeout (SIGKILL).
- **Job profiles are not machine profiles:** `koda-job-*` files in `<naxHome>/profiles` are never reported (design §3.2).
- **Legal transitions only** and **persist before send** (3a) are unchanged: a failed job check is `ASSIGNED -> FAILED` with a `stateReason`.
- **Service units:** systemd `User=`, `KillMode=process`, `Restart=always`; launchd `UserName`, `AbandonProcessGroup=true`, `KeepAlive` (design §3.3). OS users are created by the operator, never by the runner.
- **Repo conventions.** Conventional commits, no attribution trailer, never push (a human pushes), no emojis, no `console.log` outside `src/main.ts` and `src/logger.ts`, no non-null assertions, no `any`, no `eslint-disable`. Immutable style: build new objects, never mutate arguments. Files under 400 lines typical, 800 max; functions under 50 lines.
- **Tests.** Unit specs `src/**/*.spec.ts`; specs that spawn real processes or real git live in `test/unit/`; integration specs `test/integration/*.integration.spec.ts`, gated by `describe.skipIf(process.env['KODA_DB_TESTS'] !== '1')`; live specs `test/live/*.live.spec.ts`, gated by `KODA_NAX_LIVE=1`, never in CI. Unit tests never depend on which tools this machine has installed (`gh`, `acpx`, `bwrap`): inject them. No hardcoded absolute machine paths in tests.
- **All ten CI checks are required on `main`**; no new required check.

Plan-level rules:

- Branch `feat/fleet-s1-slice3b-2-probe-service` is checked out in the main checkout (`repos/koda`). Never run `git checkout`, `git switch`, `git stash`, `git reset` or `git rebase` here; commit on the current branch only.
- Runner specs: `cd apps/runner && bun test <path>`; all unit specs: `bun run test`; types: `bun run type-check`; lint: `bun run lint`. Integration: `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration` (needs the test Postgres, `cd apps/api && bun run test:db:up`, and the built API, `bunx turbo run build --filter=@nathapp/koda-api`).
- Do not run `nax run` or `nax plan` (billed). The read-only nax commands this plan calls (`--version`, `config --json`, `auth list --json`, `sandbox probe --json`, `trust check --json`) and `nax generate` are local and free. Never run `nax trust add` against your real `~/.nax`; tests use a temp nax home.
- Never run `install-service` or `uninstall-service` for real (they write `/etc` and `/Library` as root); tests inject every effect. The live check (Task 14) is run by a human.

## Plan decisions beyond the spec

New rows D95-D109, each needed by a task below.

| # | Decision | Why |
|:--|:--|:--|
| D95 | runner.json `capabilities` becomes optional. Present: `StaticCapabilityProbe`, as in 3a, and the daemon logs once that nax is not probed. Absent (the default from now on): `NaxCapabilityProbe`. `enroll` no longer writes a capabilities block; it probes the same way (`createCapabilityProbe`) and sends the probed report. `defaultCapabilities` and `EnrollDeps.which` go. | Design §3.2 replaces the hand-written block. Keeping the block as an explicit override keeps every 3a/3b-1 unit test and gives an operator an escape hatch on a machine where the probe misbehaves. |
| D96 | `NaxCli.run(args, {cwd})` spawns `[...naxCommand, ...args]` with the Global Constraints environment and a 30 s timeout (`naxCallTimeoutMs`), and returns `{code, stdout, stderr, timedOut}`; a missing executable is `code 127`. `parseNaxJson` reads stdout whatever the exit code (`sandbox probe` and `trust check` exit 1 with a valid document): a timeout is `NAX_TIMEOUT`, no output from a missing binary is `NAX_NOT_FOUND`, anything that is not one JSON object is `NAX_OUTPUT_UNPARSEABLE`, nax's `{"error":{"code"}}` document is its code when it matches `^[A-Z0-9_]{1,64}$`, else `NAX_ERROR`. `withoutCredentialVars` moves to `src/credentials/credential-env.ts` (host-executor re-exports it). | One place for how the runner talks to nax. The code vocabulary is bounded because it reaches `stateReason` and logs. |
| D97 | nax floor 0.83.1: `readNaxVersion` parses the first line of `nax --version` as `^v?(\d+)\.(\d+)\.(\d+)` (a pre-release such as `0.84.0-canary.1` counts as 0.84.0) and throws `NaxUnavailableError` when nax does not answer or is older. The version string sent is that first line, at most 64 characters. `NaxUnavailableError` and `WorkspaceUntrustedError` extend a new `StartupError`; `runCommand` logs its message plainly and exits 1. | 0.83.1 is the first release with all five commands the runner calls. Refusing to start is visible; a runner that reports "no profiles" would be placed and fail every job. |
| D98 | Machine profiles: the regular files and links `<naxHome>/profiles/*.json`, minus `koda-job-*`; a name that breaks the protocol name rule is skipped; the rest sorted by code unit and the first 64 kept. Each is resolved with `nax config -d <empty dir> --profile <name> --json`, cwd the same empty temp dir (`mkdtemp`, removed after the probe), four at a time. `ProfileNeeds = {protocol: requirements.transport, providers: requirements.providers (deduplicated, sorted), sandbox: requirements.sandbox}`. A profile whose resolution fails, whose document has not that shape, or that needs more than 16 providers is skipped. Every skip is a warning. | This machine has 67 profiles and one (`otel`) that fails without an environment variable: one bad profile must never reject the whole report. Sorting makes the kept 64 stable between probes. |
| D99 | Credentials: `nax auth list --json <union of the kept profiles' providers>`. Each row maps to `RunnerCredential`: `exec` becomes the status string (`account` and `code` dropped, design out-of-scope "account labels"); a malformed row is skipped with a warning. Order: the union's providers first (sorted; one nax did not list becomes `{available: false, stored: null, ambient: false}`), then every other listed provider sorted; at most 64. When the listing itself fails, every union provider is reported unavailable, with a warning. | Placement reads `provider_missing` as permanent (a pinned dispatch 422s) and `provider_unavailable` as "queue": a transient listing failure must look like the second. |
| D100 | Sandbox: `nax sandbox probe --json` -> `{available}` or `{available: false, error: reason}` (reason at most 200 characters, `unavailable` when empty). A failed call is `{available: false, error: 'nax sandbox probe failed: <code>'}`. The error stays in the capability hash (closes the 3a ENH-5 note): nax's reasons are deterministic, so a changed reason is a real change. | Design §3.2 and R-3.6: the runner never re-implements the probe. |
| D101 | `nax.protocols` is `['native']`, plus `'acp'` when `acpx --version` exits 0. `tools` is `git`, `gh`, `glab` by `--version` exit 0. Each tool call: `Bun.which` first, 10 s timeout, the credential-free environment. The probe takes these as an injected `toolWorks(command)`. | Design §3.2. Injection keeps unit tests independent of what this machine has installed. |
| D102 | Probe schedule: once at daemon start (a throw, meaning nax missing or too old, stops the start after closing the journal), every `capabilityProbeMs` (600 s), and on SIGHUP (`systemctl reload`, `launchctl kill HUP`). A later probe that throws keeps the last report and logs a warning. Refreshes are serialised; a request while one runs queues exactly one more. A refresh that changes the hash wakes the sync loop. Warnings are logged only when the set differs from the previous probe's. | A 10-minute probe that logged the same 3 skipped profiles every time would bury the log. |
| D103 | Trust (nax #2293): `nax run` and `nax plan` exit 2 in a folder nax does not trust, before writing `status.json`. The operator trusts `workspaceRoot` once (it covers every clone beneath it): `install-service --trust-workspace` runs `nax trust add <workspaceRoot> --yes` as the service user, or the operator runs it by hand. The daemon (nax mode) refuses to start while `nax trust check --json <workspaceRoot>` says untrusted, and prints the exact command. The job check re-checks the clone (`project untrusted`). The runner never trusts a folder on its own. | Trust is the operator's decision about running repository code on their machine. Without the check every job would end in a verdict-less crash (`status.json` never appears). |
| D104 | Job check (post-checkout, S1 spec §2.1, design §3.2), in `HostExecutor.prepare` right after a successful checkout, before the job profile is written, in nax mode only. Order and reasons: trust (`project untrusted`, or `trust check failed: <code>`); `nax config -d <clone> [--profile <assign.profiles joined by ,>] --json` (`capability mismatch: profile resolve failed (<code>)`); then, against the last probe report, in placement's order: `capability mismatch: protocol <transport>`, per needed provider from a fresh `nax auth list --json <providers>` (skipped when none) `capability mismatch: provider <id> missing` / `... unavailable` (or `capability mismatch: auth list failed (<code>)`), then `capability mismatch: sandbox`. The chain excludes the job's own `koda-job-*` overlay, which only sets `outputDir` and `name`. | The machine report cannot know repo-provided profiles or the repo's own `.nax/config.json`; nax resolving the real chain in the real clone can. A fresh auth listing catches a credential that expired since the last probe. |
| D105 | Service units. systemd `/etc/systemd/system/koda-runner.service`: `User`, `WorkingDirectory=<runnerHome>`, `Environment=HOME=` and `PATH=`, `ExecStart=<self> --home <runnerHome> run`, `ExecReload=/bin/kill -HUP $MAINPID`, `KillMode=process`, `Restart=always`, `RestartSec=5`, `RestartPreventExitStatus=2`. launchd `/Library/LaunchDaemons/dev.koda.runner.plist`: `UserName`, `ProgramArguments`, `WorkingDirectory`, `EnvironmentVariables` (HOME, PATH), `RunAtLoad`, `KeepAlive`, `ThrottleInterval 10`, `AbandonProcessGroup`, stdout and stderr to `<runnerHome>/runner.log`. Every path must match `^/[A-Za-z0-9._/+-]*$` without `..`, PATH entries likewise, the user `^[a-z_][a-z0-9_-]{0,31}$`; anything else is refused, never escaped. `install-service` needs root (except `--print`), an existing user (`getent passwd` / `dscl`), `--home` naming an enrolled runner home owned by that user, nax on the service PATH, a trusted workspace (D103), no existing unit; then writes the unit (0644) and runs `systemctl daemon-reload` + `systemctl enable --now koda-runner.service`, or `launchctl bootstrap system <plist>`. `uninstall-service` reverses it (`systemctl disable --now` + remove + `daemon-reload`, or `launchctl bootout system/dev.koda.runner` + remove) and removes the AppArmor profile it wrote. | Exit 2 means the server refused the runner (401/426); restarting cannot fix that. Refusing unusual characters is simpler and safer than quoting for two unit formats. |
| D106 | AppArmor (Linux): when `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` is `1`, `install-service` warns that the nax sandbox cannot start; with `--apply-apparmor` it writes `/etc/apparmor.d/koda-runner-bwrap` (`profile koda-runner-bwrap <bwrap realpath> flags=(unconfined) { userns, include if exists <local/koda-runner-bwrap> }`) and loads it with `apparmor_parser -r`. It refuses when `bwrap` is not on the service PATH or another profile in `/etc/apparmor.d` already attaches to that path. | The Ubuntu 24.04 restriction blocks bwrap (fleet doc §9 R9 finding). The profile is the targeted form Ubuntu documents for applications that need user namespaces; a second profile on the same path would fail to load. Verified on a real 24.04 host in the live check. |
| D107 | Merge gate: `test/live/nax-probe.live.spec.ts` (`KODA_NAX_LIVE=1`, script `test:live`) probes the installed nax with the real nax home, asserts the version floor, feeds the report to the server's own `parseCapabilities` (dynamic import of `apps/api/src/fleet/common/capabilities.ts`), and runs `trust check` on a temp dir. It runs here before the PR and on each live-check machine. | Design §4 "3b merge gate: the probe runs once against released nax". Using the server's validator proves the real report is accepted, not just shaped as the runner believes. |
| D108 | The fake nax answers the probe commands from files in its nax home (`profiles/<name>.json` `fakeRequirements` or `fakeError`; `<dir>/.nax/fake-profiles/<name>.json` for repo-provided profiles; `fake-auth.json`; `fake-sandbox.json`; a `fake-untrusted` marker), and `--version` prints `FAKE_NAX_VERSION` or `0.83.1-fake`. The logic lives in `test/fixtures/fake-nax-probe.ts`. | State in the nax home keeps two in-process runners apart (the harness shares one process environment). |
| D109 | 3b-1 deferred minors: the broker re-checks the socket directory before every listen (`git credentials: socket dir unsafe` when it fails); tests pin the shim's `job ended` warning and the helper's silence on `reply too large`. | The final 3b-1 review: the directory was only checked at daemon start. |

### Post-review fixes (whole-branch review of 3b-2)

The whole-branch review of `feat/fleet-s1-slice3b-2-probe-service` (0 critical, 0 high, 8 medium, 7 low) produced these. Each changes code this plan specified, so each is recorded rather than made silently.

| # | Decision | Why |
|:--|:--|:--|
| D110 | Every command `install-service`/`uninstall-service` runs is bounded: `ServiceDeps.exec` takes an optional `timeoutMs`, the nax trust calls pass `NAX_CALL_TIMEOUT_MS`, everything else gets `SERVICE_EXEC_TIMEOUT_MS` (120 s) and SIGKILL. A timeout is reported (`timed out after N ms`), and a failed trust check names nax's own stderr and exit code alongside the code. | The plan's Global Constraints say *every* nax call carries a 30 s timeout; its own `system-deps.ts` code carried none, so a wedged nax hung a root shell silently — and the unit is written before `systemctl enable`, so a hang there also blocked a plain retry. |
| D111 | The post-checkout job check runs `trust check` and the chain resolve concurrently and carries `tuning.jobCheckTimeoutMs` (10 s), not the probe's 30 s. `NaxCallOptions` grows an optional `timeoutMs`; `checkTrust` takes one. | The check runs inside the per-repo mutex, so three sequential 30 s calls held up every other job on that repo for up to 90 s. |
| D112 | Absence and unreadability are different answers. `listProfileNames` returns `{names, warning}` and swallows only `ENOENT`/`ENOTDIR`; `ServiceDeps` gains `readFileStrict`, and `listDir` now throws (the caller decides). An unreadable profiles directory, `/etc/apparmor.d` or a profile in it is a warning or a refusal, never "none found". `uninstall-service` removes the unit or plist only when it carries this plan's marker. | `readFile`/`listDir` collapsed EACCES into "nothing is there": a runner with an unreadable nax home reported no needs and was placed every job, and the AppArmor conflict scan silently scanned nothing, so the documented refusal did not hold. `install-service` refuses to overwrite a unit, so `uninstall-service` must not delete one it did not write. |
| D113 | `listProfileNames` returns `{names, warning}`, `NaxCapabilityProbe` bounds the whole report to `MAX_REPORT_BYTES` (65,536), `NaxCli` bounds each read (`MAX_NAX_OUTPUT_BYTES`, `NAX_OUTPUT_TOO_LARGE`) and separates a spawn failure from a missing binary (`spawnFailure`: only `ENOENT` is `NAX_NOT_FOUND`, the rest are `NAX_SPAWN_FAILED`), and the job check reports an unlisted provider `unavailable`, never `missing`. | The server rejects a report over 64 KiB **whole**, which disables placement for that runner, and the per-item limits alone do not bound the document. `provider_missing` is in `PERMANENT_MISFITS` and `provider_unavailable` is not, so the two words are not interchangeable. A present-but-wrong binary must not be reported as an absent one. |

## Review Focus

The inputs and failure modes the specs imply but a happy-path test would never meet, most likely first. Each has a test in the task that owns the code.

1. **More machine profiles than the protocol carries, or a profile that fails to resolve** (this machine: 67 profiles; `otel` needs an unset variable). Expected: the report carries the first 64 valid ones, the failing one is skipped with a warning, and the server accepts the report. Tests in Task 3 (68 profiles, a failing profile) and Task 13 (the live gate against this machine's 67 profiles).
2. **nax hangs or is slow** (an exec credential helper, a stuck sandbox probe). Expected: that call is killed after 30 s and reported as a failure; the probe still completes and the daemon keeps running. Tests in Task 1 (timeout) and Task 3 (a failing call inside a probe).
3. **nax upgraded or removed while the daemon runs.** Expected: the periodic probe fails, the last report stays, one warning is logged, and jobs keep running. Test in Task 6.
4. **Workspace trust missing** (trust.json lost, a new workspace root). Expected: the daemon refuses to start with the exact `nax trust add` command; a clone that is untrusted later fails its job with `project untrusted` before nax spawns, never as a verdict-less crash. Tests in Task 6 and Task 7.
5. **Operator input with spaces, quotes or `..` in `install-service`** (`--home`, `--binary`, `--path`, `--user`). Expected: refused with a message, nothing written. Tests in Task 9 and Task 11.

## File Structure

```
apps/runner/src/
  errors.ts                   (modified) StartupError                                              Task 1
  credentials/credential-env.ts  withoutCredentialVars (moved from host-executor)                   Task 1
  nax/nax-cli.ts              NaxCli, createNaxCli, parseNaxJson, readNaxVersion, NaxUnavailableError Task 1
  capabilities/nax-json.ts    parseRequirements, parseAuthList, parseSandboxProbe, parseTrustCheck  Task 2
  capabilities/map-limit.ts   mapLimit                                                              Task 3
  capabilities/nax-probe.ts   NaxCapabilityProbe, toolWorks, makeEmptyDir                           Task 3
  capabilities/capability-probe.ts (modified) ProbeResult, CapabilityReporter.refresh/latest        Task 3
  capabilities/create-probe.ts createCapabilityProbe                                                 Task 5
  config/runner-config.ts     (modified) capabilities optional                                      Task 5
  commands/enroll.ts          (modified) probes nax                                                 Task 5
  nax/trust.ts                checkTrust, assertWorkspaceTrusted, WorkspaceUntrustedError           Task 6
  daemon/daemon.ts            (modified) nax mode, start checks, periodic probe, reprobe            Task 6
  daemon/tuning.ts            (modified) capabilityProbeMs, naxCallTimeoutMs                        Task 6
  commands/run.ts             (modified) SIGHUP, StartupError                                       Task 6
  capabilities/job-check.ts   JobCheck, NaxJobCheck, firstMismatch, NO_JOB_CHECK                     Task 7
  executor/host-executor.ts   (modified) job check after checkout                                   Task 7
  credentials/broker.ts       (modified) socket dir re-check                                        Task 8
  service/units.ts            ServiceSpec, validateSpec, systemdUnit, launchdPlist                  Task 9
  service/apparmor.ts         restriction check, profile text, conflicts                            Task 10
  commands/service.ts         installService, uninstallService                                      Task 11
  main.ts                     (modified) enroll probe, install-service, uninstall-service           Tasks 5, 11
apps/runner/test/
  helpers/fake-nax-cli.ts     FakeNaxCli, naxAnswers                                                Task 3
  fixtures/fake-nax-probe.ts  answerProbe (D108)                                                    Task 4
  fixtures/fake-nax.ts        (modified) --version, probe commands                                  Task 4
  unit/nax-cli.spec.ts        real spawn: env, timeout, missing binary                             Task 1
  unit/fake-nax-probe.spec.ts                                                                       Task 4
  unit/daemon.spec.ts         (modified) nax-mode start, refusals, reprobe                          Task 6
  unit/job-check.spec.ts      NaxJobCheck + HostExecutor over the fake nax and real git             Task 7
  integration/harness/world.ts (modified) nax-probed runners, dispatch profiles                     Task 12
  integration/capabilities.integration.spec.ts                                                      Task 12
  live/nax-probe.live.spec.ts the merge gate (D107)                                                 Task 13
docs/deployment/runner.md     operator guide: user, enroll, trust, service, AppArmor, live check    Task 13
```

---

### Task 0: Verify the starting point

**Files:** none (read only).

- [ ] **Step 1: Confirm the branch and base**

Run: `cd repos/koda && git branch --show-current && git log --oneline -2`
Expected: `feat/fleet-s1-slice3b-2-probe-service`; the top commit is this plan, and the one below it is `29b020eb feat(fleet): S1 slice 3b-1 — runner git credential broker (#174)`.

- [ ] **Step 2: Confirm the tools**

Run: `bun --version && git --version && nax --version`
Expected: Bun `1.4.2`, git 2.30 or newer, nax `0.83.1` or newer. If nax is older, stop: the merge gate (Task 13) needs the released nax.

- [ ] **Step 3: Baseline**

Run: `cd apps/runner && bun run type-check && bun run lint && bun run test`
Expected: clean type-check and lint; `771 pass, 0 fail` (the count at `29b020eb`).

- [ ] **Step 4: Read the design text this plan implements**

Read `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md` §3.2, §3.3 and §4, S1 spec §2.1, and the nax contracts: `projects/nax/repos/nax/docs/specs/SPEC-cli-json-output.md` ("Output format" sections), `SPEC-sandbox-probe-json.md`, `SPEC-project-trust-gate.md` ("gated commands", "`nax trust`"). No commit.

---
### Task 1: `NaxCli`, the nax version floor, `StartupError`

**Files:**
- Modify: `apps/runner/src/errors.ts` (add `StartupError`)
- Create: `apps/runner/src/credentials/credential-env.ts`
- Modify: `apps/runner/src/executor/host-executor.ts:38-46` (move `CREDENTIAL_ENV_VARS` and `withoutCredentialVars` out)
- Create: `apps/runner/src/nax/nax-cli.ts`
- Test: `apps/runner/src/nax/nax-cli.spec.ts` (pure), `apps/runner/test/unit/nax-cli.spec.ts` (real processes)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `class StartupError extends Error` (`src/errors.ts`)
  - `withoutCredentialVars(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>>` (`src/credentials/credential-env.ts`; still re-exported by `src/executor/host-executor.ts`)
  - `interface NaxResult { code: number; stdout: string; stderr: string; timedOut: boolean }`
  - `interface NaxCallOptions { cwd: string }`
  - `interface NaxCli { run(args: readonly string[], options: NaxCallOptions): Promise<NaxResult> }`
  - `NAX_CALL_TIMEOUT_MS = 30_000`
  - `createNaxCli(naxCommand: readonly string[], naxHome: string, timeoutMs?: number): NaxCli`
  - `type NaxJson = { ok: true; value: Readonly<Record<string, unknown>> } | { ok: false; code: string }`
  - `parseNaxJson(result: NaxResult): NaxJson`
  - `MIN_NAX_VERSION: readonly [0, 83, 1]`, `parseNaxVersion(text: string): [number, number, number] | null`, `versionAtLeast(v, min): boolean`
  - `class NaxUnavailableError extends StartupError`
  - `readNaxVersion(nax: NaxCli, cwd: string): Promise<string>`

- [ ] **Step 1: Write the failing pure tests**

Create `apps/runner/src/nax/nax-cli.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { StartupError } from '../errors';
import { MIN_NAX_VERSION, NaxUnavailableError, parseNaxJson, parseNaxVersion, readNaxVersion, versionAtLeast, type NaxCli, type NaxResult } from './nax-cli';

const result = (over: Partial<NaxResult> = {}): NaxResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });
const answering = (r: NaxResult): NaxCli => ({ run: async () => r });

describe('parseNaxJson (D96)', () => {
  test('one JSON object is the value, whatever the exit code (sandbox probe and trust check exit 1 with a document)', () => {
    expect(parseNaxJson(result({ code: 1, stdout: '{"available":false,"reason":"x"}' }))).toEqual({ ok: true, value: { available: false, reason: 'x' } });
  });
  test("nax's error document is its code", () => {
    expect(parseNaxJson(result({ code: 1, stdout: '{"error":{"code":"PROFILE_NOT_FOUND","message":"m"}}' }))).toEqual({ ok: false, code: 'PROFILE_NOT_FOUND' });
  });
  test('an error code outside the vocabulary is NAX_ERROR (codes reach stateReason and logs)', () => {
    expect(parseNaxJson(result({ code: 1, stdout: '{"error":{"code":"bad code; rm -rf"}}' }))).toEqual({ ok: false, code: 'NAX_ERROR' });
    expect(parseNaxJson(result({ code: 1, stdout: '{"error":{}}' }))).toEqual({ ok: false, code: 'NAX_ERROR' });
  });
  test.each([['text', 'Profile not found'], ['an array', '[1]'], ['null', 'null'], ['empty output', '']])('%s is NAX_OUTPUT_UNPARSEABLE', (_what, stdout) => {
    expect(parseNaxJson(result({ stdout }))).toEqual({ ok: false, code: 'NAX_OUTPUT_UNPARSEABLE' });
  });
  test('a timeout wins over any output; a missing binary is NAX_NOT_FOUND', () => {
    expect(parseNaxJson(result({ timedOut: true, stdout: '{}' }))).toEqual({ ok: false, code: 'NAX_TIMEOUT' });
    expect(parseNaxJson(result({ code: 127 }))).toEqual({ ok: false, code: 'NAX_NOT_FOUND' });
  });
});

describe('nax version floor (D97)', () => {
  test.each([
    ['0.83.1', [0, 83, 1]], ['v1.2.3', [1, 2, 3]], ['0.84.0-canary.1', [0, 84, 0]], [' 0.83.1\n', [0, 83, 1]], ['nax 0.83.1', null], ['0.83', null],
  ])('parseNaxVersion(%j)', (text, expected) => {
    expect(parseNaxVersion(text as string)).toEqual(expected as [number, number, number] | null);
  });
  test('versionAtLeast compares part by part, numerically', () => {
    expect(versionAtLeast([0, 83, 1], MIN_NAX_VERSION)).toBe(true);
    expect(versionAtLeast([0, 84, 0], MIN_NAX_VERSION)).toBe(true);
    expect(versionAtLeast([1, 0, 0], MIN_NAX_VERSION)).toBe(true);
    expect(versionAtLeast([0, 83, 0], MIN_NAX_VERSION)).toBe(false);
    expect(versionAtLeast([0, 9, 99], MIN_NAX_VERSION)).toBe(false);
  });
  test('readNaxVersion returns the first line nax printed', async () => {
    expect(await readNaxVersion(answering(result({ stdout: '0.84.0-canary.1\nextra\n' })), '/')).toBe('0.84.0-canary.1');
  });
  test('an older, a missing and a hanging nax are NaxUnavailableError (a StartupError) naming the floor', async () => {
    await expect(readNaxVersion(answering(result({ stdout: '0.83.0\n' })), '/')).rejects.toThrow(/needs nax 0\.83\.1 or newer \(found 0\.83\.0\)/);
    await expect(readNaxVersion(answering(result({ code: 127 })), '/')).rejects.toBeInstanceOf(NaxUnavailableError);
    await expect(readNaxVersion(answering(result({ code: 127 })), '/')).rejects.toBeInstanceOf(StartupError);
    await expect(readNaxVersion(answering(result({ timedOut: true, stdout: '0.90.0' })), '/')).rejects.toThrow(/timed out/);
  });
});
```

- [ ] **Step 2: Write the failing process tests**

Create `apps/runner/test/unit/nax-cli.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNaxCli, parseNaxJson } from '../../src/nax/nax-cli';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const TOKEN_VARS = ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN'];
/** A stand-in nax that prints its argv, cwd and the variables the runner controls as one JSON object. */
const ECHO = `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.NAX_GLOBAL_CONFIG_DIR ?? null, tokens: ${JSON.stringify(TOKEN_VARS)}.filter((k) => process.env[k] !== undefined) }));`;

async function script(body: string): Promise<string> {
  const path = join(await tmp.make('naxcli'), 'nax.ts');
  await writeFile(path, body);
  return path;
}

describe('createNaxCli (D96)', () => {
  test('runs naxCommand plus args in cwd, with NAX_GLOBAL_CONFIG_DIR and without any forge token variable', async () => {
    const path = await script(ECHO);
    const cwd = await tmp.make('cwd');
    const saved = process.env['GH_TOKEN'];
    process.env['GH_TOKEN'] = 'ghs_leak';
    try {
      const parsed = parseNaxJson(await createNaxCli(['bun', path], '/opt/naxhome').run(['config', '--json'], { cwd }));
      if (!parsed.ok) throw new Error(`unexpected ${parsed.code}`);
      expect(parsed.value).toMatchObject({ argv: ['config', '--json'], home: '/opt/naxhome', tokens: [] });
      expect(await realpath(parsed.value['cwd'] as string)).toBe(await realpath(cwd));
    } finally {
      if (saved === undefined) delete process.env['GH_TOKEN'];
      else process.env['GH_TOKEN'] = saved;
    }
  });
  test('Review focus 2: a nax that hangs is killed at the timeout and reported as NAX_TIMEOUT', async () => {
    const path = await script('setInterval(() => undefined, 1000);');
    const started = Date.now();
    const result = await createNaxCli(['bun', path], '/tmp', 300).run(['auth', 'list', '--json'], { cwd: await tmp.make('cwd') });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(parseNaxJson(result)).toEqual({ ok: false, code: 'NAX_TIMEOUT' });
  });
  test('a naxCommand that does not exist is exit 127 and NAX_NOT_FOUND, not a throw', async () => {
    const result = await createNaxCli(['/nonexistent/nax-binary'], '/tmp').run(['--version'], { cwd: await tmp.make('cwd') });
    expect(result.code).toBe(127);
    expect(parseNaxJson(result)).toEqual({ ok: false, code: 'NAX_NOT_FOUND' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/nax/nax-cli.spec.ts test/unit/nax-cli.spec.ts`
Expected: FAIL, `Cannot find module './nax-cli'`.

- [ ] **Step 4: Add `StartupError`**

Append to `apps/runner/src/errors.ts`:

```ts

/** D97: a check that stops the daemon, or enroll, before it runs; the message is written for the operator. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}
```

- [ ] **Step 5: Move the credential-free environment**

Create `apps/runner/src/credentials/credential-env.ts`:

```ts
/**
 * D88: the forge-token variables the daemon may have inherited from its operator never reach nax's environment — the
 * job's shims are the only thing that puts a token into a gh/glab child, from the socket. D96: every nax call (probe,
 * job check) uses the same rule.
 */
const CREDENTIAL_ENV_VARS: readonly string[] = ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN'];

export function withoutCredentialVars(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_ENV_VARS.includes(name)));
}
```

In `apps/runner/src/executor/host-executor.ts`, delete lines 38-46 (the D88 comment, `CREDENTIAL_ENV_VARS` and the `withoutCredentialVars` function), and add after the other imports:

```ts
import { withoutCredentialVars } from '../credentials/credential-env';

export { withoutCredentialVars } from '../credentials/credential-env';
```

The `spawn` method keeps calling `withoutCredentialVars(process.env)` unchanged.

- [ ] **Step 6: Write `NaxCli`**

Create `apps/runner/src/nax/nax-cli.ts`:

```ts
import { withoutCredentialVars } from '../credentials/credential-env';
import { StartupError } from '../errors';

export interface NaxResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface NaxCallOptions {
  readonly cwd: string;
}

/** D96: how the runner asks nax a question (its read-only JSON commands). Tests inject a fake. */
export interface NaxCli {
  run(args: readonly string[], options: NaxCallOptions): Promise<NaxResult>;
}

export const NAX_CALL_TIMEOUT_MS = 30_000;
const NOT_FOUND = 127;

function spawnCall(argv: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>>, timeoutMs: number) {
  try {
    return Bun.spawn([...argv], { cwd, env: { ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' });
  } catch {
    return null;   // Bun.spawn throws ENOENT synchronously for a missing executable or cwd
  }
}

/** D96: `[...naxCommand, ...args]`, stdin closed, the credential-free environment plus NAX_GLOBAL_CONFIG_DIR, SIGKILL at the timeout. */
export function createNaxCli(naxCommand: readonly string[], naxHome: string, timeoutMs: number = NAX_CALL_TIMEOUT_MS): NaxCli {
  return {
    async run(args, options) {
      const env = { ...withoutCredentialVars(process.env), NAX_GLOBAL_CONFIG_DIR: naxHome };
      const proc = spawnCall([...naxCommand, ...args], options.cwd, env, timeoutMs);
      if (!proc) return { code: NOT_FOUND, stdout: '', stderr: `${naxCommand[0] ?? 'nax'}: not found`, timedOut: false };
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr, timedOut: proc.signalCode === 'SIGKILL' };
    },
  };
}

export type NaxJson = { readonly ok: true; readonly value: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly code: string };

const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * D96: nax's JSON commands print one document on stdout, also when they exit 1 (`sandbox probe`, `trust check`); a
 * failure is `{"error":{"code","message"}}` (nax SPEC-cli-json-output). Codes are bounded: they reach stateReason.
 */
export function parseNaxJson(result: NaxResult): NaxJson {
  if (result.timedOut) return { ok: false, code: 'NAX_TIMEOUT' };
  const value = tryParse(result.stdout);
  if (value === undefined) {
    return { ok: false, code: result.code === NOT_FOUND && result.stdout.trim() === '' ? 'NAX_NOT_FOUND' : 'NAX_OUTPUT_UNPARSEABLE' };
  }
  if (!isObj(value)) return { ok: false, code: 'NAX_OUTPUT_UNPARSEABLE' };
  const error = value['error'];
  if (isObj(error)) {
    const code = error['code'];
    return { ok: false, code: typeof code === 'string' && ERROR_CODE.test(code) ? code : 'NAX_ERROR' };
  }
  return { ok: true, value };
}

/** D97: the first release with `config --json`, `auth list --json`, `sandbox probe --json` and `trust`. */
export const MIN_NAX_VERSION: readonly [number, number, number] = [0, 83, 1];

export function parseNaxVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function versionAtLeast(version: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  if (version[0] !== min[0]) return version[0] > min[0];
  if (version[1] !== min[1]) return version[1] > min[1];
  return version[2] >= min[2];
}

export class NaxUnavailableError extends StartupError {
  constructor(message: string) {
    super(message);
    this.name = 'NaxUnavailableError';
  }
}

/** D97: the first line of `nax --version` (at most 64 characters), checked against the floor. */
export async function readNaxVersion(nax: NaxCli, cwd: string): Promise<string> {
  const result = await nax.run(['--version'], { cwd });
  const line = (result.stdout.trim().split('\n')[0] ?? '').trim().slice(0, 64);
  const parsed = result.code === 0 && !result.timedOut ? parseNaxVersion(line) : null;
  const floor = MIN_NAX_VERSION.join('.');
  if (!parsed) {
    const why = result.timedOut ? 'timed out' : `exit ${result.code}`;
    throw new NaxUnavailableError(`nax did not answer --version (${why}); koda-runner needs nax ${floor} or newer on the PATH of the runner's user`);
  }
  if (!versionAtLeast(parsed, MIN_NAX_VERSION)) throw new NaxUnavailableError(`koda-runner needs nax ${floor} or newer (found ${line})`);
  return line;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/nax/nax-cli.spec.ts test/unit/nax-cli.spec.ts test/unit/host-executor.spec.ts && bun run type-check && bun run lint`
Expected: PASS; type-check and lint clean (host-executor's re-export keeps its importers working).

- [ ] **Step 8: Commit**

```bash
git add apps/runner/src/errors.ts apps/runner/src/credentials/credential-env.ts apps/runner/src/executor/host-executor.ts apps/runner/src/nax/nax-cli.ts apps/runner/src/nax/nax-cli.spec.ts apps/runner/test/unit/nax-cli.spec.ts
git commit -m "feat(runner): nax CLI seam with timeout, JSON error codes and the 0.83.1 floor (D96, D97)"
```

---

### Task 2: Mapping nax's JSON documents

**Files:**
- Create: `apps/runner/src/capabilities/nax-json.ts`
- Test: `apps/runner/src/capabilities/nax-json.spec.ts`

**Interfaces:**
- Consumes: `ProfileNeeds`, `RunnerCredential`, `RunnerCredentialExec`, `NaxProtocol` from `@nathapp/fleet-protocol`.
- Produces:
  - `interface Requirements { transport: 'native' | 'acp'; providers: readonly string[]; sandbox: boolean }`
  - `parseRequirements(report: Readonly<Record<string, unknown>>): Requirements | null`
  - `toProfileNeeds(r: Requirements): ProfileNeeds`
  - `MAX_PROVIDERS_PER_PROFILE = 16`
  - `parseAuthList(report): { credentials: RunnerCredential[]; skipped: number } | null`
  - `unavailableCredential(providerId: string): RunnerCredential`
  - `parseSandboxProbe(report): { available: boolean; error?: string } | null`
  - `parseTrustCheck(report): { trusted: boolean; root: string } | null`
  - `isProviderId(v: unknown): v is string`

The fixtures below are nax's documented shapes (SPEC-cli-json-output "Output format", SPEC-sandbox-probe-json, SPEC-project-trust-gate) and what nax 0.83.1 printed on this machine on 2026-09-30.

- [ ] **Step 1: Write the failing tests**

Create `apps/runner/src/capabilities/nax-json.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parseAuthList, parseRequirements, parseSandboxProbe, parseTrustCheck, toProfileNeeds, unavailableCredential } from './nax-json';

// nax 0.83.1 `config --profile native-ds --json`, this machine, 2026-09-30 (`config` block elided).
const CONFIG_NATIVE = {
  profile: 'native-ds', profileChain: ['native-ds'], sources: { global: '/home/u/.nax/config.json', project: null },
  requirements: { agent: 'native', transport: 'native', protocol: 'hybrid', providers: ['openrouter', 'minimax', 'opencode-go', 'minimax'], sandbox: true },
  config: {},
};
const CONFIG_ACP = { ...CONFIG_NATIVE, requirements: { agent: 'opencode', transport: 'acp', protocol: 'hybrid', providers: [], sandbox: false } };

// SPEC-cli-json-output AuthListReport, exec source (with an account label and a helper error).
const AUTH_EXEC = {
  source: 'exec', helper: { command: ['/usr/local/bin/cred-helper', '--team', 'a'] },
  providers: [
    { providerId: 'anthropic', stored: null, exec: { status: 'served', account: 'team-a' }, ambient: false, available: true },
    { providerId: 'openai', stored: { kind: 'api-key', expired: false }, exec: { status: 'declined' }, ambient: false, available: true },
    { providerId: 'zai', stored: null, exec: { status: 'error', code: 'CREDENTIAL_HELPER_FAILED' }, ambient: false, available: false },
  ],
};
// nax 0.83.1 `auth list --json deepseek`, file source, this machine.
const AUTH_FILE = {
  source: 'file',
  providers: [
    { providerId: 'deepseek', stored: null, ambient: false, available: false },
    { providerId: 'openai-codex', stored: { kind: 'oauth', expired: false, expires: '2026-10-01T06:54:37.064Z' }, ambient: false, available: true },
  ],
};

describe('parseRequirements (design §3.2, D98)', () => {
  test('transport becomes the protocol; providers are deduplicated and sorted; sandbox is kept', () => {
    const r = parseRequirements(CONFIG_NATIVE);
    expect(r).toEqual({ transport: 'native', providers: ['minimax', 'opencode-go', 'openrouter'], sandbox: true });
    expect(toProfileNeeds(r as NonNullable<typeof r>)).toEqual({ protocol: 'native', providers: ['minimax', 'opencode-go', 'openrouter'], sandbox: true });
    expect(parseRequirements(CONFIG_ACP)).toEqual({ transport: 'acp', providers: [], sandbox: false });
  });
  test.each([
    ['no requirements', { profile: 'x' }],
    ['an unknown transport', { requirements: { ...CONFIG_NATIVE.requirements, transport: 'hybrid' } }],
    ['a non-boolean sandbox', { requirements: { ...CONFIG_NATIVE.requirements, sandbox: 'yes' } }],
    ['a non-string provider', { requirements: { ...CONFIG_NATIVE.requirements, providers: ['a', 7] } }],
    ['an empty provider id', { requirements: { ...CONFIG_NATIVE.requirements, providers: [''] } }],
    ['a 201-character provider id', { requirements: { ...CONFIG_NATIVE.requirements, providers: ['p'.repeat(201)] } }],
  ])('%s is null', (_what, report) => {
    expect(parseRequirements(report)).toBeNull();
  });
});

describe('parseAuthList (design §1.1, D99)', () => {
  test('exec becomes its status string; account labels, helper codes, source and helper are dropped', () => {
    expect(parseAuthList(AUTH_EXEC)).toEqual({
      skipped: 0,
      credentials: [
        { providerId: 'anthropic', available: true, stored: null, exec: 'served', ambient: false },
        { providerId: 'openai', available: true, stored: { kind: 'api-key', expired: false }, exec: 'declined', ambient: false },
        { providerId: 'zai', available: false, stored: null, exec: 'error', ambient: false },
      ],
    });
  });
  test('a file source has no exec key; an OAuth expiry is kept', () => {
    expect(parseAuthList(AUTH_FILE)?.credentials).toEqual([
      { providerId: 'deepseek', available: false, stored: null, ambient: false },
      { providerId: 'openai-codex', available: true, stored: { kind: 'oauth', expires: '2026-10-01T06:54:37.064Z', expired: false }, ambient: false },
    ]);
  });
  test('a malformed row is skipped and counted, the rest kept', () => {
    const report = {
      providers: [
        AUTH_FILE.providers[1],
        { providerId: 'a', stored: { kind: 'password', expired: false }, ambient: false, available: true },
        { providerId: 'b', stored: null, ambient: 'no', available: true },
        { providerId: 'c', stored: null, exec: { status: 'maybe' }, ambient: false, available: true },
        { providerId: 'd', stored: { kind: 'oauth', expired: false, expires: 'not a date' }, ambient: false, available: true },
        'e',
      ],
    };
    const parsed = parseAuthList(report);
    expect(parsed?.skipped).toBe(5);
    expect(parsed?.credentials.map((c) => c.providerId)).toEqual(['openai-codex']);
  });
  test('no providers array is null', () => {
    expect(parseAuthList({ source: 'file' })).toBeNull();
  });
  test('unavailableCredential is what a provider nax could not list looks like', () => {
    expect(unavailableCredential('zai')).toEqual({ providerId: 'zai', available: false, stored: null, ambient: false });
  });
});

describe('parseSandboxProbe (D100)', () => {
  test('available, and unavailable with nax\'s reason capped at 200 characters', () => {
    expect(parseSandboxProbe({ backend: 'srt', platform: 'darwin', available: true })).toEqual({ available: true });
    expect(parseSandboxProbe({ backend: 'srt', platform: 'linux', available: false, reason: 'sandbox could not run a command: bwrap: No permissions to create new namespace' }))
      .toEqual({ available: false, error: 'sandbox could not run a command: bwrap: No permissions to create new namespace' });
    expect(parseSandboxProbe({ available: false, reason: 'r'.repeat(300) })?.error).toHaveLength(200);
    expect(parseSandboxProbe({ available: false })).toEqual({ available: false, error: 'unavailable' });
  });
  test('no boolean available is null', () => {
    expect(parseSandboxProbe({ backend: 'srt' })).toBeNull();
  });
});

describe('parseTrustCheck (D103)', () => {
  test('reads trusted and root', () => {
    expect(parseTrustCheck({ root: '/w/acme/app', trusted: true, coveredBy: '/w' })).toEqual({ trusted: true, root: '/w/acme/app' });
    expect(parseTrustCheck({ root: '/w', trusted: false, coveredBy: null })).toEqual({ trusted: false, root: '/w' });
    expect(parseTrustCheck({ root: '/w' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/capabilities/nax-json.spec.ts`
Expected: FAIL, `Cannot find module './nax-json'`.

- [ ] **Step 3: Write the mappers**

Create `apps/runner/src/capabilities/nax-json.ts`:

```ts
import type { ProfileNeeds, RunnerCredential, RunnerCredentialExec } from '@nathapp/fleet-protocol';

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Same bound as the server validator's strings (apps/api/src/fleet/common/capabilities.ts `isStr`). */
export const isProviderId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
export const MAX_PROVIDERS_PER_PROFILE = 16;

export interface Requirements {
  readonly transport: 'native' | 'acp';
  readonly providers: readonly string[];
  readonly sandbox: boolean;
}

/** `ConfigJsonReport.requirements` (nax SPEC-cli-json-output). null: not the documented shape. */
export function parseRequirements(report: Obj): Requirements | null {
  const r = report['requirements'];
  if (!isObj(r)) return null;
  const { transport, providers, sandbox } = r;
  if (transport !== 'native' && transport !== 'acp') return null;
  if (typeof sandbox !== 'boolean' || !Array.isArray(providers) || !providers.every(isProviderId)) return null;
  return { transport, providers: [...new Set(providers as string[])].sort(), sandbox };
}

/** Design §3.2: `ProfileNeeds.protocol` is nax's `requirements.transport`. */
export const toProfileNeeds = (r: Requirements): ProfileNeeds => ({ protocol: r.transport, providers: [...r.providers], sandbox: r.sandbox });

const EXEC_STATUS: ReadonlySet<string> = new Set(['served', 'declined', 'error']);

/** undefined: invalid. */
function toStored(v: unknown): RunnerCredential['stored'] | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const { kind, expired, expires } = v;
  if ((kind !== 'api-key' && kind !== 'oauth') || typeof expired !== 'boolean') return undefined;
  if (expires !== undefined && (typeof expires !== 'string' || Number.isNaN(Date.parse(expires)))) return undefined;
  return { kind, ...(typeof expires === 'string' ? { expires } : {}), expired };
}

/** undefined: no exec key; null: invalid. */
function toExec(v: unknown): RunnerCredentialExec | undefined | null {
  if (v === undefined) return undefined;
  if (!isObj(v)) return null;
  const { status } = v;
  return typeof status === 'string' && EXEC_STATUS.has(status) ? (status as RunnerCredentialExec) : null;
}

function toCredential(v: unknown): RunnerCredential | null {
  if (!isObj(v)) return null;
  const { providerId, available, ambient } = v;
  if (!isProviderId(providerId) || typeof available !== 'boolean' || typeof ambient !== 'boolean') return null;
  const stored = toStored(v['stored']);
  const exec = toExec(v['exec']);
  if (stored === undefined || exec === null) return null;
  return { providerId, available, stored, ...(exec ? { exec } : {}), ambient };
}

/** `AuthListReport` -> `RunnerCredential[]` (design §1.1): account labels and helper codes are not carried (D99). */
export function parseAuthList(report: Obj): { credentials: RunnerCredential[]; skipped: number } | null {
  const providers = report['providers'];
  if (!Array.isArray(providers)) return null;
  const credentials = providers.map(toCredential).filter((c): c is RunnerCredential => c !== null);
  return { credentials, skipped: providers.length - credentials.length };
}

/** D99: a provider nax could not list is unavailable (placement queues), never missing (placement 422s a pin). */
export const unavailableCredential = (providerId: string): RunnerCredential => ({ providerId, available: false, stored: null, ambient: false });

const MAX_SANDBOX_ERROR = 200;

/** `nax sandbox probe --json` (nax SPEC-sandbox-probe-json). */
export function parseSandboxProbe(report: Obj): { available: boolean; error?: string } | null {
  const available = report['available'];
  if (typeof available !== 'boolean') return null;
  if (available) return { available: true };
  const reason = report['reason'];
  return { available: false, error: (typeof reason === 'string' && reason !== '' ? reason : 'unavailable').slice(0, MAX_SANDBOX_ERROR) };
}

/** `nax trust check --json` (nax SPEC-project-trust-gate). */
export function parseTrustCheck(report: Obj): { trusted: boolean; root: string } | null {
  const { trusted, root } = report;
  return typeof trusted === 'boolean' && typeof root === 'string' ? { trusted, root } : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/capabilities/nax-json.spec.ts && bun run type-check && bun run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/capabilities/nax-json.ts apps/runner/src/capabilities/nax-json.spec.ts
git commit -m "feat(runner): map nax config, auth list, sandbox probe and trust check JSON (D98-D100)"
```

---
### Task 3: `NaxCapabilityProbe` and a reporter that refreshes safely

**Files:**
- Create: `apps/runner/test/helpers/fake-nax-cli.ts`
- Create: `apps/runner/src/capabilities/map-limit.ts`
- Create: `apps/runner/src/capabilities/nax-probe.ts`
- Modify: `apps/runner/src/capabilities/capability-probe.ts` (whole file below)
- Modify: `apps/runner/src/commands/enroll.ts:115` (the probe now returns `{capabilities, warnings}`)
- Test: `apps/runner/src/capabilities/map-limit.spec.ts`, `apps/runner/src/capabilities/nax-probe.spec.ts`, `apps/runner/src/capabilities/capability-probe.spec.ts` (whole file below)

**Interfaces:**
- Consumes: Task 1 `NaxCli`, `NaxResult`, `parseNaxJson`, `readNaxVersion`; Task 2 `parseRequirements`, `toProfileNeeds`, `parseAuthList`, `unavailableCredential`, `parseSandboxProbe`, `MAX_PROVIDERS_PER_PROFILE`; `withoutCredentialVars` (Task 1); `PROFILE_NAME`, `RESERVED_PREFIX` from `src/executor/nax-process.ts`.
- Produces:
  - `interface ProbeResult { capabilities: RunnerCapabilities; warnings: readonly string[] }`
  - `interface CapabilityProbe { probe(): Promise<ProbeResult> }` (was `Promise<RunnerCapabilities>`)
  - `CapabilityReporter(probe, journal: Pick<Journal,'setMeta'>, log?: Logger)` with `refresh(): Promise<boolean>` (true: hash changed; rejects when the probe throws), `report()`, `markSent(hash)`, `latest(): RunnerCapabilities | null`
  - `mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>`
  - `interface NaxProbeDeps { nax: NaxCli; naxHome: string; now: Now; toolWorks: (command: string) => Promise<boolean>; makeEmptyDir?: () => Promise<EmptyDir> }`, `interface EmptyDir { dir: string; remove(): Promise<void> }`
  - `class NaxCapabilityProbe implements CapabilityProbe`
  - `toolWorks(command: string): Promise<boolean>`, `makeEmptyDir(): Promise<EmptyDir>`, `listProfileNames(naxHome: string): Promise<string[]>`, `MAX_PROFILES = 64`, `MAX_CREDENTIALS = 64`
  - test helper `FakeNaxCli` (`calls`, mutable `answers`), `json(value, code?)`, `naxError(code)`, `TIMED_OUT`

- [ ] **Step 1: Write the scripted nax used by every unit test from here on**

Create `apps/runner/test/helpers/fake-nax-cli.ts`:

```ts
import type { NaxCli, NaxResult } from '../../src/nax/nax-cli';

export const json = (value: unknown, code = 0): NaxResult => ({ code, stdout: JSON.stringify(value), stderr: '', timedOut: false });
export const naxError = (code: string): NaxResult => json({ error: { code, message: `fake ${code}` } }, 1);
export const TIMED_OUT: NaxResult = { code: 137, stdout: '', stderr: '', timedOut: true };

export interface FakeRequirements {
  readonly transport: 'native' | 'acp';
  readonly providers: readonly string[];
  readonly sandbox: boolean;
}

export interface NaxAnswers {
  /** `--version` output (default 0.83.1), or a raw result. */
  version?: string | NaxResult;
  /** Keyed by the `--profile` value as passed (a chain keeps its commas; no flag is `default`). */
  config?: Readonly<Record<string, FakeRequirements | NaxResult>>;
  /** AuthListReport rows; a requested provider without a row is listed unavailable, as nax does. */
  auth?: readonly unknown[] | NaxResult;
  /** The sandbox probe document (default: available), or a raw result. */
  sandbox?: Readonly<Record<string, unknown>> | NaxResult;
  /** trust check verdict (default true), or a raw result. */
  trusted?: boolean | NaxResult;
}

const isResult = (v: unknown): v is NaxResult => typeof v === 'object' && v !== null && 'timedOut' in v;
const flag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** A scripted nax (D96): records every call and answers from `answers`, which a test may replace between calls. */
export class FakeNaxCli implements NaxCli {
  readonly calls: Array<{ args: string[]; cwd: string }> = [];

  constructor(public answers: NaxAnswers = {}) {}

  async run(args: readonly string[], options: { cwd: string }): Promise<NaxResult> {
    this.calls.push({ args: [...args], cwd: options.cwd });
    return this.answer(args);
  }

  private answer(args: readonly string[]): NaxResult {
    const a = this.answers;
    const [command] = args;
    if (command === '--version') return isResult(a.version) ? a.version : { code: 0, stdout: `${a.version ?? '0.83.1'}\n`, stderr: '', timedOut: false };
    if (command === 'config') {
      const chain = flag(args, '--profile') ?? 'default';
      const entry = a.config?.[chain];
      if (entry === undefined) return naxError('PROFILE_NOT_FOUND');
      if (isResult(entry)) return entry;
      return json({ profile: chain, profileChain: chain.split(','), sources: { global: null, project: null }, requirements: { agent: 'native', protocol: 'hybrid', ...entry }, config: {} });
    }
    if (command === 'auth') {
      if (isResult(a.auth)) return a.auth;
      const rows = (a.auth ?? []) as ReadonlyArray<{ providerId?: unknown }>;
      const missing = args.slice(3).filter((id) => !rows.some((r) => r.providerId === id));
      return json({ source: 'file', providers: [...rows, ...missing.map((providerId) => ({ providerId, stored: null, ambient: false, available: false }))] });
    }
    if (command === 'sandbox') {
      if (isResult(a.sandbox)) return a.sandbox;
      const report = a.sandbox ?? { backend: 'srt', platform: 'darwin', available: true };
      return json(report, report['available'] === true ? 0 : 1);
    }
    if (command === 'trust') {
      if (isResult(a.trusted)) return a.trusted;
      const trusted = a.trusted ?? true;
      const root = args[args.length - 1] ?? '';
      return json({ root, trusted, coveredBy: trusted ? root : null }, trusted ? 0 : 1);
    }
    return naxError('UNKNOWN_COMMAND');
  }
}
```

- [ ] **Step 2: Write the failing `mapLimit` test**

Create `apps/runner/src/capabilities/map-limit.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mapLimit } from './map-limit';

describe('mapLimit', () => {
  test('keeps input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await Bun.sleep(n * 3);
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });
  test('an empty list resolves at once', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
```

- [ ] **Step 3: Write the failing probe tests**

Create `apps/runner/src/capabilities/nax-probe.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NaxUnavailableError } from '../nax/nax-cli';
import { FakeNaxCli, TIMED_OUT, naxError, type FakeRequirements } from '../../test/helpers/fake-nax-cli';
import { makeTempDirs } from '../../test/helpers/tmp';
import { NaxCapabilityProbe, listProfileNames } from './nax-probe';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const clock = () => new Date('2026-10-01T00:00:00.000Z');
const NATIVE: FakeRequirements = { transport: 'native', providers: [], sandbox: false };

async function naxHome(profiles: readonly string[]): Promise<string> {
  const home = await tmp.make('probe');
  await mkdir(join(home, 'profiles'), { recursive: true });
  for (const name of profiles) await writeFile(join(home, 'profiles', `${name}.json`), '{}');
  return home;
}

function probeWith(home: string, nax: FakeNaxCli, have: readonly string[] = ['git', 'gh']) {
  const removed: string[] = [];
  const empty = join(home, 'empty');
  const prober = new NaxCapabilityProbe({
    nax, naxHome: home, now: clock, toolWorks: async (command) => have.includes(command),
    makeEmptyDir: async () => {
      await mkdir(empty, { recursive: true });
      return { dir: empty, remove: async () => { removed.push(empty); } };
    },
  });
  return { run: () => prober.probe(), removed, empty };
}

describe('listProfileNames (D98)', () => {
  test('json files only, koda job overlays excluded, sorted by code unit; no profiles dir is empty', async () => {
    const home = await naxHome(['beta', 'Alpha', 'koda-job-cabc', 'alpha2']);   // distinct letters: macOS file names are case-insensitive
    await writeFile(join(home, 'profiles', 'notes.txt'), 'x');
    await mkdir(join(home, 'profiles', 'dir.json'));
    expect(await listProfileNames(home)).toEqual(['Alpha', 'alpha2', 'beta']);
    expect(await listProfileNames(join(home, 'nowhere'))).toEqual([]);
  });
});

describe('NaxCapabilityProbe (design §3.2, D98-D101)', () => {
  test("reports nax's answers: version, ProfileNeeds per profile, needed credentials first, sandbox, protocols and tools", async () => {
    const home = await naxHome(['native-ds', 'cross-agent', 'koda-job-cabc']);
    const nax = new FakeNaxCli({
      version: '0.83.1',
      config: {
        'native-ds': { transport: 'native', providers: ['openrouter', 'minimax'], sandbox: true },
        'cross-agent': { transport: 'acp', providers: [], sandbox: false },
      },
      auth: [
        { providerId: 'anthropic', stored: { kind: 'api-key', expired: false }, ambient: false, available: true },
        { providerId: 'openrouter', stored: { kind: 'api-key', expired: false }, ambient: false, available: true },
      ],
    });
    const { run, removed, empty } = probeWith(home, nax, ['git', 'gh', 'acpx']);
    const { capabilities, warnings } = await run();
    expect(capabilities).toEqual({
      nax: { version: '0.83.1', protocols: ['native', 'acp'] },
      sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
      profiles: {
        'cross-agent': { protocol: 'acp', providers: [], sandbox: false },
        'native-ds': { protocol: 'native', providers: ['minimax', 'openrouter'], sandbox: true },
      },
      credentials: [
        { providerId: 'minimax', available: false, stored: null, ambient: false },
        { providerId: 'openrouter', available: true, stored: { kind: 'api-key', expired: false }, ambient: false },
        { providerId: 'anthropic', available: true, stored: { kind: 'api-key', expired: false }, ambient: false },
      ],
      tools: { git: true, gh: true, glab: false },
      executors: ['host'],
    });
    expect(warnings).toEqual([]);
    expect(nax.calls.filter((c) => c.args[0] === 'config').map((c) => c.args)).toEqual([
      ['config', '-d', empty, '--profile', 'cross-agent', '--json'],
      ['config', '-d', empty, '--profile', 'native-ds', '--json'],
    ]);
    expect(nax.calls.every((c) => c.cwd === empty)).toBe(true);
    expect(nax.calls.find((c) => c.args[0] === 'auth')?.args).toEqual(['auth', 'list', '--json', 'minimax', 'openrouter']);
    expect(removed).toEqual([empty]);
  });

  test('Review focus 1: 68 valid profiles report the first 64 by name; a bad name and a failing profile are skipped with warnings', async () => {
    const names = Array.from({ length: 67 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const home = await naxHome([...names, 'bad name', 'otel']);
    const config = Object.fromEntries(names.map((name) => [name, NATIVE]));
    const nax = new FakeNaxCli({ config: { ...config, otel: naxError('PROFILE_ENV_VAR_UNRESOLVED') } });
    const { capabilities, warnings } = await probeWith(home, nax).run();
    // sorted: otel, p00 ... p66; the first 64 are otel and p00-p62; otel fails
    expect(Object.keys(capabilities.profiles)).toHaveLength(63);
    expect(capabilities.profiles['p62']).toEqual({ protocol: 'native', providers: [], sandbox: false });
    expect(capabilities.profiles['p63']).toBeUndefined();
    expect(capabilities.profiles['otel']).toBeUndefined();
    expect(warnings).toEqual([
      'skipped 1 profile file(s) whose names koda cannot carry: "bad name"',
      'reported the first 64 of 68 profiles by name',
      'profile otel skipped: PROFILE_ENV_VAR_UNRESOLVED',
    ]);
    expect(nax.calls.filter((c) => c.args[0] === 'config')).toHaveLength(64);
  });

  test('a profile needing more than 16 providers, or with a document of another shape, is skipped', async () => {
    const home = await naxHome(['many', 'odd', 'ok']);
    const nax = new FakeNaxCli({
      config: {
        many: { transport: 'native', providers: Array.from({ length: 17 }, (_, i) => `p${i}`), sandbox: false },
        odd: { code: 0, stdout: '{"requirements":{"transport":"hybrid"}}', stderr: '', timedOut: false },
        ok: NATIVE,
      },
    });
    const { capabilities, warnings } = await probeWith(home, nax).run();
    expect(Object.keys(capabilities.profiles)).toEqual(['ok']);
    expect(warnings).toEqual(['profile many skipped: TOO_MANY_PROVIDERS', 'profile odd skipped: NAX_OUTPUT_UNPARSEABLE']);
  });

  test('D99: a failed auth listing reports every needed provider unavailable (never missing) and warns', async () => {
    const home = await naxHome(['fast']);
    const nax = new FakeNaxCli({ config: { fast: { transport: 'native', providers: ['deepseek'], sandbox: false } }, auth: naxError('CREDENTIAL_FILE_UNREADABLE') });
    const { capabilities, warnings } = await probeWith(home, nax).run();
    expect(capabilities.credentials).toEqual([{ providerId: 'deepseek', available: false, stored: null, ambient: false }]);
    expect(warnings).toEqual(['nax auth list failed (CREDENTIAL_FILE_UNREADABLE); needed providers reported unavailable']);
  });

  test('D100, Review focus 2: an unavailable sandbox carries its reason; a timed-out probe is a failure, and the probe still completes', async () => {
    const home = await naxHome([]);
    const reason = 'sandbox could not run a command: bwrap: No permissions to create new namespace';
    const unavailable = await probeWith(home, new FakeNaxCli({ sandbox: { backend: 'srt', platform: 'linux', available: false, reason } })).run();
    expect(unavailable.capabilities.sandbox).toEqual({ available: false, error: reason, probedAt: '2026-10-01T00:00:00.000Z' });
    const timedOut = await probeWith(home, new FakeNaxCli({ sandbox: TIMED_OUT })).run();
    expect(timedOut.capabilities.sandbox).toEqual({ available: false, error: 'nax sandbox probe failed: NAX_TIMEOUT', probedAt: '2026-10-01T00:00:00.000Z' });
    expect(timedOut.capabilities.nax.version).toBe('0.83.1');
  });

  test('no profiles: an empty profile map, and the auth listing asks for no provider', async () => {
    const home = await tmp.make('bare');
    const nax = new FakeNaxCli();
    const { capabilities } = await probeWith(home, nax).run();
    expect(capabilities.profiles).toEqual({});
    expect(nax.calls.find((c) => c.args[0] === 'auth')?.args).toEqual(['auth', 'list', '--json']);
  });

  test('D97: an older nax rejects with NaxUnavailableError, and the empty dir is still removed', async () => {
    const home = await naxHome(['fast']);
    const { run, removed, empty } = probeWith(home, new FakeNaxCli({ version: '0.83.0' }));
    await expect(run()).rejects.toBeInstanceOf(NaxUnavailableError);
    expect(removed).toEqual([empty]);
  });
});
```

- [ ] **Step 4: Rewrite the capability-probe spec for the new shape**

Replace the whole of `apps/runner/src/capabilities/capability-probe.spec.ts` with:

```ts
import { describe, expect, test } from 'bun:test';
import type { StaticCapabilities } from '../config/runner-config';
import { createMemoryLogger } from '../logger';
import { CapabilityReporter, StaticCapabilityProbe, hashCapabilities, stableStringify, type CapabilityProbe } from './capability-probe';

const stat = (over: Partial<StaticCapabilities> = {}): StaticCapabilities => ({
  nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: false }, executors: ['host'], ...over,
});
let clock = new Date('2026-10-01T00:00:00.000Z');
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
const noMeta = { setMeta: () => undefined };

describe('StaticCapabilityProbe', () => {
  test('reports the configured block, stamps sandbox.probedAt with the probe time (D41), and has no warnings', async () => {
    clock = new Date('2026-10-01T00:00:00.000Z');
    const probe = new StaticCapabilityProbe(stat(), () => clock);
    const first = await probe.probe();
    expect(first).toEqual({ capabilities: { ...stat(), sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' } }, warnings: [] });
    clock = new Date('2026-10-01T00:10:00.000Z');
    expect((await probe.probe()).capabilities.sandbox.probedAt).toBe('2026-10-01T00:10:00.000Z');
  });
  test('returns a copy: mutating a report does not change the next one', async () => {
    const probe = new StaticCapabilityProbe(stat(), () => clock);
    const a = (await probe.probe()).capabilities;
    a.tools.gh = false;
    expect((await probe.probe()).capabilities.tools.gh).toBe(true);
  });
  test('a sandbox error string is carried through', async () => {
    const report = await new StaticCapabilityProbe(stat({ sandbox: { available: false, error: 'bwrap missing' } }), () => clock).probe();
    expect(report.capabilities.sandbox).toEqual({ available: false, error: 'bwrap missing', probedAt: clock.toISOString() });
  });
});

describe('hashCapabilities', () => {
  test('ignores key order and sandbox.probedAt, and changes with anything else, the sandbox error included (D100)', async () => {
    const a = (await new StaticCapabilityProbe(stat(), () => new Date(1)).probe()).capabilities;
    const b = (await new StaticCapabilityProbe(stat(), () => new Date(99_999)).probe()).capabilities;
    expect(hashCapabilities(a)).toBe(hashCapabilities(b));
    expect(hashCapabilities({ ...a, tools: { glab: false, gh: true, git: true } })).toBe(hashCapabilities(a));
    expect(hashCapabilities({ ...a, tools: { ...a.tools, glab: true } })).not.toBe(hashCapabilities(a));
    expect(hashCapabilities({ ...a, sandbox: { ...a.sandbox, available: false } })).not.toBe(hashCapabilities(a));
    expect(hashCapabilities({ ...a, sandbox: { ...a.sandbox, error: 'x' } })).not.toBe(hashCapabilities(a));
    expect(hashCapabilities(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  test('stableStringify sorts keys at every depth and keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });
});

describe('CapabilityReporter', () => {
  test('sends until marked, stays quiet for unchanged content, reports a change again; refresh says whether the hash changed', async () => {
    const meta: Record<string, string> = {};
    let current = stat();
    const probe: CapabilityProbe = { probe: async () => new StaticCapabilityProbe(current, () => clock).probe() };
    const reporter = new CapabilityReporter(probe, { setMeta: (k, v) => { meta[k] = v; } });
    expect(reporter.report()).toBeNull();
    expect(reporter.latest()).toBeNull();
    expect(await reporter.refresh()).toBe(true);
    const first = reporter.report();
    expect(first?.capabilities.nax.version).toBe('0.83.0');
    expect(reporter.latest()?.nax.version).toBe('0.83.0');
    expect(reporter.report()?.hash).toBe(first?.hash as string);
    reporter.markSent(first?.hash as string);
    expect(meta['last_capabilities_hash']).toBe(first?.hash as string);
    expect(reporter.report()).toBeNull();
    clock = new Date('2026-10-02T00:00:00.000Z');
    expect(await reporter.refresh()).toBe(false);
    expect(reporter.report()).toBeNull();
    current = stat({ tools: { git: true, gh: false, glab: false } });
    expect(await reporter.refresh()).toBe(true);
    expect(reporter.report()?.hash).not.toBe(first?.hash);
  });

  test('D102: refreshes are serialised; calls during a running probe share one queued probe', async () => {
    let runs = 0;
    const gates: Array<() => void> = [];
    const probe: CapabilityProbe = {
      probe: async () => {
        runs += 1;
        await new Promise<void>((resolve) => { gates.push(resolve); });
        return new StaticCapabilityProbe(stat(), () => clock).probe();
      },
    };
    const reporter = new CapabilityReporter(probe, noMeta);
    const first = reporter.refresh();
    await settle();
    const second = reporter.refresh();
    const third = reporter.refresh();
    expect(second).toBe(third);
    expect(runs).toBe(1);
    gates.shift()?.();
    expect(await first).toBe(true);
    await settle();
    expect(runs).toBe(2);
    gates.shift()?.();
    expect(await second).toBe(false);
    expect(runs).toBe(2);
  });

  test('Review focus 3: a probe that throws rejects refresh and keeps the last report; the next refresh works', async () => {
    let fail = false;
    const probe: CapabilityProbe = {
      probe: async () => {
        if (fail) throw new Error('nax gone');
        return new StaticCapabilityProbe(stat(), () => clock).probe();
      },
    };
    const reporter = new CapabilityReporter(probe, noMeta);
    await reporter.refresh();
    fail = true;
    await expect(reporter.refresh()).rejects.toThrow('nax gone');
    expect(reporter.latest()?.nax.version).toBe('0.83.0');
    fail = false;
    expect(await reporter.refresh()).toBe(false);
  });

  test('D102: warnings are logged when the set changes, not on every probe', async () => {
    const log = createMemoryLogger();
    let warnings = ['profile otel skipped: PROFILE_ENV_VAR_UNRESOLVED'];
    const probe: CapabilityProbe = { probe: async () => ({ ...(await new StaticCapabilityProbe(stat(), () => clock).probe()), warnings }) };
    const reporter = new CapabilityReporter(probe, noMeta, log);
    await reporter.refresh();
    await reporter.refresh();
    warnings = [];
    await reporter.refresh();
    warnings = ['x'];
    await reporter.refresh();
    expect(log.lines.filter((l) => l.level === 'warn').map((l) => l.fields['detail'])).toEqual(['profile otel skipped: PROFILE_ENV_VAR_UNRESOLVED', 'x']);
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/capabilities`
Expected: FAIL (`Cannot find module './map-limit'`, `'./nax-probe'`; the reporter tests fail on `refresh()` returning undefined and `latest` missing).

- [ ] **Step 6: Write `mapLimit`**

Create `apps/runner/src/capabilities/map-limit.ts`:

```ts
/** Runs `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
```

- [ ] **Step 7: Rewrite `capability-probe.ts`**

Replace the whole of `apps/runner/src/capabilities/capability-probe.ts` with:

```ts
import { createHash } from 'node:crypto';
import type { RunnerCapabilities } from '@nathapp/fleet-protocol';
import type { StaticCapabilities } from '../config/runner-config';
import type { Journal } from '../journal/journal';
import type { Logger } from '../logger';
import type { CapabilityReport } from '../sync/sync-loop';
import type { Now } from '../time';

/** What a probe found, and what it had to leave out (D98, D99). */
export interface ProbeResult {
  readonly capabilities: RunnerCapabilities;
  readonly warnings: readonly string[];
}

/** Design §3.2: `NaxCapabilityProbe` asks nax; `StaticCapabilityProbe` reads runner.json (D95). */
export interface CapabilityProbe {
  probe(): Promise<ProbeResult>;
}

/** D95: the operator declares the capabilities in runner.json; only the probe time is dynamic (D41). */
export class StaticCapabilityProbe implements CapabilityProbe {
  constructor(private readonly capabilities: StaticCapabilities, private readonly now: Now) {}

  async probe(): Promise<ProbeResult> {
    const { sandbox, ...rest } = structuredClone(this.capabilities);
    return { capabilities: { ...rest, sandbox: { ...sandbox, probedAt: this.now().toISOString() } }, warnings: [] };
  }
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** D100: `sandbox.error` stays in the hash: nax's reasons are deterministic, so a changed reason is a real change. */
export function hashCapabilities(caps: RunnerCapabilities): string {
  const { probedAt: _probedAt, ...sandbox } = caps.sandbox;
  return createHash('sha256').update(stableStringify({ ...caps, sandbox })).digest('hex');
}

/**
 * Slice 3 design §3.2: sent on the first sync after boot and whenever the hash (without probedAt) changes. D102:
 * refreshes are serialised, a request while one runs queues exactly one more, and warnings are logged only when the
 * set changes.
 */
export class CapabilityReporter {
  private current: CapabilityReport | null = null;
  private sentHash: string | null = null;
  private warned = '';
  private tail: Promise<unknown> = Promise.resolve();
  private queued: Promise<boolean> | null = null;

  constructor(private readonly probe: CapabilityProbe, private readonly journal: Pick<Journal, 'setMeta'>, private readonly log?: Logger) {}

  /** Resolves true when the report's hash changed; rejects when the probe throws (the last report stays). */
  refresh(): Promise<boolean> {
    if (this.queued) return this.queued;
    const next = this.tail.catch(() => undefined).then(() => {
      this.queued = null;
      return this.probeOnce();
    });
    this.queued = next;
    this.tail = next;
    return next;
  }

  report(): CapabilityReport | null {
    return this.current && this.current.hash !== this.sentHash ? this.current : null;
  }

  /** The last probed capabilities; the job check compares a job's needs with them (D104). */
  latest(): RunnerCapabilities | null {
    return this.current?.capabilities ?? null;
  }

  markSent(hash: string): void {
    this.sentHash = hash;
    this.journal.setMeta('last_capabilities_hash', hash);
  }

  private async probeOnce(): Promise<boolean> {
    const { capabilities, warnings } = await this.probe.probe();
    const hash = hashCapabilities(capabilities);
    const changed = this.current?.hash !== hash;
    this.current = { capabilities, hash };
    const key = warnings.join('\n');
    if (key !== this.warned) {
      this.warned = key;
      for (const detail of warnings) this.log?.warn('capability probe', { detail });
    }
    return changed;
  }
}
```

- [ ] **Step 8: Write the probe**

Create `apps/runner/src/capabilities/nax-probe.ts`:

```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NaxProtocol, ProfileNeeds, RunnerCapabilities, RunnerCredential } from '@nathapp/fleet-protocol';
import { withoutCredentialVars } from '../credentials/credential-env';
import { PROFILE_NAME, RESERVED_PREFIX } from '../executor/nax-process';
import { parseNaxJson, readNaxVersion, type NaxCli } from '../nax/nax-cli';
import type { Now } from '../time';
import type { CapabilityProbe, ProbeResult } from './capability-probe';
import { mapLimit } from './map-limit';
import { MAX_PROVIDERS_PER_PROFILE, parseAuthList, parseRequirements, parseSandboxProbe, toProfileNeeds, unavailableCredential } from './nax-json';

/** The server validator's limits (apps/api/src/fleet/common/capabilities.ts). */
export const MAX_PROFILES = 64;
export const MAX_CREDENTIALS = 64;
const PROFILE_CONCURRENCY = 4;
const TOOL_TIMEOUT_MS = 10_000;

export interface EmptyDir {
  readonly dir: string;
  remove(): Promise<void>;
}

export interface NaxProbeDeps {
  readonly nax: NaxCli;
  readonly naxHome: string;
  readonly now: Now;
  /** D101: true when `<command> --version` exits 0. */
  readonly toolWorks: (command: string) => Promise<boolean>;
  /** D98: machine profiles are resolved from a directory with no project config. */
  readonly makeEmptyDir?: () => Promise<EmptyDir>;
}

export async function makeEmptyDir(): Promise<EmptyDir> {
  const dir = await mkdtemp(join(tmpdir(), 'koda-runner-probe-'));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** D101: `Bun.which` first, then `<command> --version` with a 10 s timeout and no forge token in its environment. */
export async function toolWorks(command: string): Promise<boolean> {
  const path = Bun.which(command);
  if (!path) return false;
  try {
    const proc = Bun.spawn([path, '--version'], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...withoutCredentialVars(process.env) },
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** D98: `<naxHome>/profiles/*.json` names without koda's job overlays, sorted by code unit. */
export async function listProfileNames(naxHome: string): Promise<string[]> {
  const entries = await readdir(join(naxHome, 'profiles'), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter((name) => !name.startsWith(RESERVED_PREFIX))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

type Resolved = { readonly name: string; readonly needs: ProfileNeeds } | { readonly name: string; readonly error: string };

interface ProfileScan {
  readonly profiles: Record<string, ProfileNeeds>;
  readonly providers: readonly string[];
  readonly warnings: readonly string[];
}

const byProviderId = (a: RunnerCredential, b: RunnerCredential): number => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0);

/** Design §3.2 over nax's JSON commands (D98-D101). Throws NaxUnavailableError when nax is missing or older than 0.83.1. */
export class NaxCapabilityProbe implements CapabilityProbe {
  constructor(private readonly deps: NaxProbeDeps) {}

  async probe(): Promise<ProbeResult> {
    const empty = await (this.deps.makeEmptyDir ?? makeEmptyDir)();
    try {
      const version = await readNaxVersion(this.deps.nax, empty.dir);
      const [scan, sandbox, protocols, tools] = await Promise.all([this.scanProfiles(empty.dir), this.sandbox(empty.dir), this.protocols(), this.tools()]);
      const credentials = await this.credentials(empty.dir, scan.providers);
      const capabilities: RunnerCapabilities = {
        nax: { version, protocols },
        sandbox: { ...sandbox, probedAt: this.deps.now().toISOString() },
        profiles: scan.profiles,
        credentials: credentials.list,
        tools,
        executors: ['host'],
      };
      return { capabilities, warnings: [...scan.warnings, ...credentials.warnings] };
    } finally {
      await empty.remove();
    }
  }

  private async scanProfiles(cwd: string): Promise<ProfileScan> {
    const names = await listProfileNames(this.deps.naxHome);
    const valid = names.filter((name) => PROFILE_NAME.test(name));
    const invalid = names.filter((name) => !PROFILE_NAME.test(name));
    const resolved = await mapLimit(valid.slice(0, MAX_PROFILES), PROFILE_CONCURRENCY, (name) => this.resolveProfile(cwd, name));
    const good = resolved.flatMap((r) => ('needs' in r ? [r] : []));
    const quoted = invalid.slice(0, 5).map((name) => JSON.stringify(name.slice(0, 64))).join(', ');
    return {
      profiles: Object.fromEntries(good.map((r) => [r.name, r.needs])),
      providers: [...new Set(good.flatMap((r) => r.needs.providers))].sort(),
      warnings: [
        ...(invalid.length > 0 ? [`skipped ${invalid.length} profile file(s) whose names koda cannot carry: ${quoted}`] : []),
        ...(valid.length > MAX_PROFILES ? [`reported the first ${MAX_PROFILES} of ${valid.length} profiles by name`] : []),
        ...resolved.flatMap((r) => ('error' in r ? [`profile ${r.name} skipped: ${r.error}`] : [])),
      ],
    };
  }

  private async resolveProfile(cwd: string, name: string): Promise<Resolved> {
    const json = parseNaxJson(await this.deps.nax.run(['config', '-d', cwd, '--profile', name, '--json'], { cwd }));
    if (!json.ok) return { name, error: json.code };
    const requirements = parseRequirements(json.value);
    if (!requirements) return { name, error: 'NAX_OUTPUT_UNPARSEABLE' };
    if (requirements.providers.length > MAX_PROVIDERS_PER_PROFILE) return { name, error: 'TOO_MANY_PROVIDERS' };
    return { name, needs: toProfileNeeds(requirements) };
  }

  /** D99: needed providers first (one nax did not list is unavailable), then the rest by id; at most 64. */
  private async credentials(cwd: string, needed: readonly string[]): Promise<{ list: RunnerCredential[]; warnings: string[] }> {
    const json = parseNaxJson(await this.deps.nax.run(['auth', 'list', '--json', ...needed], { cwd }));
    const parsed = json.ok ? parseAuthList(json.value) : null;
    if (!parsed) {
      const code = json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code;
      return { list: needed.slice(0, MAX_CREDENTIALS).map(unavailableCredential), warnings: [`nax auth list failed (${code}); needed providers reported unavailable`] };
    }
    const byId = new Map(parsed.credentials.map((c) => [c.providerId, c] as const));
    const all = [
      ...needed.map((id) => byId.get(id) ?? unavailableCredential(id)),
      ...[...byId.values()].filter((c) => !needed.includes(c.providerId)).sort(byProviderId),
    ];
    return {
      list: all.slice(0, MAX_CREDENTIALS),
      warnings: [
        ...(parsed.skipped > 0 ? [`nax auth list: skipped ${parsed.skipped} malformed row(s)`] : []),
        ...(all.length > MAX_CREDENTIALS ? [`reported ${MAX_CREDENTIALS} of ${all.length} credentials (needed providers first)`] : []),
      ],
    };
  }

  private async sandbox(cwd: string): Promise<{ available: boolean; error?: string }> {
    const json = parseNaxJson(await this.deps.nax.run(['sandbox', 'probe', '--json'], { cwd }));
    const parsed = json.ok ? parseSandboxProbe(json.value) : null;
    return parsed ?? { available: false, error: `nax sandbox probe failed: ${json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code}` };
  }

  private async protocols(): Promise<NaxProtocol[]> {
    return (await this.deps.toolWorks('acpx')) ? ['native', 'acp'] : ['native'];
  }

  private async tools(): Promise<RunnerCapabilities['tools']> {
    const [git, gh, glab] = await Promise.all(['git', 'gh', 'glab'].map((tool) => this.deps.toolWorks(tool)));
    return { git, gh, glab };
  }
}
```

- [ ] **Step 9: Keep `enroll` compiling**

In `apps/runner/src/commands/enroll.ts:115`, change

```ts
  const capabilities = await new StaticCapabilityProbe(config.capabilities, deps.now).probe();
```

to

```ts
  const { capabilities } = await new StaticCapabilityProbe(config.capabilities, deps.now).probe();
```

(Task 5 replaces this line; the daemon only calls the reporter, whose public shape is unchanged apart from `refresh` now resolving a boolean.)

- [ ] **Step 10: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/capabilities src/commands && bun run type-check && bun run lint`
Expected: PASS; clean.

- [ ] **Step 11: Commit**

```bash
git add apps/runner/test/helpers/fake-nax-cli.ts apps/runner/src/capabilities apps/runner/src/commands/enroll.ts
git commit -m "feat(runner): NaxCapabilityProbe and a serialised capability reporter (D98-D102)"
```

---
### Task 4: The fake nax answers the probe commands

**Files:**
- Create: `apps/runner/test/fixtures/fake-nax-probe.ts`
- Modify: `apps/runner/test/fixtures/fake-nax.ts:28-31` (`--version`, dispatch to the probe answers)
- Test: `apps/runner/test/unit/fake-nax-probe.spec.ts`

**Interfaces:**
- Consumes: Task 1 `createNaxCli`; Task 3 `NaxCapabilityProbe`.
- Produces: `answerProbe(args: readonly string[], env: Readonly<Record<string, string | undefined>>, cwd: string): { stdout: string; code: number } | null` and the file conventions of D108, used by Tasks 7 and 12:
  - `<naxHome>/profiles/<name>.json` with `"fakeRequirements": {"transport","providers","sandbox"}` or `"fakeError": "<CODE>"`
  - `<dir>/.nax/fake-profiles/<name>.json` (same keys), for profiles a repo provides (`dir` is `config -d`)
  - `<naxHome>/fake-auth.json` = `{"providers": [<AuthListReport rows>]}`
  - `<naxHome>/fake-sandbox.json` = the whole sandbox probe document
  - `<naxHome>/fake-untrusted` (any content): every folder is untrusted
  - `FAKE_NAX_VERSION` (default `0.83.1-fake`)

- [ ] **Step 1: Write the failing tests**

Create `apps/runner/test/unit/fake-nax-probe.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NaxCapabilityProbe } from '../../src/capabilities/nax-probe';
import { createNaxCli } from '../../src/nax/nax-cli';
import { answerProbe } from '../fixtures/fake-nax-probe';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');

async function home() {
  const naxHome = await tmp.make('fakeprobe');
  await mkdir(join(naxHome, 'profiles'), { recursive: true });
  await writeFile(join(naxHome, 'profiles', 'fast.json'), JSON.stringify({ fakeRequirements: { transport: 'native', providers: ['deepseek'], sandbox: true } }));
  await writeFile(join(naxHome, 'profiles', 'broken.json'), JSON.stringify({ fakeError: 'PROFILE_ENV_VAR_UNRESOLVED' }));
  await writeFile(join(naxHome, 'fake-auth.json'), JSON.stringify({ providers: [{ providerId: 'deepseek', stored: { kind: 'api-key', expired: false }, ambient: false, available: true }] }));
  const repo = join(naxHome, 'repo');
  await mkdir(join(repo, '.nax', 'fake-profiles'), { recursive: true });
  await writeFile(join(repo, '.nax', 'fake-profiles', 'needs-zai.json'), JSON.stringify({ fakeRequirements: { transport: 'native', providers: ['zai'], sandbox: false } }));
  return { naxHome, repo, env: { NAX_GLOBAL_CONFIG_DIR: naxHome } };
}
const parsed = (a: { stdout: string } | null) => JSON.parse(a?.stdout ?? 'null');

describe('answerProbe (D108)', () => {
  test('config: no chain is the default requirements; a machine profile and a repo profile answer their fakeRequirements', async () => {
    const h = await home();
    expect(parsed(answerProbe(['config', '-d', h.repo, '--json'], h.env, h.repo)).requirements).toEqual({ agent: 'native', protocol: 'hybrid', transport: 'native', providers: [], sandbox: false });
    expect(parsed(answerProbe(['config', '-d', h.repo, '--profile', 'fast', '--json'], h.env, h.repo)).requirements).toMatchObject({ providers: ['deepseek'], sandbox: true });
    expect(parsed(answerProbe(['config', '-d', h.repo, '--profile', 'fast,needs-zai', '--json'], h.env, h.repo)).requirements).toMatchObject({ providers: ['zai'] });
  });
  test('config: an unknown profile is PROFILE_NOT_FOUND and a fakeError profile is its code, both exit 1', async () => {
    const h = await home();
    expect(answerProbe(['config', '--profile', 'nope', '--json'], h.env, h.repo)).toEqual({ stdout: JSON.stringify({ error: { code: 'PROFILE_NOT_FOUND', message: 'fake-nax: PROFILE_NOT_FOUND' } }), code: 1 });
    expect(parsed(answerProbe(['config', '--profile', 'broken', '--json'], h.env, h.repo)).error.code).toBe('PROFILE_ENV_VAR_UNRESOLVED');
  });
  test('auth list: the stored rows, plus every asked provider without one listed unavailable', async () => {
    const h = await home();
    expect(parsed(answerProbe(['auth', 'list', '--json', 'deepseek', 'zai'], h.env, h.repo))).toEqual({
      source: 'file',
      providers: [
        { providerId: 'deepseek', stored: { kind: 'api-key', expired: false }, ambient: false, available: true },
        { providerId: 'zai', stored: null, ambient: false, available: false },
      ],
    });
  });
  test('sandbox probe: available by default; fake-sandbox.json replaces the document and exits 1 when unavailable', async () => {
    const h = await home();
    expect(answerProbe(['sandbox', 'probe', '--json'], h.env, h.repo)?.code).toBe(0);
    await writeFile(join(h.naxHome, 'fake-sandbox.json'), JSON.stringify({ backend: 'srt', platform: 'linux', available: false, reason: 'bwrap: no userns' }));
    expect(answerProbe(['sandbox', 'probe', '--json'], h.env, h.repo)).toEqual({ stdout: JSON.stringify({ backend: 'srt', platform: 'linux', available: false, reason: 'bwrap: no userns' }), code: 1 });
  });
  test('trust check: trusted by default; the fake-untrusted marker makes every folder untrusted (exit 1)', async () => {
    const h = await home();
    expect(answerProbe(['trust', 'check', '--json', h.repo], h.env, '/')).toEqual({ stdout: JSON.stringify({ root: h.repo, trusted: true, coveredBy: h.repo }), code: 0 });
    await writeFile(join(h.naxHome, 'fake-untrusted'), '');
    expect(answerProbe(['trust', 'check', '--json', h.repo], h.env, '/')?.code).toBe(1);
  });
  test('run, plan and anything without --json are not probe commands', async () => {
    const h = await home();
    expect(answerProbe(['run', '--headless', '--json', '-f', 'x'], h.env, h.repo)).toBeNull();
    expect(answerProbe(['config'], h.env, h.repo)).toBeNull();
  });
});

describe('the fake nax as a real process', () => {
  test('--version prints FAKE_NAX_VERSION or 0.83.1-fake; NaxCapabilityProbe reads the fake end to end', async () => {
    const h = await home();
    const { FAKE_NAX_VERSION: _unset, ...env } = process.env;
    const version = Bun.spawnSync(['bun', FAKE, '--version'], { env });
    expect(version.stdout.toString().trim()).toBe('0.83.1-fake');
    const probe = new NaxCapabilityProbe({ nax: createNaxCli(['bun', FAKE], h.naxHome), naxHome: h.naxHome, now: () => new Date(0), toolWorks: async () => true });
    const { capabilities, warnings } = await probe.probe();
    expect(capabilities.nax).toEqual({ version: '0.83.1-fake', protocols: ['native', 'acp'] });
    expect(capabilities.profiles).toEqual({ fast: { protocol: 'native', providers: ['deepseek'], sandbox: true } });
    expect(capabilities.credentials).toEqual([{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }]);
    expect(warnings).toEqual(['profile broken skipped: PROFILE_ENV_VAR_UNRESOLVED']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test test/unit/fake-nax-probe.spec.ts`
Expected: FAIL, `Cannot find module '../fixtures/fake-nax-probe'`.

- [ ] **Step 3: Write the probe answers**

Create `apps/runner/test/fixtures/fake-nax-probe.ts`:

```ts
/**
 * The read-only nax commands the runner calls (D108): `config --json`, `auth list --json`, `sandbox probe --json`,
 * `trust check --json`. State lives in the nax home, so two in-process runners never share it:
 * - `<naxHome>/profiles/<name>.json` may carry `fakeRequirements` or `fakeError`; a name not there is looked up in
 *   `<dir>/.nax/fake-profiles/<name>.json` (a profile the repo provides; `dir` is `config -d`)
 * - `<naxHome>/fake-auth.json` is `{ "providers": [...] }` in nax's AuthListReport row shape
 * - `<naxHome>/fake-sandbox.json` is the whole probe document (default: available)
 * - `<naxHome>/fake-untrusted` makes every folder untrusted
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface Requirements {
  transport: 'native' | 'acp';
  providers: string[];
  sandbox: boolean;
}

export interface ProbeAnswer {
  readonly stdout: string;
  readonly code: number;
}

const DEFAULT_REQUIREMENTS: Requirements = { transport: 'native', providers: [], sandbox: false };

const flagValue = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = (args: readonly string[], from: number): string[] => args.slice(from).filter((a) => !a.startsWith('-'));

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const answer = (value: unknown, code = 0): ProbeAnswer => ({ stdout: JSON.stringify(value), code });
const failure = (code: string): ProbeAnswer => answer({ error: { code, message: `fake-nax: ${code}` } }, 1);

function config(args: readonly string[], naxHome: string, cwd: string): ProbeAnswer {
  const dir = flagValue(args, '-d') ?? cwd;
  const chain = (flagValue(args, '--profile') ?? '').split(',').filter(Boolean);
  let requirements = DEFAULT_REQUIREMENTS;
  for (const name of chain) {
    const file = readJson(join(naxHome, 'profiles', `${name}.json`)) ?? readJson(join(dir, '.nax', 'fake-profiles', `${name}.json`));
    if (!file) return failure('PROFILE_NOT_FOUND');
    if (typeof file['fakeError'] === 'string') return failure(file['fakeError']);
    if (file['fakeRequirements']) requirements = file['fakeRequirements'] as Requirements;
  }
  return answer({
    profile: chain.length > 0 ? chain.join('+') : 'default', profileChain: chain, sources: { global: null, project: null },
    requirements: { agent: requirements.transport === 'native' ? 'native' : 'opencode', protocol: 'hybrid', ...requirements },
    config: {},
  });
}

function authList(args: readonly string[], naxHome: string): ProbeAnswer {
  const stored = (readJson(join(naxHome, 'fake-auth.json'))?.['providers'] ?? []) as Array<{ providerId?: unknown }>;
  const unlisted = positional(args, 2)
    .filter((id) => !stored.some((row) => row.providerId === id))
    .map((providerId) => ({ providerId, stored: null, ambient: false, available: false }));
  return answer({ source: 'file', providers: [...stored, ...unlisted] });
}

function sandboxProbe(naxHome: string): ProbeAnswer {
  const report = readJson(join(naxHome, 'fake-sandbox.json')) ?? { backend: 'srt', platform: process.platform, available: true };
  return answer(report, report['available'] === true ? 0 : 1);
}

function trustCheck(args: readonly string[], naxHome: string, cwd: string): ProbeAnswer {
  const root = positional(args, 2)[0] ?? cwd;
  const trusted = !existsSync(join(naxHome, 'fake-untrusted'));
  return answer({ root, trusted, coveredBy: trusted ? root : null }, trusted ? 0 : 1);
}

export function answerProbe(args: readonly string[], env: Readonly<Record<string, string | undefined>>, cwd: string): ProbeAnswer | null {
  if (!args.includes('--json')) return null;
  const naxHome = env['NAX_GLOBAL_CONFIG_DIR'] ?? join(homedir(), '.nax');
  const [command, sub] = args;
  if (command === 'config') return config(args, naxHome, cwd);
  if (command === 'auth' && sub === 'list') return authList(args, naxHome);
  if (command === 'sandbox' && sub === 'probe') return sandboxProbe(naxHome);
  if (command === 'trust' && sub === 'check') return trustCheck(args, naxHome, cwd);
  return null;
}
```

- [ ] **Step 4: Route the fake nax through it**

In `apps/runner/test/fixtures/fake-nax.ts`, add to the imports:

```ts
import { answerProbe } from './fake-nax-probe';
```

and replace

```ts
if (args[0] === '--version') {
  console.log('0.0.0-fake');
  process.exit(0);
}
```

with

```ts
if (args[0] === '--version') {
  console.log(process.env['FAKE_NAX_VERSION'] ?? '0.83.1-fake');
  process.exit(0);
}
const probed = answerProbe(args, process.env, process.cwd());   // D108: config, auth list, sandbox probe, trust check
if (probed) {
  process.stdout.write(`${probed.stdout}\n`);
  process.exit(probed.code);
}
```

Also update the file's top comment to mention the probe commands: after "(slice 3 design §4)" add ", and the read-only probe commands of D108 (`fake-nax-probe.ts`)".

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/runner && bun test test/unit/fake-nax-probe.spec.ts test/unit/fake-nax.spec.ts && bun run type-check && bun run lint`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add apps/runner/test/fixtures/fake-nax-probe.ts apps/runner/test/fixtures/fake-nax.ts apps/runner/test/unit/fake-nax-probe.spec.ts
git commit -m "test(runner): the fake nax answers config, auth list, sandbox probe and trust check (D108)"
```

---

### Task 5: Capabilities block optional; `enroll` probes nax

**Files:**
- Create: `apps/runner/src/capabilities/create-probe.ts`
- Test: `apps/runner/src/capabilities/create-probe.spec.ts`
- Modify: `apps/runner/src/config/runner-config.ts:22-33,195` (`capabilities: StaticCapabilities | null`)
- Modify: `apps/runner/src/config/runner-config.spec.ts:26,54,80`
- Modify: `apps/runner/src/commands/enroll.ts` (drop `defaultCapabilities` and `which`, add `probe`)
- Modify: `apps/runner/src/commands/enroll.spec.ts`
- Modify: `apps/runner/src/daemon/daemon.ts:4,102` (use `createCapabilityProbe`)
- Modify: `apps/runner/src/main.ts:47` (enroll deps)
- Modify: `apps/runner/test/integration/harness/world.ts:213` (enroll deps)
- Modify: `apps/runner/test/unit/main.spec.ts` (the enroll-over-CLI test gets a runner.json whose nax is the fake: CI has no nax)

**Interfaces:**
- Consumes: Task 3 `StaticCapabilityProbe`, `NaxCapabilityProbe`, `toolWorks`; Task 1 `createNaxCli`.
- Produces:
  - `RunnerConfig.capabilities: StaticCapabilities | null` (null: probe nax)
  - `createCapabilityProbe(config: Pick<RunnerConfig, 'capabilities' | 'naxCommand' | 'naxHome'>, now: Now, nax?: NaxCli): CapabilityProbe`
  - `EnrollDeps.probe: (config: RunnerConfig) => CapabilityProbe` (replaces `which`)

- [ ] **Step 1: Write the failing factory test**

Create `apps/runner/src/capabilities/create-probe.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { StaticCapabilities } from '../config/runner-config';
import { FakeNaxCli } from '../../test/helpers/fake-nax-cli';
import { createCapabilityProbe } from './create-probe';

const STATIC: StaticCapabilities = {
  nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true }, profiles: {}, credentials: [],
  tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
const now = () => new Date('2026-10-01T00:00:00.000Z');

describe('createCapabilityProbe (D95)', () => {
  test('a capabilities block in runner.json is used as is; nax is never asked', async () => {
    const nax = new FakeNaxCli();
    const { capabilities } = await createCapabilityProbe({ capabilities: STATIC, naxCommand: ['nax'], naxHome: '/nh' }, now, nax).probe();
    expect(capabilities.nax.version).toBe('0.83.0');
    expect(nax.calls).toEqual([]);
  });
  test('without one, nax is probed', async () => {
    const nax = new FakeNaxCli({ version: '0.84.0' });
    const { capabilities } = await createCapabilityProbe({ capabilities: null, naxCommand: ['nax'], naxHome: '/nonexistent-nax-home' }, now, nax).probe();
    expect(capabilities.nax.version).toBe('0.84.0');
    expect(nax.calls[0]?.args).toEqual(['--version']);
  });
});
```

- [ ] **Step 2: Update the config spec and the enroll spec (failing)**

In `apps/runner/src/config/runner-config.spec.ts`:
- line 26: `expect(c.capabilities.tools.gh).toBe(true);` -> `expect(c.capabilities?.tools.gh).toBe(true);`
- line 80: `...}).capabilities.credentials).toEqual(credentials);` -> `...}).capabilities?.credentials).toEqual(credentials);`
- delete the rejection row `['missing capabilities', { capabilities: undefined }],` (line 54)
- add, inside the same `describe` as "applies the defaults":

```ts
  test('D95: capabilities may be omitted or null; the runner then probes nax', () => {
    expect(parse({ capabilities: undefined }).capabilities).toBeNull();
    expect(parse({ capabilities: null }).capabilities).toBeNull();
  });
```

In `apps/runner/src/commands/enroll.spec.ts`:

1. Replace the imports block (lines 1-9) with:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FLEET_PROTOCOL_VERSION, type EnrollRequest, type RunnerCapabilities } from '@nathapp/fleet-protocol';
import { loadRunnerConfig, resolveHome, type RunnerConfig } from '../config/runner-config';
import { readIdentity } from '../identity/identity-store';
import { NaxUnavailableError } from '../nax/nax-cli';
import { NetworkError, ServerError } from '../sync/http';
import { makeTempDirs } from '../../test/helpers/tmp';
import { EnrollError, defaultRunnerName, enrollRunner, type EnrollDeps } from './enroll';

const PROBED: RunnerCapabilities = {
  nax: { version: '0.83.1', protocols: ['native'] }, sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
```

2. In `deps()`, replace `which: (c) => (c === 'gh' ? null : \`/usr/bin/${c}\`),` with `probe: () => ({ probe: async () => ({ capabilities: PROBED, warnings: [] }) }),`.

3. Delete the test `'defaultCapabilities detects tools and declares the honest minimum (D50)'` (lines 35-41).

4. In the first `enrollRunner` test, rename it to `'writes runner.json (without a capabilities block) and identity.json (0600), sends the probed capabilities and protocol version, and never stores the token'`, replace its `capabilities: { nax: { version: 'unknown' }, sandbox: { available: false, probedAt: '2026-10-01T00:00:00.000Z' }, executors: ['host'] },` line with `capabilities: PROBED,`, and add before its last two lines:

```ts
    expect(JSON.parse(await readFile(o.home.configPath, 'utf8')).capabilities).toBeUndefined();
```

5. Add at the end of `describe('enrollRunner', ...)`:

```ts
  test('D97: a probe that fails (nax missing or older than 0.83.1) is an EnrollError; nothing is sent and no identity is written', async () => {
    const o = await opts();
    const { d, sent } = deps({ probe: () => ({ probe: async () => { throw new NaxUnavailableError('koda-runner needs nax 0.83.1 or newer (found 0.80.0)'); } }) });
    await expect(enrollRunner(o, d)).rejects.toThrow(/needs nax 0\.83\.1 or newer/);
    await expect(enrollRunner(o, d)).rejects.toBeInstanceOf(EnrollError);
    expect(sent).toEqual([]);
    expect(await readIdentity(o.home.identityPath)).toBeNull();
  });
  test('probe warnings are printed, and the probe gets the config just written (no capabilities block: nax mode)', async () => {
    const o = await opts();
    const seen: RunnerConfig[] = [];
    const { d, lines } = deps({
      probe: (config) => {
        seen.push(config);
        return { probe: async () => ({ capabilities: PROBED, warnings: ['profile otel skipped: PROFILE_ENV_VAR_UNRESOLVED'] }) };
      },
    });
    await enrollRunner(o, d);
    expect(lines).toContain('warning: profile otel skipped: PROFILE_ENV_VAR_UNRESOLVED');
    expect(seen[0]?.capabilities).toBeNull();
  });
```

In `apps/runner/test/unit/main.spec.ts`, `enroll` now probes nax before it contacts the server, and CI machines have no nax. Replace the test `'an unreachable server on enroll is a readable error, not a stack trace'` with:

```ts
  test('an unreachable server on enroll is a readable error, not a stack trace', async () => {
    const dir = await tmp.make('cli');
    const home = join(dir, 'home');
    await mkdir(home, { recursive: true });
    // D95: enroll probes nax first; the fake nax stands in for it (CI machines have none).
    await writeFile(join(home, 'runner.json'), JSON.stringify({
      serverUrl: 'http://127.0.0.1:9', workspaceRoot: join(dir, 'ws'), naxHome: join(dir, 'naxhome'), naxCommand: ['bun', FAKE_NAX],
    }));
    const { stderr, code } = await cli(['--home', home, 'enroll', '--server', 'http://127.0.0.1:9', '--token', 'ke_x']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/cannot reach the server/);
    expect(stderr).not.toMatch(/\n\s+at /);
  });
```

and add to its imports `import { mkdir, writeFile } from 'node:fs/promises';` and, after `const MAIN = ...`, `const FAKE_NAX = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/capabilities/create-probe.spec.ts src/config src/commands/enroll.spec.ts`
Expected: FAIL (`Cannot find module './create-probe'`; `capabilities is required`; enroll sends the static block).

- [ ] **Step 4: Make the block optional**

In `apps/runner/src/config/runner-config.ts`, change the `RunnerConfig` field to:

```ts
  /** D95: the operator's override; null (the default) means the daemon asks nax (`NaxCapabilityProbe`). */
  readonly capabilities: StaticCapabilities | null;
```

and in `parseRunnerConfig` change `capabilities: parseCapabilities(raw.capabilities),` to:

```ts
    capabilities: raw.capabilities === undefined || raw.capabilities === null ? null : parseCapabilities(raw.capabilities),
```

- [ ] **Step 5: Write the factory**

Create `apps/runner/src/capabilities/create-probe.ts`:

```ts
import type { RunnerConfig } from '../config/runner-config';
import { createNaxCli, type NaxCli } from '../nax/nax-cli';
import type { Now } from '../time';
import { StaticCapabilityProbe, type CapabilityProbe } from './capability-probe';
import { NaxCapabilityProbe, toolWorks } from './nax-probe';

/** D95: a capabilities block in runner.json is the operator's override; without one the runner asks nax. */
export function createCapabilityProbe(config: Pick<RunnerConfig, 'capabilities' | 'naxCommand' | 'naxHome'>, now: Now, nax?: NaxCli): CapabilityProbe {
  if (config.capabilities) return new StaticCapabilityProbe(config.capabilities, now);
  return new NaxCapabilityProbe({ nax: nax ?? createNaxCli(config.naxCommand, config.naxHome), naxHome: config.naxHome, now, toolWorks });
}
```

- [ ] **Step 6: `enroll` probes**

In `apps/runner/src/commands/enroll.ts`:

1. Imports: remove `import { StaticCapabilityProbe } from '../capabilities/capability-probe';`; change the runner-config import to `import { ConfigError, loadRunnerConfig, parseRunnerConfig, type RunnerConfig, type RunnerHome } from '../config/runner-config';`; add `import type { RunnerCapabilities } from '@nathapp/fleet-protocol';` (merge with the existing `@nathapp/fleet-protocol` import) and `import type { CapabilityProbe } from '../capabilities/capability-probe';`.
2. In `EnrollDeps`, replace `readonly which: (cmd: string) => string | null;` with:

```ts
  /** D95: `createCapabilityProbe` in production; the probe decides between runner.json and nax. */
  readonly probe: (config: RunnerConfig) => CapabilityProbe;
```

3. Delete `defaultCapabilities` and its D50 comment.
4. In `ensureConfig`, delete the `capabilities: defaultCapabilities(deps.which),` line from `raw`, and change the log line to `deps.log(\`wrote ${home.configPath}\`);`.
5. Add above `enrollRunner`:

```ts
/** D97: a machine whose nax is missing or older than 0.83.1 cannot run jobs, so it does not enroll. */
async function probeCapabilities(config: RunnerConfig, deps: EnrollDeps): Promise<RunnerCapabilities> {
  try {
    const { capabilities, warnings } = await deps.probe(config).probe();
    for (const warning of warnings) deps.log(`warning: ${warning}`);
    return capabilities;
  } catch (error) {
    throw new EnrollError(errorMessage(error));
  }
}
```

6. In `enrollRunner`, replace `const { capabilities } = await new StaticCapabilityProbe(config.capabilities, deps.now).probe();` with `const capabilities = await probeCapabilities(config, deps);`.

- [ ] **Step 7: Callers**

`apps/runner/src/main.ts`: add `import { createCapabilityProbe } from './capabilities/create-probe';` and in the enroll deps replace `which: (c) => Bun.which(c),` with `probe: (config) => createCapabilityProbe(config, systemNow),`.

`apps/runner/test/integration/harness/world.ts:213`: add `import { createCapabilityProbe } from '../../../src/capabilities/create-probe';` and replace `which: (c) => Bun.which(c),` with `probe: (config) => createCapabilityProbe(config, systemNow),`. (The harness still writes a static block until Task 12.)

`apps/runner/src/daemon/daemon.ts`: replace the import `import { CapabilityReporter, StaticCapabilityProbe } from '../capabilities/capability-probe';` with `import { CapabilityReporter } from '../capabilities/capability-probe';` plus `import { createCapabilityProbe } from '../capabilities/create-probe';`, and line 102 with:

```ts
  const reporter = new CapabilityReporter(createCapabilityProbe(config, now), journal, log);
```

(Task 6 finishes the daemon's nax mode.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/runner && bun run test && bun run type-check && bun run lint`
Expected: all unit specs PASS; clean.

- [ ] **Step 9: Commit**

```bash
git add apps/runner/src/capabilities/create-probe.ts apps/runner/src/capabilities/create-probe.spec.ts apps/runner/src/config apps/runner/src/commands/enroll.ts apps/runner/src/commands/enroll.spec.ts apps/runner/src/daemon/daemon.ts apps/runner/src/main.ts apps/runner/test/integration/harness/world.ts apps/runner/test/unit/main.spec.ts
git commit -m "feat(runner): capabilities block optional, enroll probes nax (D95)"
```

---

### Task 6: The daemon in nax mode: start checks, trust, periodic probe, SIGHUP

**Files:**
- Create: `apps/runner/src/nax/trust.ts`
- Test: `apps/runner/src/nax/trust.spec.ts`
- Modify: `apps/runner/src/daemon/tuning.ts`, `apps/runner/src/daemon/tuning.spec.ts`
- Modify: `apps/runner/src/daemon/daemon.ts` (options, start checks, reprobe, timer)
- Modify: `apps/runner/src/commands/run.ts`, `apps/runner/src/commands/run.spec.ts`
- Test: `apps/runner/test/unit/daemon.spec.ts` (a new `describe`)

**Interfaces:**
- Consumes: Task 1 `NaxCli`, `createNaxCli`, `parseNaxJson`, `NaxUnavailableError`, `StartupError`; Task 2 `parseTrustCheck`; Task 3 `CapabilityReporter.refresh/latest`, `CapabilityProbe`; Task 5 `createCapabilityProbe`.
- Produces:
  - `type TrustVerdict = { trusted: true } | { trusted: false; reason: string }`
  - `checkTrust(nax: NaxCli, path: string): Promise<TrustVerdict>`
  - `class WorkspaceUntrustedError extends StartupError`, `assertWorkspaceTrusted(nax, config: Pick<RunnerConfig, 'workspaceRoot' | 'naxHome'>): Promise<void>`
  - `Tuning.capabilityProbeMs = 600_000`, `Tuning.naxCallTimeoutMs = 30_000`
  - `DaemonOptions.nax?: NaxCli`, `DaemonOptions.capabilityProbe?: CapabilityProbe`; `DaemonHandle.reprobe(): Promise<void>`; inside `startDaemon`, the locals `nax` and `probed` (Task 7 uses them)
  - `RunDeps.onSignal` accepts `'SIGHUP'`

- [ ] **Step 1: Write the failing trust tests**

Create `apps/runner/src/nax/trust.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { FakeNaxCli, naxError } from '../../test/helpers/fake-nax-cli';
import { StartupError } from '../errors';
import { WorkspaceUntrustedError, assertWorkspaceTrusted, checkTrust } from './trust';

describe('checkTrust (D103)', () => {
  test("asks nax about the folder, from the folder, and follows nax's verdict", async () => {
    const nax = new FakeNaxCli();
    expect(await checkTrust(nax, '/w/acme/app')).toEqual({ trusted: true });
    expect(nax.calls).toEqual([{ args: ['trust', 'check', '--json', '/w/acme/app'], cwd: '/w/acme/app' }]);
    nax.answers = { trusted: false };
    expect(await checkTrust(nax, '/w/acme/app')).toEqual({ trusted: false, reason: 'project untrusted' });
  });
  test('a failed check is never trusted', async () => {
    expect(await checkTrust(new FakeNaxCli({ trusted: naxError('TRUST_STORE_UNREADABLE') }), '/w')).toEqual({ trusted: false, reason: 'trust check failed: TRUST_STORE_UNREADABLE' });
  });
});

describe('assertWorkspaceTrusted (D103)', () => {
  test('passes for a trusted workspace root', async () => {
    await assertWorkspaceTrusted(new FakeNaxCli(), { workspaceRoot: '/srv/ws', naxHome: '/home/k/.nax' });
  });
  test('Review focus 4: an untrusted root is a StartupError naming the exact command, with the nax home', async () => {
    const failure = assertWorkspaceTrusted(new FakeNaxCli({ trusted: false }), { workspaceRoot: '/srv/ws', naxHome: '/home/k/.nax' });
    await expect(failure).rejects.toBeInstanceOf(WorkspaceUntrustedError);
    await expect(failure).rejects.toBeInstanceOf(StartupError);
    await expect(failure).rejects.toThrow('NAX_GLOBAL_CONFIG_DIR=/home/k/.nax nax trust add /srv/ws --yes');
  });
});
```

- [ ] **Step 2: Write the failing daemon, run and tuning tests**

In `apps/runner/src/daemon/tuning.spec.ts`, add `capabilityProbeMs: 600_000, naxCallTimeoutMs: 30_000,` to the expected object (after `tokenPollMs: 250,`).

In `apps/runner/src/commands/run.spec.ts`:

1. Add to the imports: `import { NaxUnavailableError } from '../nax/nax-cli';`
2. Replace the whole `harness` function with:

```ts
function harness(stopper: (resolve: (v: 'stopped' | { kind: 'protocol' | 'auth'; message: string }) => void) => void) {
  const handlers: Array<() => void> = [];
  const signals = new Map<string, () => void>();
  let stopped = 0;
  let reprobes = 0;
  let stoppedOnce = false;
  const log = createMemoryLogger();
  const deps: RunDeps = {
    env: {}, log,
    start: async () => {
      let resolveStopped: (v: 'stopped' | { kind: 'protocol' | 'auth'; message: string }) => void = () => undefined;
      const stoppedPromise = new Promise<'stopped' | { kind: 'protocol' | 'auth'; message: string }>((r) => { resolveStopped = r; });
      stopper(resolveStopped);
      return {
        bootId: 'b', journal: null as never, supervisor: null as never, stopped: stoppedPromise as never,
        stop: async () => { if (!stoppedOnce) { stoppedOnce = true; stopped += 1; } resolveStopped('stopped'); },
        crash: () => undefined,
        reprobe: async () => { reprobes += 1; },
      } satisfies DaemonHandle;
    },
    onSignal: (signal, handler) => { handlers.push(handler); signals.set(signal, handler); },
  };
  return { deps, handlers, signals, log, get stopped() { return stopped; }, get reprobes() { return reprobes; } };
}
```

3. In `'SIGTERM or SIGINT stops the daemon cleanly (exit 0) without killing jobs'`, change `expect(h.handlers).toHaveLength(2);` to `expect(h.handlers).toHaveLength(3);`.
4. Add inside `describe('runCommand', ...)`:

```ts
  test('D102: SIGHUP asks the daemon to probe again and does not stop it', async () => {
    const home = await enrolledHome();
    const h = harness(() => undefined);
    const finished = runCommand(home.dir, h.deps);
    await Bun.sleep(20);
    h.signals.get('SIGHUP')?.();
    await Bun.sleep(5);
    expect(h.reprobes).toBe(1);
    expect(h.stopped).toBe(0);
    h.signals.get('SIGTERM')?.();
    expect(await finished).toBe(0);
  });
  test('D97, D103: a StartupError (nax too old, workspace untrusted) is exit 1 with its message logged as is', async () => {
    const home = await enrolledHome();
    const h = harness(() => undefined);
    const deps: RunDeps = { ...h.deps, start: async () => { throw new NaxUnavailableError('koda-runner needs nax 0.83.1 or newer (found 0.80.0)'); } };
    expect(await runCommand(home.dir, deps)).toBe(1);
    expect(h.log.lines.some((l) => l.level === 'error' && l.message === 'koda-runner needs nax 0.83.1 or newer (found 0.80.0)')).toBe(true);
  });
```

In `apps/runner/test/unit/daemon.spec.ts`, add to the imports:

```ts
import { NaxUnavailableError, type NaxResult } from '../../src/nax/nax-cli';
import { WorkspaceUntrustedError } from '../../src/nax/trust';
import { FakeNaxCli } from '../helpers/fake-nax-cli';
```

and append at the end of the file:

```ts
describe('startDaemon, capabilities from nax (D95, D97, D102, D103)', () => {
  async function probed(server: FakeServer, nax: FakeNaxCli) {
    const s = await setup(server);
    const config = parseRunnerConfig({
      serverUrl: server.url, workspaceRoot: join(s.base, 'ws'), naxHome: join(s.base, 'naxhome'), jobRetentionDays: 1, socketDir: join(s.base, 's'),
    }, {});
    const start = (over: Partial<Parameters<typeof startDaemon>[0]> = {}) =>
      startDaemon({ home: s.home, config, identity: s.identity, tuning, nax, executorFactory: () => s.ex, ...over });
    return { ...s, config, start };
  }
  const withCapabilities = (server: FakeServer) => server.syncs.filter((sync) => sync.capabilities !== undefined);

  test('without a capabilities block the first sync carries what nax reported; the workspace root was checked for trust', async () => {
    const server = fakeServer();
    const nax = new FakeNaxCli({ version: '0.83.1' });
    const p = await probed(server, nax);
    const log = createMemoryLogger();
    const daemon = await p.start({ log });
    try {
      await waitFor(() => server.syncs.length >= 1);
      expect(server.syncs[0].capabilities).toMatchObject({ nax: { version: '0.83.1' }, profiles: {}, sandbox: { available: true }, executors: ['host'] });
      expect(nax.calls.some((c) => c.args[0] === 'trust' && c.args[c.args.length - 1] === p.config.workspaceRoot)).toBe(true);
      expect(log.lines.some((l) => l.message.includes('nax is not probed'))).toBe(false);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('D97: nax older than 0.83.1 stops the start with NaxUnavailableError; nothing is sent', async () => {
    const server = fakeServer();
    const p = await probed(server, new FakeNaxCli({ version: '0.83.0' }));
    await expect(p.start()).rejects.toBeInstanceOf(NaxUnavailableError);
    expect(server.syncs).toEqual([]);
    server.stop();
  });

  test('Review focus 4, D103: an untrusted workspace root stops the start and names the nax trust add command', async () => {
    const server = fakeServer();
    const p = await probed(server, new FakeNaxCli({ trusted: false }));
    const failure = p.start();
    await expect(failure).rejects.toBeInstanceOf(WorkspaceUntrustedError);
    await expect(failure).rejects.toThrow(`nax trust add ${p.config.workspaceRoot} --yes`);
    expect(server.syncs).toEqual([]);
    server.stop();
  });

  test('D102: reprobe sends a changed report once; an unchanged one is not resent', async () => {
    const server = fakeServer();
    const nax = new FakeNaxCli({ version: '0.83.1' });
    const p = await probed(server, nax);
    const daemon = await p.start();
    try {
      await waitFor(() => withCapabilities(server).length === 1 && server.syncs.length >= 2);
      await daemon.reprobe();
      await Bun.sleep(50);
      expect(withCapabilities(server)).toHaveLength(1);
      nax.answers = { ...nax.answers, version: '0.84.0' };
      await daemon.reprobe();
      await waitFor(() => withCapabilities(server).length === 2);
      expect(withCapabilities(server)[1].capabilities?.nax.version).toBe('0.84.0');
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('Review focus 3: a probe that fails after start keeps the last report, warns, and the daemon keeps syncing', async () => {
    const server = fakeServer();
    const nax = new FakeNaxCli({ version: '0.83.1' });
    const p = await probed(server, nax);
    const log = createMemoryLogger();
    const daemon = await p.start({ log });
    try {
      await waitFor(() => server.syncs.length >= 2);
      const gone: NaxResult = { code: 127, stdout: '', stderr: 'nax: not found', timedOut: false };
      nax.answers = { ...nax.answers, version: gone };
      await daemon.reprobe();
      expect(log.lines.some((l) => l.level === 'warn' && l.message.includes('capability probe failed'))).toBe(true);
      const before = server.syncs.length;
      await waitFor(() => server.syncs.length > before);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });

  test('D102: the periodic probe runs every capabilityProbeMs', async () => {
    const server = fakeServer();
    const nax = new FakeNaxCli();
    const p = await probed(server, nax);
    const daemon = await p.start({ tuning: { ...tuning, capabilityProbeMs: 30 } });
    try {
      await waitFor(() => nax.calls.filter((c) => c.args[0] === '--version').length >= 3);
    } finally {
      await daemon.stop();
      server.stop();
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/nax/trust.spec.ts src/daemon/tuning.spec.ts src/commands/run.spec.ts test/unit/daemon.spec.ts`
Expected: FAIL (`Cannot find module './trust'`, missing tuning keys, `reprobe` not on `DaemonHandle`, `nax` not a daemon option).

- [ ] **Step 4: Write the trust check**

Create `apps/runner/src/nax/trust.ts`:

```ts
import { parseTrustCheck } from '../capabilities/nax-json';
import type { RunnerConfig } from '../config/runner-config';
import { StartupError } from '../errors';
import { parseNaxJson, type NaxCli } from './nax-cli';

export type TrustVerdict = { readonly trusted: true } | { readonly trusted: false; readonly reason: string };

/** D103: nax's own verdict for the folder (nax #2293). The runner never trusts a folder itself. */
export async function checkTrust(nax: NaxCli, path: string): Promise<TrustVerdict> {
  const json = parseNaxJson(await nax.run(['trust', 'check', '--json', path], { cwd: path }));
  if (!json.ok) return { trusted: false, reason: `trust check failed: ${json.code}` };
  const verdict = parseTrustCheck(json.value);
  if (!verdict) return { trusted: false, reason: 'trust check failed: NAX_OUTPUT_UNPARSEABLE' };
  return verdict.trusted ? { trusted: true } : { trusted: false, reason: 'project untrusted' };
}

export class WorkspaceUntrustedError extends StartupError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceUntrustedError';
  }
}

/** D103: every clone lives under workspaceRoot, so one trust entry there covers them all. */
export async function assertWorkspaceTrusted(nax: NaxCli, config: Pick<RunnerConfig, 'workspaceRoot' | 'naxHome'>): Promise<void> {
  const verdict = await checkTrust(nax, config.workspaceRoot);
  if (verdict.trusted) return;
  throw new WorkspaceUntrustedError(
    `nax does not trust ${config.workspaceRoot} (${verdict.reason}), so every job would stop before it starts. `
    + `As the runner's user, run: NAX_GLOBAL_CONFIG_DIR=${config.naxHome} nax trust add ${config.workspaceRoot} --yes `
    + '(or pass --trust-workspace to koda-runner install-service)',
  );
}
```

- [ ] **Step 5: Tuning**

In `apps/runner/src/daemon/tuning.ts`, add to the interface:

```ts
  /** D102, design §3.2: how often the capability probe runs (it also runs at start and on SIGHUP). */
  readonly capabilityProbeMs: number;
  /** D96: the timeout of one nax call. */
  readonly naxCallTimeoutMs: number;
```

and to `TUNING`, after `tokenPollMs: 250,`:

```ts
  capabilityProbeMs: 600_000,
  naxCallTimeoutMs: 30_000,
```

- [ ] **Step 6: Daemon**

In `apps/runner/src/daemon/daemon.ts`:

1. Imports: change the capability-probe import to `import { CapabilityReporter, type CapabilityProbe } from '../capabilities/capability-probe';` and add `import { createNaxCli, type NaxCli } from '../nax/nax-cli';` and `import { assertWorkspaceTrusted } from '../nax/trust';`.
2. `DaemonOptions`, add:

```ts
  /** D96: tests inject a scripted nax; otherwise `createNaxCli(config.naxCommand, config.naxHome)`. */
  readonly nax?: NaxCli;
  /** D95: tests inject a probe; otherwise `createCapabilityProbe(config)`. */
  readonly capabilityProbe?: CapabilityProbe;
```

3. `DaemonHandle`, add:

```ts
  /** D102: probe again now (SIGHUP); a changed report is sent on the next sync. Never rejects. */
  reprobe(): Promise<void>;
```

4. Delete the Task 5 line `const reporter = new CapabilityReporter(createCapabilityProbe(config, now), journal, log);` (after `capacity.refresh()`), and insert directly after `journal.setMeta('runner_id', identity.runnerId);`:

```ts
  const nax = options.nax ?? createNaxCli(config.naxCommand, config.naxHome, tuning.naxCallTimeoutMs);
  const probed = config.capabilities === null;   // D95
  const reporter = new CapabilityReporter(options.capabilityProbe ?? createCapabilityProbe(config, now, nax), journal, log);
  try {
    await reporter.refresh();   // D97, D102: nax missing or older than 0.83.1 stops the start
    if (probed) await assertWorkspaceTrusted(nax, config);   // D103
  } catch (error) {
    journal.close();
    throw error;
  }
  if (!probed) log.warn('capabilities come from runner.json; nax is not probed (remove the block to probe nax)');
```

Remove the now-duplicate `await reporter.refresh();` that followed the old reporter line.

5. After `const running = loop.run()...` add:

```ts
  const reprobe = async (): Promise<void> => {
    try {
      if (await reporter.refresh()) loop.wake();
    } catch (error) {
      // D102, Review focus 3: nax upgraded or removed under a running daemon; the last report stays.
      log.warn('capability probe failed; keeping the last report', { error: errorMessage(error) });
    }
  };
```

6. In the `timers` array add `setInterval(() => { void reprobe(); }, tuning.capabilityProbeMs),`.
7. Return `{ bootId, journal, supervisor, stopped: running, stop, crash, reprobe }`.

- [ ] **Step 7: `run` handles SIGHUP and StartupError**

In `apps/runner/src/commands/run.ts`:

1. Add `import { StartupError } from '../errors';` (merge with the existing `errorMessage` import).
2. `RunDeps.onSignal` becomes `readonly onSignal: (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void) => void;`.
3. The doc comment: `/** Exit codes: 0 clean stop, 1 not enrolled, bad config, nax missing or too old, or workspace untrusted, 2 stopped by the server (426 or 401). */`
4. The catch condition becomes `if (error instanceof ConfigError || error instanceof IdentityError || error instanceof StartupError) {`.
5. After `deps.onSignal('SIGINT', stopOnSignal);` add:

```ts
  deps.onSignal('SIGHUP', () => { void daemon.reprobe(); });   // D102: systemctl reload, launchctl kill HUP
```

`main.ts` needs no change: its `onSignal` passes any signal name to `process.on`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/nax src/daemon src/commands test/unit/daemon.spec.ts test/unit/daemon-socket-dir.spec.ts && bun run test && bun run type-check && bun run lint`
Expected: PASS; clean.

- [ ] **Step 9: Commit**

```bash
git add apps/runner/src/nax/trust.ts apps/runner/src/nax/trust.spec.ts apps/runner/src/daemon apps/runner/src/commands/run.ts apps/runner/src/commands/run.spec.ts apps/runner/test/unit/daemon.spec.ts
git commit -m "feat(runner): daemon probes nax at start, every 10 minutes and on SIGHUP; refuses an untrusted workspace (D97, D102, D103)"
```

---
### Task 7: The post-checkout job check

**Files:**
- Create: `apps/runner/src/capabilities/job-check.ts`
- Test: `apps/runner/src/capabilities/job-check.spec.ts` (scripted nax), `apps/runner/test/unit/job-check.spec.ts` (fake nax process, real git)
- Modify: `apps/runner/src/executor/host-executor.ts` (`jobCheck` dep, call after checkout)
- Modify: `apps/runner/src/daemon/daemon.ts` (wire `NaxJobCheck` in nax mode)

**Interfaces:**
- Consumes: Task 1 `NaxCli`, `parseNaxJson`, `createNaxCli`; Task 2 `parseRequirements`, `parseAuthList`, `Requirements`; Task 6 `checkTrust`, the daemon locals `nax`, `probed`, `reporter`; Task 4 fake-nax file conventions.
- Produces:
  - `interface JobCheck { check(assign: Pick<AssignPayload, 'profiles'>, repoDir: string): Promise<string | null> }`
  - `NO_JOB_CHECK: JobCheck`
  - `firstMismatch(requirements: Requirements, caps: Pick<RunnerCapabilities, 'nax' | 'sandbox'>, credentials: readonly RunnerCredential[]): string | null`
  - `class NaxJobCheck implements JobCheck` with deps `{ nax: NaxCli; capabilities: () => RunnerCapabilities | null }`
  - `HostExecutorDeps.jobCheck?: JobCheck`

- [ ] **Step 1: Write the failing unit tests (scripted nax)**

Create `apps/runner/src/capabilities/job-check.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { RunnerCapabilities } from '@nathapp/fleet-protocol';
import { FakeNaxCli, json, naxError, type NaxAnswers } from '../../test/helpers/fake-nax-cli';
import { NaxJobCheck, firstMismatch } from './job-check';

const REPO = '/w/acme/app';
const CAPS: RunnerCapabilities = {
  nax: { version: '0.83.1', protocols: ['native'] }, sandbox: { available: false, error: 'bwrap', probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
const DEEPSEEK = { providerId: 'deepseek', stored: { kind: 'api-key', expired: false }, ambient: false, available: true };
const NONE = { transport: 'native' as const, providers: [], sandbox: false };

function checker(answers: NaxAnswers) {
  const nax = new FakeNaxCli(answers);
  return { nax, check: (profiles: string[] = []) => new NaxJobCheck({ nax, capabilities: () => CAPS }).check({ profiles }, REPO) };
}

describe('NaxJobCheck (D104)', () => {
  test('no profiles: trust, then the clone\'s default config (no --profile); nothing needed means no auth listing', async () => {
    const c = checker({ config: { default: NONE } });
    expect(await c.check()).toBeNull();
    expect(c.nax.calls).toEqual([
      { args: ['trust', 'check', '--json', REPO], cwd: REPO },
      { args: ['config', '-d', REPO, '--json'], cwd: REPO },
    ]);
  });
  test('the chain is joined with commas; needed providers are checked against a fresh listing', async () => {
    const c = checker({ config: { 'fast,review': { transport: 'native', providers: ['deepseek'], sandbox: false } }, auth: [DEEPSEEK] });
    expect(await c.check(['fast', 'review'])).toBeNull();
    expect(c.nax.calls.map((call) => call.args)).toEqual([
      ['trust', 'check', '--json', REPO],
      ['config', '-d', REPO, '--profile', 'fast,review', '--json'],
      ['auth', 'list', '--json', 'deepseek'],
    ]);
  });
  test('an untrusted clone is `project untrusted`, and nothing else is asked', async () => {
    const c = checker({ trusted: false });
    expect(await c.check()).toBe('project untrusted');
    expect(c.nax.calls).toHaveLength(1);
  });
  test('a failed trust check is `trust check failed: <code>`', async () => {
    expect(await checker({ trusted: naxError('TRUST_STORE_UNREADABLE') }).check()).toBe('trust check failed: TRUST_STORE_UNREADABLE');
  });
  test('a chain nax cannot resolve is `profile resolve failed (<code>)`', async () => {
    expect(await checker({}).check(['nope'])).toBe('capability mismatch: profile resolve failed (PROFILE_NOT_FOUND)');
    expect(await checker({ config: { default: json({ requirements: {} }) } }).check()).toBe('capability mismatch: profile resolve failed (NAX_OUTPUT_UNPARSEABLE)');
  });
  test('an acp chain on a machine without acp is `protocol acp`', async () => {
    expect(await checker({ config: { cross: { transport: 'acp', providers: [], sandbox: false } } }).check(['cross'])).toBe('capability mismatch: protocol acp');
  });
  test('a provider nax does not list is missing; one it lists as unusable is unavailable; a failed listing says so', async () => {
    const needs = { config: { fast: { transport: 'native' as const, providers: ['zai'], sandbox: false } } };
    expect(await checker({ ...needs, auth: json({ source: 'file', providers: [] }) }).check(['fast'])).toBe('capability mismatch: provider zai missing');
    expect(await checker(needs).check(['fast'])).toBe('capability mismatch: provider zai unavailable');
    expect(await checker({ ...needs, auth: naxError('CREDENTIAL_FILE_UNREADABLE') }).check(['fast'])).toBe('capability mismatch: auth list failed (CREDENTIAL_FILE_UNREADABLE)');
  });
  test('a sandbox chain on a machine whose sandbox is unavailable is `sandbox`', async () => {
    expect(await checker({ config: { safe: { transport: 'native', providers: [], sandbox: true } } }).check(['safe'])).toBe('capability mismatch: sandbox');
  });
});

describe('firstMismatch (placement order: protocol, providers, sandbox)', () => {
  test('a provider problem is reported before a sandbox problem; a machine that meets everything is null', () => {
    const requirements = { transport: 'native' as const, providers: ['zai'], sandbox: true };
    expect(firstMismatch(requirements, CAPS, [{ providerId: 'zai', available: false, stored: null, ambient: false }])).toBe('capability mismatch: provider zai unavailable');
    expect(firstMismatch(requirements, { ...CAPS, sandbox: { available: true, probedAt: 't' } }, [{ providerId: 'zai', available: true, stored: null, ambient: true }])).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing tests over the fake nax and real git**

Create `apps/runner/test/unit/job-check.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssignPayload, RunnerCapabilities } from '@nathapp/fleet-protocol';
import { NaxJobCheck } from '../../src/capabilities/job-check';
import { createGit } from '../../src/executor/git';
import { HostExecutor } from '../../src/executor/host-executor';
import { jobProfilePath } from '../../src/executor/job-profile';
import { Journal } from '../../src/journal/journal';
import { createMemoryLogger } from '../../src/logger';
import { createNaxCli } from '../../src/nax/nax-cli';
import { jobDirFor } from '../../src/paths/safe-segment';
import { isolateGit, makeOrigin } from '../helpers/git-fixture';
import { NO_CREDENTIALS } from '../helpers/no-credentials';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
const FAKE = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');
const PRD = JSON.stringify({ branchName: 'feat/feat', userStories: [{ id: 'US-1' }] });
const CAPS: RunnerCapabilities = {
  nax: { version: '0.83.1-fake', protocols: ['native'] }, sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'],
};
const needs = (providers: string[], sandbox = false) => JSON.stringify({ fakeRequirements: { transport: 'native', providers, sandbox } });
beforeAll(() => { isolateGit(); });
afterAll(() => tmp.cleanup());

async function world(profiles: string[]) {
  const base = await tmp.make('jobcheck');
  const origin = await makeOrigin(base, 'origin', {
    files: {
      'README.md': 'x', '.nax/config.json': '{}\n', '.nax/features/feat/prd.json': PRD,
      '.nax/fake-profiles/needs-zai.json': needs(['zai']), '.nax/fake-profiles/needs-sandbox.json': needs([], true),
    },
  });
  const workspaceRoot = join(base, 'ws');
  const naxHome = join(base, 'naxhome');
  await mkdir(naxHome, { recursive: true });
  const assign: AssignPayload = {
    jobId: 'cjob1', command: 'RUN', repo: { provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', cloneUrl: origin.url },
    ref: 'main', feature: 'feat', planFrom: null, profiles, maxCostUsd: '5', bashMode: 'raw', gitIdentity: { name: 'koda-fleet[bot]', email: 'bot@x' },
  };
  const row = Journal.open(':memory:').insertJob({ assign, leaseEpoch: 1, repoKey: 'acme/app', jobDir: jobDirFor(workspaceRoot, assign.jobId) }).row;
  const caps = { current: CAPS };
  const jobCheck = new NaxJobCheck({ nax: createNaxCli(['bun', FAKE], naxHome), capabilities: () => caps.current });
  const ex = new HostExecutor({
    config: { workspaceRoot, naxCommand: ['bun', FAKE], naxHome }, git: createGit(), log: createMemoryLogger(), nowMs: () => Date.now(),
    sleep: async () => undefined, credentials: NO_CREDENTIALS, jobCheck,
  });
  return { naxHome, row, ex, caps };
}

describe('HostExecutor.prepare with the job check (D104), fake nax and real git', () => {
  test('no profiles: the clone\'s default config needs nothing this machine lacks', async () => {
    const w = await world([]);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: true, branch: 'feat/feat' });
  });
  test('a repo-provided profile needing a provider nax cannot serve fails before the job profile is written', async () => {
    const w = await world(['needs-zai']);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'capability mismatch: provider zai unavailable' });
    await expect(stat(jobProfilePath(w.naxHome, 'cjob1'))).rejects.toThrow();
  });
  test('a sandbox profile on a machine whose sandbox is unavailable fails', async () => {
    const w = await world(['needs-sandbox']);
    w.caps.current = { ...CAPS, sandbox: { available: false, error: 'bwrap', probedAt: CAPS.sandbox.probedAt } };
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'capability mismatch: sandbox' });
  });
  test("an unknown profile fails with nax's code", async () => {
    const w = await world(['no-such-profile']);
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'capability mismatch: profile resolve failed (PROFILE_NOT_FOUND)' });
  });
  test('Review focus 4: an untrusted clone fails with `project untrusted` before nax ever spawns', async () => {
    const w = await world([]);
    await writeFile(join(w.naxHome, 'fake-untrusted'), '');
    expect(await w.ex.prepare(w.row)).toEqual({ ok: false, reason: 'project untrusted' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/capabilities/job-check.spec.ts test/unit/job-check.spec.ts`
Expected: FAIL, `Cannot find module './job-check'` / `'../../src/capabilities/job-check'`.

- [ ] **Step 4: Write the job check**

Create `apps/runner/src/capabilities/job-check.ts`:

```ts
import type { AssignPayload, RunnerCapabilities, RunnerCredential } from '@nathapp/fleet-protocol';
import { parseNaxJson, type NaxCli } from '../nax/nax-cli';
import { checkTrust } from '../nax/trust';
import { parseAuthList, parseRequirements, type Requirements } from './nax-json';

/** D104: can this machine run the job? Asked in the clone, after checkout, before nax spawns. */
export interface JobCheck {
  /** null: the machine meets the job's needs; otherwise the job's stateReason. */
  check(assign: Pick<AssignPayload, 'profiles'>, repoDir: string): Promise<string | null>;
}

/** Static capabilities (D95) and unit specs: no post-checkout check. */
export const NO_JOB_CHECK: JobCheck = { check: async () => null };

/** Placement's order (apps/api/src/fleet/jobs/placement-rules.ts `capabilityMisfit`): protocol, providers, sandbox. */
export function firstMismatch(
  requirements: Requirements,
  caps: Pick<RunnerCapabilities, 'nax' | 'sandbox'>,
  credentials: readonly RunnerCredential[],
): string | null {
  if (!caps.nax.protocols.includes(requirements.transport)) return `capability mismatch: protocol ${requirements.transport}`;
  for (const id of requirements.providers) {
    const credential = credentials.find((c) => c.providerId === id);
    if (!credential) return `capability mismatch: provider ${id} missing`;
    if (!credential.available) return `capability mismatch: provider ${id} unavailable`;
  }
  if (requirements.sandbox && !caps.sandbox.available) return 'capability mismatch: sandbox';
  return null;
}

export interface NaxJobCheckDeps {
  readonly nax: NaxCli;
  /** The last probe report (`CapabilityReporter.latest`). */
  readonly capabilities: () => RunnerCapabilities | null;
}

/** D104, S1 spec §2.1: trust, the job's chain resolved in the clone, then the machine's report and a fresh auth listing. */
export class NaxJobCheck implements JobCheck {
  constructor(private readonly deps: NaxJobCheckDeps) {}

  async check(assign: Pick<AssignPayload, 'profiles'>, repoDir: string): Promise<string | null> {
    const trust = await checkTrust(this.deps.nax, repoDir);
    if (!trust.trusted) return trust.reason;
    const chain = assign.profiles.length > 0 ? ['--profile', assign.profiles.join(',')] : [];
    const json = parseNaxJson(await this.deps.nax.run(['config', '-d', repoDir, ...chain, '--json'], { cwd: repoDir }));
    if (!json.ok) return `capability mismatch: profile resolve failed (${json.code})`;
    const requirements = parseRequirements(json.value);
    if (!requirements) return 'capability mismatch: profile resolve failed (NAX_OUTPUT_UNPARSEABLE)';
    const caps = this.deps.capabilities();
    if (!caps) return null;   // the daemon does not start in nax mode without a first report
    const credentials = await this.credentials(repoDir, requirements.providers);
    return typeof credentials === 'string' ? credentials : firstMismatch(requirements, caps, credentials);
  }

  /** A fresh listing: a credential may have expired, or been added, since the last probe. A string is the failure. */
  private async credentials(repoDir: string, providers: readonly string[]): Promise<readonly RunnerCredential[] | string> {
    if (providers.length === 0) return [];
    const json = parseNaxJson(await this.deps.nax.run(['auth', 'list', '--json', ...providers], { cwd: repoDir }));
    const parsed = json.ok ? parseAuthList(json.value) : null;
    return parsed ? parsed.credentials : `capability mismatch: auth list failed (${json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code})`;
  }
}
```

- [ ] **Step 5: Call it from `prepare`**

In `apps/runner/src/executor/host-executor.ts`:

1. Add `import { NO_JOB_CHECK, type JobCheck } from '../capabilities/job-check';`.
2. In `HostExecutorDeps`, add:

```ts
  /** D104: nax mode only. Absent: no post-checkout check (static capabilities, unit specs). */
  readonly jobCheck?: JobCheck;
```

3. In `prepare`, directly after `if (!checkout.ok) return { ok: false, reason: checkout.reason };` insert:

```ts
      const mismatch = await (this.deps.jobCheck ?? NO_JOB_CHECK).check(assign, repoDir);   // D104
      if (mismatch !== null) return { ok: false, reason: mismatch };
```

The existing `if (cancelled()) return CANCELLED;` after the PLAN step still guards the next boundary.

- [ ] **Step 6: Wire it in the daemon**

In `apps/runner/src/daemon/daemon.ts`, add `import { NaxJobCheck } from '../capabilities/job-check';` and change the executor line to:

```ts
  const jobCheck = probed ? new NaxJobCheck({ nax, capabilities: () => reporter.latest() }) : undefined;   // D104
  const executor = options.executorFactory?.() ?? new HostExecutor({
    config, git, log, nowMs: () => now().getTime(), sleep, credentials: broker, ...(jobCheck ? { jobCheck } : {}),
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/capabilities test/unit/job-check.spec.ts test/unit/host-executor.spec.ts && bun run test && bun run type-check && bun run lint`
Expected: PASS; clean.

- [ ] **Step 8: Commit**

```bash
git add apps/runner/src/capabilities/job-check.ts apps/runner/src/capabilities/job-check.spec.ts apps/runner/test/unit/job-check.spec.ts apps/runner/src/executor/host-executor.ts apps/runner/src/daemon/daemon.ts
git commit -m "feat(runner): post-checkout capability check through nax, trust first (D104)"
```

---

### Task 8: 3b-1 deferred minors

**Files:**
- Modify: `apps/runner/src/credentials/broker.ts` (`uid` dep, re-check before listen)
- Test: `apps/runner/test/unit/broker.spec.ts`, `apps/runner/src/credentials/shim.spec.ts`, `apps/runner/test/unit/git-credential.spec.ts`

**Interfaces:**
- Consumes: `ensureSocketDir`, `SocketDirError` (`src/credentials/socket-dir.ts`).
- Produces: `BrokerDeps.uid?: number` (default `process.getuid()`); `acquire` may now return `{ ok: false, reason: 'git credentials: socket dir unsafe' }`.

- [ ] **Step 1: Write the tests**

In `apps/runner/test/unit/broker.spec.ts`, change the `node:fs/promises` import to `import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';` and add inside `describe('CredentialBroker ...')`:

```ts
  test('D109: the socket directory is checked again before every listen; opened up after start, it fails the job', async () => {
    const w = await world();
    await chmod(w.socketDir, 0o755);
    const row = w.job();
    expect(await w.broker.acquire(row, { wait: false })).toEqual({ ok: false, reason: 'git credentials: socket dir unsafe' });
    await chmod(w.socketDir, 0o700);
    expect((await w.broker.acquire(row, { wait: false })).ok).toBe(true);
    await w.broker.closeAll();
  });
```

In `apps/runner/src/credentials/shim.spec.ts`, inside `describe('runShim (D87)', ...)`:

```ts
  test('D109: a `job ended` reply still runs the real binary, without a token, and says why', async () => {
    const f = fake({ ok: false, reason: 'job ended' });
    expect(await runShim(['gh', '/s.sock', '/job/bin', '--', 'pr', 'view'], f.deps)).toBe(3);
    expect(f.spawned[0].env['GH_TOKEN']).toBeUndefined();
    expect(f.warnings).toEqual(['koda-runner: no git token for this job (job ended); running gh without one']);
  });
```

In `apps/runner/test/unit/git-credential.spec.ts`, inside `describe('runGitCred (D80)', ...)`:

```ts
  test('D109: a `reply too large` answer prints nothing and exits 0', async () => {
    const x = io(input({ protocol: 'https', host: 'github.com' }), { ok: false, reason: 'reply too large' });
    expect(await runGitCred(['/s.sock', 'get'], x)).toBe(0);
    expect(x.out).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests**

Run: `cd apps/runner && bun test test/unit/broker.spec.ts src/credentials/shim.spec.ts test/unit/git-credential.spec.ts`
Expected: the broker test FAILS (the listen succeeds in a 0755 directory); the shim and helper tests PASS already (they pin existing behaviour the 3b-1 review asked to see tested).

- [ ] **Step 3: Re-check the directory before a listen**

In `apps/runner/src/credentials/broker.ts`:

1. Change the socket-dir import to `import { SocketDirError, ensureSocketDir, socketPathFor } from './socket-dir';`.
2. In `BrokerDeps`, add:

```ts
  /** D109: the owner the socket directory must have; defaults to this process's uid. */
  readonly uid?: number;
```

3. In `acquire`, replace `await this.serve(job, sock, target);` with:

```ts
    try {
      await this.serve(job, sock, target);
    } catch (error) {
      if (error instanceof SocketDirError) return { ok: false, reason: 'git credentials: socket dir unsafe' };   // D109
      throw error;
    }
```

4. In `serve`, directly before `const pending = CredentialServer.listen(sock, () => this.reply(job, target));` insert:

```ts
    await ensureSocketDir(this.deps.socketDir, this.deps.uid ?? process.getuid?.() ?? 0);   // D109: not only at daemon start
```

5. In `apps/runner/src/daemon/daemon.ts`, pass `uid` to the broker: add `uid,` to the `new CredentialBroker({ ... })` options (the local `uid` already exists above `socketDir`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test test/unit/broker.spec.ts test/unit/host-executor-auth.spec.ts test/unit/daemon-socket-dir.spec.ts && bun run type-check && bun run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/credentials/broker.ts apps/runner/src/daemon/daemon.ts apps/runner/test/unit/broker.spec.ts apps/runner/src/credentials/shim.spec.ts apps/runner/test/unit/git-credential.spec.ts
git commit -m "fix(runner): re-check the socket directory before each listen; pin job-ended and reply-too-large (D109)"
```

---
### Task 9: systemd unit and launchd plist

**Files:**
- Create: `apps/runner/src/service/units.ts`
- Test: `apps/runner/src/service/units.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface ServiceSpec { user: string; userHome: string; runnerHome: string; command: readonly string[]; path: string }`
  - `class ServiceError extends Error`
  - `assertUserName(user: string): void`, `assertSafePath(what: string, path: string): void`, `validateSpec(spec: ServiceSpec): ServiceSpec`
  - `systemdUnit(spec): string`, `launchdPlist(spec): string`
  - `SYSTEMD_UNIT = 'koda-runner.service'`, `SYSTEMD_UNIT_PATH = '/etc/systemd/system/koda-runner.service'`, `LAUNCHD_LABEL = 'dev.koda.runner'`, `LAUNCHD_PLIST_PATH = '/Library/LaunchDaemons/dev.koda.runner.plist'`

- [ ] **Step 1: Write the failing tests**

Create `apps/runner/src/service/units.spec.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { ServiceError, launchdPlist, systemdUnit, validateSpec, type ServiceSpec } from './units';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const SPEC: ServiceSpec = {
  user: 'koda-runner', userHome: '/home/koda-runner', runnerHome: '/home/koda-runner/.koda-runner',
  command: ['/usr/local/bin/koda-runner'], path: '/home/koda-runner/.bun/bin:/usr/local/bin:/usr/bin:/bin',
};

describe('systemdUnit (design §3.3, D105)', () => {
  test('User, KillMode=process, Restart=always, no restart on exit 2, reload is SIGHUP, --home before run', () => {
    expect(systemdUnit(SPEC)).toBe([
      '# Written by koda-runner install-service.',
      '[Unit]',
      'Description=Koda fleet runner',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'User=koda-runner',
      'WorkingDirectory=/home/koda-runner/.koda-runner',
      'Environment=HOME=/home/koda-runner',
      'Environment=PATH=/home/koda-runner/.bun/bin:/usr/local/bin:/usr/bin:/bin',
      'ExecStart=/usr/local/bin/koda-runner --home /home/koda-runner/.koda-runner run',
      'ExecReload=/bin/kill -HUP $MAINPID',
      '# nax jobs run detached: a stop or restart must leave them running so the next daemon readopts them.',
      'KillMode=process',
      'Restart=always',
      'RestartSec=5',
      '# Exit 2: the server refused this runner (key revoked, protocol too old); a restart cannot fix that.',
      'RestartPreventExitStatus=2',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'));
  });
  test('a runner started from source runs bun with the entry file', () => {
    expect(systemdUnit({ ...SPEC, command: ['/home/u/.bun/bin/bun', '/repo/apps/runner/src/main.ts'] }))
      .toContain('ExecStart=/home/u/.bun/bin/bun /repo/apps/runner/src/main.ts --home /home/koda-runner/.koda-runner run');
  });
});

describe('launchdPlist (design §3.3, D105)', () => {
  const plist = launchdPlist(SPEC);
  test('UserName, AbandonProcessGroup, KeepAlive, the program arguments and the log file', () => {
    for (const fragment of [
      '<key>Label</key>\n  <string>dev.koda.runner</string>',
      '<key>UserName</key>\n  <string>koda-runner</string>',
      '<string>/usr/local/bin/koda-runner</string>\n    <string>--home</string>\n    <string>/home/koda-runner/.koda-runner</string>\n    <string>run</string>',
      '<key>AbandonProcessGroup</key>\n  <true/>',
      '<key>KeepAlive</key>\n  <true/>',
      '<key>RunAtLoad</key>\n  <true/>',
      '<key>ThrottleInterval</key>\n  <integer>10</integer>',
      '<key>HOME</key>\n    <string>/home/koda-runner</string>',
      '<key>PATH</key>\n    <string>/home/koda-runner/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>',
      '<key>StandardErrorPath</key>\n  <string>/home/koda-runner/.koda-runner/runner.log</string>',
    ]) expect(plist).toContain(fragment);
  });
  test.skipIf(process.platform !== 'darwin')('plutil accepts it', async () => {
    const file = join(await tmp.make('plist'), 'dev.koda.runner.plist');
    await writeFile(file, plist);
    const lint = Bun.spawnSync(['plutil', '-lint', file]);
    expect(lint.exitCode).toBe(0);
  });
});

describe('validateSpec (D105, Review focus 5)', () => {
  test('a clean spec passes unchanged', () => {
    expect(validateSpec(SPEC)).toEqual(SPEC);
  });
  test.each([
    ['a user name with a capital', { user: 'Koda' }],
    ['a user name with a space', { user: 'koda runner' }],
    ['a runner home with a space', { runnerHome: '/home/koda runner/.koda-runner' }],
    ['a runner home with ..', { runnerHome: '/home/koda-runner/../root' }],
    ['a relative runner home', { runnerHome: 'koda-runner' }],
    ['a binary with a quote', { command: ["/usr/local/bin/koda'runner"] }],
    ['a binary with a $', { command: ['/usr/local/bin/$HOME'] }],
    ['a PATH with an empty entry', { path: '/usr/bin::/bin' }],
    ['a PATH with a relative entry', { path: '/usr/bin:bin' }],
    ['a PATH with a %', { path: '/usr/%h/bin' }],
    ['no command at all', { command: [] }],
  ])('%s is refused, never escaped', (_what, over) => {
    expect(() => validateSpec({ ...SPEC, ...over } as ServiceSpec)).toThrow(ServiceError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/service/units.spec.ts`
Expected: FAIL, `Cannot find module './units'`.

- [ ] **Step 3: Write the renderers**

Create `apps/runner/src/service/units.ts`:

```ts
export const SYSTEMD_UNIT = 'koda-runner.service';
export const SYSTEMD_UNIT_PATH = '/etc/systemd/system/koda-runner.service';
export const LAUNCHD_LABEL = 'dev.koda.runner';
export const LAUNCHD_PLIST_PATH = '/Library/LaunchDaemons/dev.koda.runner.plist';

export interface ServiceSpec {
  readonly user: string;
  readonly userHome: string;
  readonly runnerHome: string;
  /** How to run this runner (D84 `selfCommand`): the compiled binary, or bun plus the entry file. */
  readonly command: readonly string[];
  readonly path: string;
}

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/+-]*$/;

export function assertUserName(user: string): void {
  if (!USER_NAME.test(user)) throw new ServiceError(`${JSON.stringify(user)} is not a valid user name (lowercase letters, digits, _ and -)`);
}

export function assertSafePath(what: string, path: string): void {
  if (!SAFE_PATH.test(path) || path.split('/').includes('..')) {
    throw new ServiceError(`${what} ${JSON.stringify(path)} must be an absolute path of letters, digits and . _ / + - only (no spaces, quotes or ..)`);
  }
}

/** D105: refused, never escaped: a systemd unit and a plist would need two quoting schemes. */
export function validateSpec(spec: ServiceSpec): ServiceSpec {
  assertUserName(spec.user);
  assertSafePath('the user home', spec.userHome);
  assertSafePath('--home', spec.runnerHome);
  if (spec.command.length === 0) throw new ServiceError('the runner binary is required');
  for (const part of spec.command) assertSafePath('the runner binary', part);
  const entries = spec.path.split(':');
  if (entries.some((entry) => entry === '')) throw new ServiceError('--path must be a list of absolute directories with no empty entry');
  for (const entry of entries) assertSafePath('the --path entry', entry);
  return spec;
}

/** Commander reads the program's `--home` only before the subcommand. */
const programArguments = (spec: ServiceSpec): string[] => [...spec.command, '--home', spec.runnerHome, 'run'];

export function systemdUnit(spec: ServiceSpec): string {
  return [
    '# Written by koda-runner install-service.',
    '[Unit]',
    'Description=Koda fleet runner',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${spec.user}`,
    `WorkingDirectory=${spec.runnerHome}`,
    `Environment=HOME=${spec.userHome}`,
    `Environment=PATH=${spec.path}`,
    `ExecStart=${programArguments(spec).join(' ')}`,
    'ExecReload=/bin/kill -HUP $MAINPID',
    '# nax jobs run detached: a stop or restart must leave them running so the next daemon readopts them.',
    'KillMode=process',
    'Restart=always',
    'RestartSec=5',
    '# Exit 2: the server refused this runner (key revoked, protocol too old); a restart cannot fix that.',
    'RestartPreventExitStatus=2',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/** Values need no XML escaping: `validateSpec` admits none of `<`, `>`, `&`. */
export function launchdPlist(spec: ServiceSpec): string {
  const args = programArguments(spec).map((arg) => `    <string>${arg}</string>`).join('\n');
  const log = `${spec.runnerHome}/runner.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by koda-runner install-service. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>UserName</key>
  <string>${spec.user}</string>
  <key>WorkingDirectory</key>
  <string>${spec.runnerHome}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${spec.userHome}</string>
    <key>PATH</key>
    <string>${spec.path}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/service/units.spec.ts && bun run type-check && bun run lint`
Expected: PASS (the plutil test runs on macOS only); clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/service/units.ts apps/runner/src/service/units.spec.ts
git commit -m "feat(runner): systemd unit and launchd plist for the runner service (D105)"
```

---

### Task 10: The AppArmor user-namespace check

**Files:**
- Create: `apps/runner/src/service/apparmor.ts`
- Test: `apps/runner/src/service/apparmor.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `USERNS_SYSCTL`, `APPARMOR_DIR = '/etc/apparmor.d'`, `APPARMOR_PROFILE_NAME = 'koda-runner-bwrap'`, `APPARMOR_PROFILE_PATH = '/etc/apparmor.d/koda-runner-bwrap'`, `APPARMOR_MARKER` (the first line of our file), `userNamespacesRestricted(sysctl: string | null): boolean`, `apparmorProfile(bwrapPath: string): string`, `attachesTo(text: string, binaryPath: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `apps/runner/src/service/apparmor.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { APPARMOR_MARKER, apparmorProfile, attachesTo, userNamespacesRestricted } from './apparmor';

describe('AppArmor (design §3.3, D106)', () => {
  test('the Ubuntu 24.04 restriction is the sysctl reading 1', () => {
    expect(userNamespacesRestricted('1\n')).toBe(true);
    expect(userNamespacesRestricted('0\n')).toBe(false);
    expect(userNamespacesRestricted(null)).toBe(false);   // not Linux, or an AppArmor-less kernel
  });
  test('the profile attaches to the real bwrap path, unconfined, with userns', () => {
    expect(apparmorProfile('/usr/bin/bwrap')).toBe([
      APPARMOR_MARKER,
      '# Lets bwrap create the unprivileged user namespace the nax sandbox needs on Ubuntu 24.04+.',
      'abi <abi/4.0>,',
      'include <tunables/global>',
      '',
      'profile koda-runner-bwrap /usr/bin/bwrap flags=(unconfined) {',
      '  userns,',
      '',
      '  include if exists <local/koda-runner-bwrap>',
      '}',
      '',
    ].join('\n'));
  });
  test('attachesTo sees a named or an unnamed profile on the path, and nothing else', () => {
    expect(attachesTo('abi <abi/4.0>,\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n', '/usr/bin/bwrap')).toBe(true);
    expect(attachesTo('/usr/bin/bwrap flags=(complain) {\n}\n', '/usr/bin/bwrap')).toBe(true);
    expect(attachesTo('profile x /usr/bin/bwrapper {\n}\n', '/usr/bin/bwrap')).toBe(false);
    expect(attachesTo('# /usr/bin/bwrap is not confined here\n', '/usr/bin/bwrap')).toBe(false);
    expect(attachesTo('  /usr/bin/bwrap ix,\n', '/usr/bin/bwrap')).toBe(false);   // a rule inside another profile, not an attachment
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/service/apparmor.spec.ts`
Expected: FAIL, `Cannot find module './apparmor'`.

- [ ] **Step 3: Write the module**

Create `apps/runner/src/service/apparmor.ts`:

```ts
export const USERNS_SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
export const APPARMOR_DIR = '/etc/apparmor.d';
export const APPARMOR_PROFILE_NAME = 'koda-runner-bwrap';
export const APPARMOR_PROFILE_PATH = `${APPARMOR_DIR}/${APPARMOR_PROFILE_NAME}`;
export const APPARMOR_MARKER = '# Written by koda-runner install-service --apply-apparmor.';

/** D106: Ubuntu 24.04+ sets this to 1, and bwrap then cannot create the user namespace the nax sandbox needs. */
export function userNamespacesRestricted(sysctl: string | null): boolean {
  return sysctl?.trim() === '1';
}

/** D106: the targeted form Ubuntu documents for an application that needs user namespaces. */
export function apparmorProfile(bwrapPath: string): string {
  return [
    APPARMOR_MARKER,
    '# Lets bwrap create the unprivileged user namespace the nax sandbox needs on Ubuntu 24.04+.',
    'abi <abi/4.0>,',
    'include <tunables/global>',
    '',
    `profile ${APPARMOR_PROFILE_NAME} ${bwrapPath} flags=(unconfined) {`,
    '  userns,',
    '',
    `  include if exists <local/${APPARMOR_PROFILE_NAME}>`,
    '}',
    '',
  ].join('\n');
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * D106: a profile header attached to `binaryPath` (`profile <name> <path> ... {` or `<path> ... {`). A second profile on
 * the same path would make ours fail to load, so install-service refuses instead.
 */
export function attachesTo(text: string, binaryPath: string): boolean {
  const path = escapeRegExp(binaryPath);
  return new RegExp(`^[ \\t]*(profile[ \\t]+\\S+[ \\t]+)?${path}([ \\t]+flags=\\([^)]*\\))?[ \\t]*\\{`, 'm').test(text);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/service/apparmor.spec.ts && bun run type-check && bun run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/service/apparmor.ts apps/runner/src/service/apparmor.spec.ts
git commit -m "feat(runner): detect the Ubuntu userns restriction and render a bwrap AppArmor profile (D106)"
```

---

### Task 11: `install-service` and `uninstall-service`

**Files:**
- Create: `apps/runner/src/commands/service.ts`
- Create: `apps/runner/src/service/system-deps.ts`
- Test: `apps/runner/src/commands/service.spec.ts`
- Modify: `apps/runner/src/main.ts` (two commands)
- Test: `apps/runner/test/unit/main.spec.ts` (`--help`, `--print`)

**Interfaces:**
- Consumes: Task 9 units; Task 10 AppArmor; Task 1 `parseNaxJson`; Task 2 `parseTrustCheck`; `parseRunnerConfig`, `ConfigError` (`src/config/runner-config.ts`); `firstLine` (`src/errors.ts`); `selfCommand` (`src/self-command.ts`).
- Produces:
  - `interface ExecResult { code: number; stdout: string; stderr: string }`
  - `interface ServiceDeps { platform; euid; env; selfCommand; exec; readFile; writeFile; removeFile; ownerUid; listDir; whichOnPath; realpath; log }` (see code)
  - `interface InstallOptions { user: string; home: string | undefined; binary?: string; path?: string; trustWorkspace: boolean; applyApparmor: boolean; print: boolean }`
  - `installService(options: InstallOptions, deps: ServiceDeps): Promise<void>`, `uninstallService(deps: ServiceDeps): Promise<void>` (both throw `ServiceError`)
  - `systemServiceDeps(log: (line: string) => void): ServiceDeps`

- [ ] **Step 1: Write the failing tests**

Create `apps/runner/src/commands/service.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { basename, dirname } from 'node:path';
import { APPARMOR_PROFILE_PATH, USERNS_SYSCTL } from '../service/apparmor';
import { LAUNCHD_PLIST_PATH, SYSTEMD_UNIT_PATH, ServiceError, launchdPlist, systemdUnit } from '../service/units';
import { installService, uninstallService, type ExecResult, type InstallOptions, type ServiceDeps } from './service';

const HOME = '/home/koda-runner/.koda-runner';
const WS = `${HOME}/workspace`;
const PATH = '/usr/local/bin:/usr/bin:/bin';
const RUNNER_JSON = JSON.stringify({ serverUrl: 'https://koda.example.com', workspaceRoot: WS });
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

interface World {
  readonly files: Map<string, string>;
  readonly execs: string[][];
  readonly lines: string[];
  readonly state: { trusted: boolean; failing: string | null; owner: number };
  readonly deps: ServiceDeps;
}

function world(over: Partial<ServiceDeps> = {}, files: Record<string, string> = {}): World {
  const state = { trusted: true, failing: null as string | null, owner: 1001 };
  const store = new Map(Object.entries({ [`${HOME}/runner.json`]: RUNNER_JSON, [`${HOME}/identity.json`]: '{}', ...files }));
  const execs: string[][] = [];
  const lines: string[] = [];
  const respond = (argv: readonly string[]): ExecResult => {
    const line = argv.join(' ');
    if (state.failing && line.startsWith(state.failing)) return { code: 1, stdout: '', stderr: `${state.failing}: boom\n` };
    if (line === 'getent passwd koda-runner') return ok('koda-runner:x:1001:1001::/home/koda-runner:/bin/bash\n');
    if (line.startsWith('getent passwd')) return { code: 2, stdout: '', stderr: '' };
    if (line === 'dscl . -read /Users/koda-runner UniqueID NFSHomeDirectory') return ok('NFSHomeDirectory: /Users/koda-runner\nUniqueID: 502\n');
    if (line.startsWith('dscl')) return { code: 56, stdout: '', stderr: 'eDSRecordNotFound' };
    if (line.includes(' trust check --json ')) {
      return { code: state.trusted ? 0 : 1, stdout: JSON.stringify({ root: WS, trusted: state.trusted, coveredBy: state.trusted ? WS : null }), stderr: '' };
    }
    if (line.includes(' trust add ')) {
      state.trusted = true;
      return ok(`Trusted ${WS}\n`);
    }
    return ok();
  };
  const deps: ServiceDeps = {
    platform: 'linux', euid: 0, env: { PATH }, selfCommand: ['/usr/local/bin/koda-runner'],
    exec: async (argv) => { execs.push([...argv]); return respond(argv); },
    readFile: async (path) => store.get(path) ?? null,
    writeFile: async (path, text) => { store.set(path, text); },
    removeFile: async (path) => { store.delete(path); },
    ownerUid: async () => state.owner,
    listDir: async (dir) => [...store.keys()].filter((path) => dirname(path) === dir).map((path) => basename(path)),
    whichOnPath: (command) => (['nax', 'bwrap'].includes(command) ? `/usr/bin/${command}` : null),
    realpath: async (path) => path,
    log: (line) => { lines.push(line); },
    ...over,
  };
  return { files: store, execs, lines, state, deps };
}
const options = (over: Partial<InstallOptions> = {}): InstallOptions => ({ user: 'koda-runner', home: HOME, trustWorkspace: false, applyApparmor: false, print: false, ...over });
const linuxSpec = { user: 'koda-runner', userHome: '/home/koda-runner', runnerHome: HOME, command: ['/usr/local/bin/koda-runner'], path: PATH };

describe('installService on Linux (D105)', () => {
  test('checks the user, trust as that user, writes the unit, then daemon-reload and enable --now', async () => {
    const w = world();
    await installService(options(), w.deps);
    expect(w.files.get(SYSTEMD_UNIT_PATH)).toBe(systemdUnit(linuxSpec));
    expect(w.execs).toEqual([
      ['getent', 'passwd', 'koda-runner'],
      ['sudo', '-u', 'koda-runner', '-H', 'env', `PATH=${PATH}`, 'nax', 'trust', 'check', '--json', WS],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', '--now', 'koda-runner.service'],
    ]);
    expect(w.lines.join('\n')).toContain('journalctl -u koda-runner -f');
  });
  test('an explicit naxHome in runner.json reaches nax as NAX_GLOBAL_CONFIG_DIR', async () => {
    const w = world({}, { [`${HOME}/runner.json`]: JSON.stringify({ serverUrl: 'https://koda.example.com', workspaceRoot: WS, naxHome: '/srv/nax' }) });
    await installService(options(), w.deps);
    expect(w.execs[1]).toEqual(['sudo', '-u', 'koda-runner', '-H', 'env', `PATH=${PATH}`, 'NAX_GLOBAL_CONFIG_DIR=/srv/nax', 'nax', 'trust', 'check', '--json', WS]);
  });
  test('--print prints the unit and the commands, needs no root, and changes nothing', async () => {
    const w = world({ euid: 501 });
    await installService(options({ print: true }), w.deps);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
    expect(w.execs).toEqual([['getent', 'passwd', 'koda-runner']]);
    expect(w.lines.join('\n')).toContain('KillMode=process');
    expect(w.lines.join('\n')).toContain('systemctl enable --now koda-runner.service');
  });
  test('D103: an untrusted workspace is refused without --trust-workspace, and trusted with it', async () => {
    const w = world();
    w.state.trusted = false;
    await expect(installService(options(), w.deps)).rejects.toThrow(/--trust-workspace/);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
    await installService(options({ trustWorkspace: true }), w.deps);
    expect(w.execs).toContainEqual(['sudo', '-u', 'koda-runner', '-H', 'env', `PATH=${PATH}`, 'nax', 'trust', 'add', WS, '--yes']);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(true);
  });
  test.each([
    ['not root', { deps: { euid: 501 } }, /must run as root/],
    ['a user that does not exist', { opts: { user: 'nobody-here' } }, /does not exist.*docs\/deployment\/runner\.md/s],
    ['no --home', { opts: { home: undefined } }, /--home <dir> is required/],
    ['a home that is not enrolled', { opts: { home: '/home/koda-runner/elsewhere' } }, /not an enrolled runner home/],
    ['nax not on the service PATH', { deps: { whichOnPath: () => null } }, /not on the service PATH/],
  ] as const)('%s is refused and nothing is written', async (_what, setup, message) => {
    const w = world('deps' in setup ? setup.deps : {});
    await expect(installService(options('opts' in setup ? setup.opts : {}), w.deps)).rejects.toThrow(message);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
  });
  test('a home owned by another user is refused', async () => {
    const w = world();
    w.state.owner = 0;
    await expect(installService(options(), w.deps)).rejects.toThrow(/must be owned by koda-runner/);
  });
  test('an existing unit is refused (uninstall first)', async () => {
    const w = world({}, { [SYSTEMD_UNIT_PATH]: 'old' });
    await expect(installService(options(), w.deps)).rejects.toThrow(/uninstall-service/);
    expect(w.files.get(SYSTEMD_UNIT_PATH)).toBe('old');
  });
  test('Review focus 5: a --home, --binary or --path with a space, quote or .. is refused before anything runs as root', async () => {
    for (const over of [{ home: '/home/koda runner' }, { binary: "/usr/local/bin/k'r" }, { path: '/usr/bin:/opt/../bin' }]) {
      const w = world();
      await expect(installService(options(over), w.deps)).rejects.toBeInstanceOf(ServiceError);
      expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
      expect(w.execs.filter((argv) => argv[0] !== 'getent')).toEqual([]);
    }
  });
  test('a failing systemctl is a ServiceError carrying its first stderr line', async () => {
    const w = world();
    w.state.failing = 'systemctl enable';
    await expect(installService(options(), w.deps)).rejects.toThrow(/systemctl enable --now koda-runner.service failed: systemctl enable: boom/);
  });
});

describe('installService: AppArmor on Linux (D106)', () => {
  test('restricted without --apply-apparmor: a warning, and the install goes on', async () => {
    const w = world({}, { [USERNS_SYSCTL]: '1\n' });
    await installService(options(), w.deps);
    expect(w.lines.some((line) => line.startsWith('warning:') && line.includes('--apply-apparmor'))).toBe(true);
    expect(w.files.has(APPARMOR_PROFILE_PATH)).toBe(false);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(true);
  });
  test('with --apply-apparmor: the profile for the real bwrap path is written and loaded before the unit', async () => {
    const w = world({ realpath: async () => '/usr/bin/bwrap' }, { [USERNS_SYSCTL]: '1\n' });
    await installService(options({ applyApparmor: true }), w.deps);
    expect(w.files.get(APPARMOR_PROFILE_PATH)).toContain('profile koda-runner-bwrap /usr/bin/bwrap flags=(unconfined) {');
    const parser = w.execs.findIndex((argv) => argv[0] === 'apparmor_parser');
    expect(w.execs[parser]).toEqual(['apparmor_parser', '-r', APPARMOR_PROFILE_PATH]);
    expect(parser).toBeLessThan(w.execs.findIndex((argv) => argv[0] === 'systemctl'));
  });
  test('another profile already attached to bwrap is refused; nothing is written', async () => {
    const w = world({}, { [USERNS_SYSCTL]: '1\n', '/etc/apparmor.d/bwrap-userns-restrict': 'profile bwrap /usr/bin/bwrap flags=(unconfined) {\n}\n' });
    await expect(installService(options({ applyApparmor: true }), w.deps)).rejects.toThrow(/bwrap-userns-restrict/);
    expect(w.files.has(APPARMOR_PROFILE_PATH)).toBe(false);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
  });
  test('bwrap missing from the service PATH is refused', async () => {
    const w = world({ whichOnPath: (command) => (command === 'nax' ? '/usr/bin/nax' : null) }, { [USERNS_SYSCTL]: '1\n' });
    await expect(installService(options({ applyApparmor: true }), w.deps)).rejects.toThrow(/bwrap is not on the service PATH/);
  });
});

describe('installService on macOS (D105)', () => {
  test('dscl for the user, the plist, then launchctl bootstrap system', async () => {
    const home = '/Users/koda-runner/.koda-runner';
    const w = world({ platform: 'darwin' }, {
      [`${home}/runner.json`]: JSON.stringify({ serverUrl: 'https://koda.example.com', workspaceRoot: `${home}/workspace` }), [`${home}/identity.json`]: '{}',
    });
    w.state.owner = 502;
    await installService(options({ home }), w.deps);
    expect(w.files.get(LAUNCHD_PLIST_PATH)).toBe(launchdPlist({ user: 'koda-runner', userHome: '/Users/koda-runner', runnerHome: home, command: ['/usr/local/bin/koda-runner'], path: PATH }));
    expect(w.execs.at(-1)).toEqual(['launchctl', 'bootstrap', 'system', LAUNCHD_PLIST_PATH]);
    expect(w.execs.some((argv) => argv[0] === 'apparmor_parser')).toBe(false);
  });
  test('an unsupported platform is refused', async () => {
    await expect(installService(options(), world({ platform: 'win32' }).deps)).rejects.toThrow(/macOS \(launchd\) and Linux \(systemd\)/);
  });
});

describe('uninstallService (D105)', () => {
  test('Linux: disable --now, remove the unit, daemon-reload, and unload and remove our AppArmor profile', async () => {
    const w = world({}, { [SYSTEMD_UNIT_PATH]: 'unit', [APPARMOR_PROFILE_PATH]: '# Written by koda-runner install-service --apply-apparmor.\n' });
    await uninstallService(w.deps);
    expect(w.execs).toEqual([
      ['systemctl', 'disable', '--now', 'koda-runner.service'],
      ['systemctl', 'daemon-reload'],
      ['apparmor_parser', '-R', APPARMOR_PROFILE_PATH],
    ]);
    expect(w.files.has(SYSTEMD_UNIT_PATH)).toBe(false);
    expect(w.files.has(APPARMOR_PROFILE_PATH)).toBe(false);
  });
  test('Linux: an AppArmor file we did not write is left alone', async () => {
    const w = world({}, { [SYSTEMD_UNIT_PATH]: 'unit', [APPARMOR_PROFILE_PATH]: 'someone else\n' });
    await uninstallService(w.deps);
    expect(w.files.get(APPARMOR_PROFILE_PATH)).toBe('someone else\n');
  });
  test('macOS: bootout, then remove the plist; a service that was not loaded is only a note', async () => {
    const w = world({ platform: 'darwin' }, { [LAUNCHD_PLIST_PATH]: 'plist' });
    w.state.failing = 'launchctl bootout';
    await uninstallService(w.deps);
    expect(w.execs).toEqual([['launchctl', 'bootout', 'system/dev.koda.runner']]);
    expect(w.files.has(LAUNCHD_PLIST_PATH)).toBe(false);
    expect(w.lines.some((line) => line.startsWith('note:'))).toBe(true);
  });
  test('not root is refused', async () => {
    await expect(uninstallService(world({ euid: 501 }).deps)).rejects.toThrow(/must run as root/);
  });
});
```

In `apps/runner/test/unit/main.spec.ts`:
- in `'--help lists enroll, run and status'`, add `'install-service', 'uninstall-service'` to the word list;
- add:

```ts
  test('install-service --print shows the unit for this platform and changes nothing', async () => {
    const user = process.env['USER'] ?? '';
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) return;   // the CI user name is always valid; a local one may not be
    const { stdout, code } = await cli(['--home', '/srv/koda-runner', 'install-service', '--user', user, '--print', '--path', '/usr/bin:/bin']);
    expect(code).toBe(0);
    expect(stdout).toContain(process.platform === 'darwin' ? '<key>AbandonProcessGroup</key>' : 'KillMode=process');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/runner && bun test src/commands/service.spec.ts test/unit/main.spec.ts`
Expected: FAIL, `Cannot find module './service'`; main.spec's help and print tests fail.

- [ ] **Step 3: Write the commands**

Create `apps/runner/src/commands/service.ts`:

```ts
import { join } from 'node:path';
import { parseTrustCheck } from '../capabilities/nax-json';
import { ConfigError, parseRunnerConfig } from '../config/runner-config';
import { firstLine } from '../errors';
import { parseNaxJson } from '../nax/nax-cli';
import { APPARMOR_DIR, APPARMOR_MARKER, APPARMOR_PROFILE_NAME, APPARMOR_PROFILE_PATH, USERNS_SYSCTL, apparmorProfile, attachesTo, userNamespacesRestricted } from '../service/apparmor';
import {
  LAUNCHD_LABEL, LAUNCHD_PLIST_PATH, SYSTEMD_UNIT, SYSTEMD_UNIT_PATH, ServiceError, assertSafePath, assertUserName, launchdPlist, systemdUnit, validateSpec,
  type ServiceSpec,
} from '../service/units';

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Every effect, injected: tests never write /etc or run systemctl. */
export interface ServiceDeps {
  readonly platform: string;
  readonly euid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly selfCommand: readonly string[];
  readonly exec: (argv: readonly string[]) => Promise<ExecResult>;
  /** null: missing, unreadable or a directory. */
  readonly readFile: (path: string) => Promise<string | null>;
  /** Mode 0644. */
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly ownerUid: (path: string) => Promise<number | null>;
  readonly listDir: (path: string) => Promise<string[]>;
  readonly whichOnPath: (command: string, path: string) => string | null;
  readonly realpath: (path: string) => Promise<string>;
  readonly log: (line: string) => void;
}

export interface InstallOptions {
  readonly user: string;
  readonly home: string | undefined;
  readonly binary?: string;
  readonly path?: string;
  readonly trustWorkspace: boolean;
  readonly applyApparmor: boolean;
  readonly print: boolean;
}

type Platform = 'linux' | 'darwin';

function platformOf(deps: ServiceDeps): Platform {
  if (deps.platform === 'linux' || deps.platform === 'darwin') return deps.platform;
  throw new ServiceError(`install-service supports macOS (launchd) and Linux (systemd), not ${deps.platform}`);
}

function requireRoot(deps: ServiceDeps): void {
  if (deps.euid !== 0) throw new ServiceError('this command must run as root (sudo); install-service --print shows what it would do');
}

async function run(deps: ServiceDeps, argv: readonly string[]): Promise<void> {
  const result = await deps.exec(argv);
  if (result.code !== 0) throw new ServiceError(`${argv.join(' ')} failed: ${firstLine(result.stderr) || `exit ${result.code}`}`);
}

const missingUser = (user: string): ServiceError =>
  new ServiceError(`the user ${user} does not exist; create it first (docs/deployment/runner.md, "Service user")`);

/** Design §3.3: the user must exist; creating it is the operator's documented step, never ours. */
async function lookupUser(platform: Platform, user: string, deps: ServiceDeps): Promise<{ uid: number; home: string }> {
  if (platform === 'linux') {
    const result = await deps.exec(['getent', 'passwd', user]);
    const fields = result.stdout.trim().split(':');
    if (result.code !== 0 || fields.length < 7) throw missingUser(user);
    return { uid: Number(fields[2]), home: fields[5] ?? '' };
  }
  const result = await deps.exec(['dscl', '.', '-read', `/Users/${user}`, 'UniqueID', 'NFSHomeDirectory']);
  const uid = /^UniqueID:\s*(\d+)\s*$/m.exec(result.stdout)?.[1];
  const home = /^NFSHomeDirectory:\s*(\S+)\s*$/m.exec(result.stdout)?.[1];
  if (result.code !== 0 || !uid || !home) throw missingUser(user);
  return { uid: Number(uid), home };
}

interface RunnerFiles {
  readonly workspaceRoot: string;
  readonly naxCommand: readonly string[];
  /** Only an explicit runner.json value: as root, the default (the caller's ~/.nax) would be root's. */
  readonly naxHome: string | null;
}

async function readRunnerFiles(home: string, deps: ServiceDeps): Promise<RunnerFiles> {
  const [config, identity] = await Promise.all([deps.readFile(join(home, 'runner.json')), deps.readFile(join(home, 'identity.json'))]);
  if (config === null || identity === null) {
    throw new ServiceError(`${home} is not an enrolled runner home (runner.json and identity.json); run "koda-runner enroll" as the service user first`);
  }
  try {
    const raw = JSON.parse(config) as Record<string, unknown>;
    const parsed = parseRunnerConfig(raw, {});
    return { workspaceRoot: parsed.workspaceRoot, naxCommand: parsed.naxCommand, naxHome: typeof raw['naxHome'] === 'string' ? raw['naxHome'] : null };
  } catch (error) {
    throw new ServiceError(`${join(home, 'runner.json')}: ${error instanceof ConfigError ? error.message : 'not valid JSON'}`);
  }
}

/** nax as the service user, with the service PATH (sudo's secure_path would hide nax). */
const asUser = (spec: ServiceSpec, files: RunnerFiles, args: readonly string[]): string[] => [
  'sudo', '-u', spec.user, '-H', 'env', `PATH=${spec.path}`, ...(files.naxHome ? [`NAX_GLOBAL_CONFIG_DIR=${files.naxHome}`] : []), ...files.naxCommand, ...args,
];

/** D103: the daemon refuses an untrusted workspace; installing a service that would restart-loop helps nobody. */
async function ensureTrusted(options: InstallOptions, spec: ServiceSpec, files: RunnerFiles, deps: ServiceDeps): Promise<void> {
  const check = await deps.exec(asUser(spec, files, ['trust', 'check', '--json', files.workspaceRoot]));
  const json = parseNaxJson({ ...check, timedOut: false });
  const verdict = json.ok ? parseTrustCheck(json.value) : null;
  if (verdict?.trusted) return;
  const why = verdict ? '' : ` (trust check failed: ${json.ok ? 'NAX_OUTPUT_UNPARSEABLE' : json.code})`;
  if (!options.trustWorkspace) {
    throw new ServiceError(`nax (as ${spec.user}) does not trust ${files.workspaceRoot}${why}; pass --trust-workspace to run "nax trust add ${files.workspaceRoot} --yes" as ${spec.user}, or run it yourself`);
  }
  await run(deps, asUser(spec, files, ['trust', 'add', files.workspaceRoot, '--yes']));
  deps.log(`trusted ${files.workspaceRoot} for nax as ${spec.user}`);
}

/** D106: Linux only; a warning without --apply-apparmor, a targeted bwrap profile with it. */
async function applyApparmor(options: InstallOptions, spec: ServiceSpec, deps: ServiceDeps): Promise<void> {
  if (!userNamespacesRestricted(await deps.readFile(USERNS_SYSCTL))) return;
  if (!options.applyApparmor) {
    deps.log('warning: this kernel restricts unprivileged user namespaces (Ubuntu 24.04+), so the nax sandbox (bwrap) cannot start and profiles that need it will not be placed here; re-run with --apply-apparmor to write a targeted AppArmor profile for bwrap');
    return;
  }
  const found = deps.whichOnPath('bwrap', spec.path);
  if (!found) throw new ServiceError('bwrap is not on the service PATH; install bubblewrap first');
  const bwrap = await deps.realpath(found);
  assertSafePath('the bwrap binary', bwrap);
  const others = (await deps.listDir(APPARMOR_DIR)).filter((name) => name !== APPARMOR_PROFILE_NAME);
  const texts = await Promise.all(others.map(async (name) => ({ name, text: await deps.readFile(join(APPARMOR_DIR, name)) })));
  const conflicts = texts.filter((t) => t.text !== null && attachesTo(t.text, bwrap)).map((t) => t.name);
  if (conflicts.length > 0) throw new ServiceError(`AppArmor profile(s) already attach to ${bwrap}: ${conflicts.join(', ')}; not writing ${APPARMOR_PROFILE_PATH}`);
  await deps.writeFile(APPARMOR_PROFILE_PATH, apparmorProfile(bwrap));
  await run(deps, ['apparmor_parser', '-r', APPARMOR_PROFILE_PATH]);
}

interface Plan {
  readonly spec: ServiceSpec;
  readonly uid: number;
  readonly target: string;
  readonly content: string;
  readonly commands: readonly (readonly string[])[];
}

async function planInstall(options: InstallOptions, platform: Platform, deps: ServiceDeps): Promise<Plan> {
  if (!options.home) throw new ServiceError('--home <dir> is required: the enrolled runner home of the service user');
  assertUserName(options.user);
  const account = await lookupUser(platform, options.user, deps);
  const spec = validateSpec({
    user: options.user, userHome: account.home, runnerHome: options.home,
    command: options.binary ? [options.binary] : deps.selfCommand, path: options.path ?? deps.env['PATH'] ?? '',
  });
  return platform === 'linux'
    ? { spec, uid: account.uid, target: SYSTEMD_UNIT_PATH, content: systemdUnit(spec), commands: [['systemctl', 'daemon-reload'], ['systemctl', 'enable', '--now', SYSTEMD_UNIT]] }
    : { spec, uid: account.uid, target: LAUNCHD_PLIST_PATH, content: launchdPlist(spec), commands: [['launchctl', 'bootstrap', 'system', LAUNCHD_PLIST_PATH]] };
}

async function preflight(plan: Plan, deps: ServiceDeps): Promise<RunnerFiles> {
  if ((await deps.readFile(plan.target)) !== null) throw new ServiceError(`${plan.target} already exists; run "koda-runner uninstall-service" first`);
  const files = await readRunnerFiles(plan.spec.runnerHome, deps);
  if ((await deps.ownerUid(plan.spec.runnerHome)) !== plan.uid) {
    throw new ServiceError(`${plan.spec.runnerHome} must be owned by ${plan.spec.user} (chown -R ${plan.spec.user} ${plan.spec.runnerHome})`);
  }
  const nax = files.naxCommand[0] ?? 'nax';
  if (!deps.whichOnPath(nax, plan.spec.path)) throw new ServiceError(`${nax} is not on the service PATH (${plan.spec.path}); pass --path`);
  return files;
}

/** Design §3.3, D105. */
export async function installService(options: InstallOptions, deps: ServiceDeps): Promise<void> {
  const platform = platformOf(deps);
  const plan = await planInstall(options, platform, deps);
  if (options.print) {
    deps.log(`# ${plan.target}\n${plan.content}# then:\n${plan.commands.map((c) => c.join(' ')).join('\n')}`);
    return;
  }
  requireRoot(deps);
  const files = await preflight(plan, deps);
  await ensureTrusted(options, plan.spec, files, deps);
  if (platform === 'linux') await applyApparmor(options, plan.spec, deps);
  await deps.writeFile(plan.target, plan.content);
  for (const command of plan.commands) await run(deps, command);
  deps.log(platform === 'linux'
    ? `installed ${SYSTEMD_UNIT}: logs with "journalctl -u koda-runner -f"; probe nax again with "systemctl reload koda-runner"`
    : `installed ${LAUNCHD_LABEL}: logs in ${plan.spec.runnerHome}/runner.log; probe nax again with "sudo launchctl kill HUP system/${LAUNCHD_LABEL}"`);
}

async function stopQuietly(deps: ServiceDeps, argv: readonly string[]): Promise<void> {
  const result = await deps.exec(argv);
  if (result.code !== 0) deps.log(`note: ${argv.join(' ')}: ${firstLine(result.stderr) || `exit ${result.code}`} (not loaded?)`);
}

/** D105: reverses install-service, including the AppArmor profile it wrote (and only that one). */
export async function uninstallService(deps: ServiceDeps): Promise<void> {
  const platform = platformOf(deps);
  requireRoot(deps);
  if (platform === 'linux') {
    await stopQuietly(deps, ['systemctl', 'disable', '--now', SYSTEMD_UNIT]);
    await deps.removeFile(SYSTEMD_UNIT_PATH);
    await run(deps, ['systemctl', 'daemon-reload']);
    if ((await deps.readFile(APPARMOR_PROFILE_PATH))?.startsWith(APPARMOR_MARKER)) {
      await run(deps, ['apparmor_parser', '-R', APPARMOR_PROFILE_PATH]);
      await deps.removeFile(APPARMOR_PROFILE_PATH);
    }
  } else {
    await stopQuietly(deps, ['launchctl', 'bootout', `system/${LAUNCHD_LABEL}`]);
    await deps.removeFile(LAUNCHD_PLIST_PATH);
  }
  deps.log('uninstalled; nax jobs that were running keep running until they end, with no daemon reporting them');
}
```

Create `apps/runner/src/service/system-deps.ts`:

```ts
import { chmod, lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import type { ExecResult, ServiceDeps } from '../commands/service';
import { errorMessage } from '../errors';
import { selfCommand } from '../self-command';

async function exec(argv: readonly string[]): Promise<ExecResult> {
  try {
    const proc = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: '', stderr: `${argv[0] ?? ''}: ${errorMessage(error)}` };
  }
}

/** The real effects of install-service / uninstall-service (never used by tests). */
export function systemServiceDeps(log: (line: string) => void): ServiceDeps {
  return {
    platform: process.platform,
    euid: process.geteuid?.() ?? -1,
    env: process.env,
    selfCommand: selfCommand(),
    exec,
    readFile: (path) => readFile(path, 'utf8').catch(() => null),
    writeFile: async (path, text) => {
      await writeFile(path, text, { mode: 0o644 });
      await chmod(path, 0o644);
    },
    removeFile: (path) => rm(path, { force: true }),
    ownerUid: (path) => lstat(path).then((info) => info.uid, () => null),
    listDir: (path) => readdir(path).catch(() => []),
    whichOnPath: (command, path) => Bun.which(command, { PATH: path }),
    realpath: (path) => realpath(path),
    log,
  };
}
```

- [ ] **Step 4: Register the commands**

In `apps/runner/src/main.ts`, add the imports:

```ts
import { installService, uninstallService } from './commands/service';
import { ServiceError } from './service/units';
import { systemServiceDeps } from './service/system-deps';
```

and before `await program.parseAsync(process.argv);`:

```ts
const serviceAction = async (work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    process.exitCode = fail(error.message);
  }
};

program
  .command('install-service')
  .description('Install the daemon as a system service (systemd on Linux, launchd on macOS); run with sudo and --home')
  .requiredOption('--user <name>', 'the existing OS user the daemon runs as')
  .option('--binary <path>', 'the koda-runner binary the service runs (default: this one)')
  .option('--path <PATH>', 'PATH for the service; nax, git and gh must be on it (default: this PATH)')
  .option('--trust-workspace', 'when nax does not trust the workspace root yet, trust it (nax trust add, as --user)', false)
  .option('--apply-apparmor', 'Linux 24.04+: write and load a targeted AppArmor profile so bwrap may create user namespaces', false)
  .option('--print', 'print the unit and the commands; change nothing', false)
  .action((opts: { user: string; binary?: string; path?: string; trustWorkspace: boolean; applyApparmor: boolean; print: boolean }) =>
    serviceAction(() => installService({ ...opts, home: home() }, systemServiceDeps(say))));

program
  .command('uninstall-service')
  .description('Stop and remove the service install-service wrote; run with sudo')
  .action(() => serviceAction(() => uninstallService(systemServiceDeps(say))));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/runner && bun test src/commands/service.spec.ts src/service test/unit/main.spec.ts && bun run type-check && bun run lint`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src/commands/service.ts apps/runner/src/commands/service.spec.ts apps/runner/src/service/system-deps.ts apps/runner/src/main.ts apps/runner/test/unit/main.spec.ts
git commit -m "feat(runner): install-service and uninstall-service with trust and AppArmor checks (D103, D105, D106)"
```

---
### Task 12: Integration against the real API: probed capabilities and the job check

**Files:**
- Modify: `apps/runner/test/integration/harness/world.ts` (runners in nax mode, a repo-provided profile, dispatch `profiles`)
- Create: `apps/runner/test/integration/capabilities.integration.spec.ts`

**Interfaces:**
- Consumes: Tasks 4-7 (fake nax probe files, nax mode, job check); the existing harness (`createWorld`, `World.dispatch`, `waitForJob`, `events`, `prisma`).
- Produces: `World.dispatch(input)` accepts `profiles?: string[]`; every harness runner is probed through the fake nax (no capabilities block), with machine profile `fast` (needs `deepseek`) and a stored `deepseek` credential; the seeded repo carries `.nax/fake-profiles/needs-zai.json`.

- [ ] **Step 1: Put the harness runners in nax mode**

In `apps/runner/test/integration/harness/world.ts`:

1. In the `World` interface, change the `dispatch` signature to `dispatch(input: { feature: string; command?: 'RUN' | 'PLAN'; ref?: string; planFrom?: string; profiles?: string[] }): Promise<string>;` and in its implementation add `...(input.profiles ? { profiles: input.profiles } : {}),` to the request body after the `planFrom` spread.
2. After the `for (const f of FEATURES) ...` line that fills `files`, add:

```ts
  // D104: a profile the repo provides (the fake nax reads <clone>/.nax/fake-profiles); the runners have no zai credential.
  files['.nax/fake-profiles/needs-zai.json'] = JSON.stringify({ fakeRequirements: { transport: 'native', providers: ['zai'], sandbox: false } });
```

3. In `addRunner`, replace the `await writeFile(home.configPath, JSON.stringify({ ... }));` call (the one with the `capabilities` block) with:

```ts
      const naxHome = join(dir, 'naxhome');
      await mkdir(join(naxHome, 'profiles'), { recursive: true });
      // D95, D108: no capabilities block, so the runner probes nax; the fake nax answers from these files.
      await writeFile(join(naxHome, 'profiles', 'fast.json'), JSON.stringify({ fakeRequirements: { transport: 'native', providers: ['deepseek'], sandbox: false } }));
      await writeFile(join(naxHome, 'fake-auth.json'), JSON.stringify({ providers: [{ providerId: 'deepseek', stored: { kind: 'api-key', expired: false }, ambient: false, available: true }] }));
      await writeFile(home.configPath, JSON.stringify({ serverUrl: api.url, workspaceRoot, naxHome, naxCommand: ['bun', FAKE_NAX], labels: ['harness'] }));
```

- [ ] **Step 2: Write the integration spec**

Create `apps/runner/test/integration/capabilities.integration.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createWorld, type EventView, type World } from './harness';

setDefaultTimeout(120_000);
const enabled = process.env['KODA_DB_TESTS'] === '1';
const runnerStates = (events: EventView[]) => events.filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to);

describe.skipIf(!enabled)('runner 3b-2 against the real API: capabilities from nax, the post-checkout check', () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
    await (await world.addRunner('caps')).start();
  }, 180_000);
  afterAll(async () => { await world?.close(); });

  test('D95: the runner row carries what nax reported (through enroll and the first sync), accepted by the server validator', async () => {
    const row = await world.prisma.runner.findUniqueOrThrow({ where: { name: 'caps' } });
    expect(row.capabilities).toMatchObject({
      nax: { version: '0.83.1-fake' },
      profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
      credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
      sandbox: { available: true },
      tools: { git: true, gh: true },
      executors: ['host'],
    });
  });

  test('D104: a dispatch naming the machine profile passes the check and completes', async () => {
    const id = await world.dispatch({ feature: 'fa', profiles: ['fast'] });
    const job = await world.waitForJob(id, (j) => j.state === 'COMPLETED' || j.state === 'FAILED');
    expect(job).toMatchObject({ state: 'COMPLETED', stateReason: null });
  });

  test('D104: a repo-provided profile needing a provider this machine lacks fails before nax spawns', async () => {
    const id = await world.dispatch({ feature: 'fc', profiles: ['needs-zai'] });
    const job = await world.waitForJob(id, (j) => j.state === 'FAILED');
    expect(job.stateReason).toBe('capability mismatch: provider zai unavailable');
    expect(runnerStates(await world.events(id))).not.toContain('RUNNING');
  });

  test("D104: a profile nobody defines fails with nax's code", async () => {
    const id = await world.dispatch({ feature: 'fd', profiles: ['no-such-profile'] });
    const job = await world.waitForJob(id, (j) => j.state === 'FAILED');
    expect(job.stateReason).toBe('capability mismatch: profile resolve failed (PROFILE_NOT_FOUND)');
  });
});
```

- [ ] **Step 3: Run the whole integration suite**

Run (once: `cd apps/api && bun run test:db:up`, then from the repo root `bunx turbo run build --filter=@nathapp/koda-api`): `cd apps/runner && KODA_DB_TESTS=1 bun run test:integration`
Expected: every integration spec passes, the new one included. The 3a and 3b-1 scenarios now run with probed capabilities and the job check (profiles `[]`: trust, then the default config), which is the point: they must not change behaviour. If `harness.integration.spec.ts` fails on `tools.gh`, check that the fake `gh` is on `PATH` before `addRunner` (it is installed in `buildWorld`).

- [ ] **Step 4: Commit**

```bash
git add apps/runner/test/integration/harness/world.ts apps/runner/test/integration/capabilities.integration.spec.ts
git commit -m "test(runner): integration with probed capabilities and the post-checkout check (D95, D104)"
```

---

### Task 13: Merge gate, operator guide, context, design pointers, PR text

**Files:**
- Create: `apps/runner/test/live/nax-probe.live.spec.ts`
- Modify: `apps/runner/package.json` (script `test:live`)
- Create: `docs/deployment/runner.md`
- Modify: `.nax/mono/apps/runner/context.md`
- Modify: `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md` (pointers under §3.2 and §3.3)
- Modify: generated agent files (`nax generate`, `nax generate --all-packages`)

**Interfaces:**
- Consumes: Tasks 1-11.
- Produces: the merge-gate spec, the operator guide the service errors point at ("Service user"), and the runbook Task 14 follows ("Live check").

- [ ] **Step 1: Write the merge gate (D107)**

Create `apps/runner/test/live/nax-probe.live.spec.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapabilityProbe } from '../../src/capabilities/create-probe';
import { MIN_NAX_VERSION, createNaxCli, parseNaxVersion, versionAtLeast } from '../../src/nax/nax-cli';
import { checkTrust } from '../../src/nax/trust';
import { systemNow } from '../../src/time';

/**
 * D107, slice 3 design §4 "3b merge gate": the probe against the installed, released nax, read-only (no nax run,
 * no nax plan, no trust add). Run it on each runner machine: `KODA_NAX_LIVE=1 bun run test:live`. Never in CI.
 */
const enabled = process.env['KODA_NAX_LIVE'] === '1';
// A dynamic import keeps the API's source out of the runner's type-check; bun resolves its dependencies at run time.
const API_VALIDATOR = join(import.meta.dir, '..', '..', '..', 'api', 'src', 'fleet', 'common', 'capabilities.ts');

describe.skipIf(!enabled)('merge gate: NaxCapabilityProbe against the installed nax (D107)', () => {
  const naxHome = process.env['NAX_GLOBAL_CONFIG_DIR'] ?? join(homedir(), '.nax');
  const nax = createNaxCli(['nax'], naxHome);

  test('the report from the real nax meets the version floor and passes the server validator', async () => {
    const { capabilities, warnings } = await createCapabilityProbe({ capabilities: null, naxCommand: ['nax'], naxHome }, systemNow, nax).probe();
    const version = parseNaxVersion(capabilities.nax.version);
    expect(version).not.toBeNull();
    expect(versionAtLeast(version as [number, number, number], MIN_NAX_VERSION)).toBe(true);
    const api = (await import(API_VALIDATOR)) as { parseCapabilities(raw: unknown): unknown };
    expect(() => api.parseCapabilities(capabilities)).not.toThrow();
    const summary = {
      nax: capabilities.nax, sandbox: capabilities.sandbox, profiles: Object.keys(capabilities.profiles).length,
      credentials: capabilities.credentials.map((c) => `${c.providerId}:${c.available ? 'available' : 'unavailable'}`), tools: capabilities.tools, warnings,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }, 120_000);

  test('trust check: a folder nax has never seen is untrusted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'koda-runner-live-'));
    try {
      expect(await checkTrust(nax, dir)).toEqual({ trusted: false, reason: 'project untrusted' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

In `apps/runner/package.json`, add after `"test:integration": ...`: `"test:live": "bun test test/live",`.

- [ ] **Step 2: Run the merge gate on this machine**

Run: `cd apps/runner && KODA_NAX_LIVE=1 bun run test:live`
Expected: 2 pass. The printed summary shows nax `0.83.1` (or newer), the first 64 of this machine's profiles (warnings name the skipped ones, `otel` among them unless `OPENOBSERVE_TOKEN` is set), and `sandbox.available: true` on macOS. Keep the summary for the PR body. If the validator rejects the report, stop and report the reason: the probe has produced something the server would 400.

Also run `cd apps/runner && bun run test` and confirm the live spec is skipped there (it is not under `src` or `test/unit`).

- [ ] **Step 3: Write the operator guide**

Create `docs/deployment/runner.md`:

````markdown
# Koda runner: install and operate

`koda-runner` runs nax jobs that koda dispatches. It runs as a service under a dedicated OS user, on macOS
(launchd) or Linux (systemd). Design: `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md`.

## Requirements

- macOS or Linux, arm64 or x64.
- git 2.30 or newer; `gh` (GitHub) or `glab` (GitLab) for the pull request nax opens.
- nax **0.83.1 or newer** on the service user's PATH. The runner refuses to start with an older nax.
- Linux: `bwrap` (bubblewrap) for the nax sandbox.

## Service user

The runner never creates users. Create one, with a home directory.

macOS (pick an unused id: `dscl . -list /Users UniqueID`):

```bash
sudo dscl . -create /Users/koda-runner
sudo dscl . -create /Users/koda-runner UserShell /bin/zsh
sudo dscl . -create /Users/koda-runner UniqueID 550
sudo dscl . -create /Users/koda-runner PrimaryGroupID 20
sudo dscl . -create /Users/koda-runner NFSHomeDirectory /Users/koda-runner
sudo mkdir -p /Users/koda-runner && sudo chown koda-runner:staff /Users/koda-runner
```

Linux:

```bash
sudo useradd --create-home --shell /bin/bash koda-runner
```

As that user (`sudo -u koda-runner -H -i`), install bun and nax, and give nax its provider credentials
(`nax auth login <provider>` or `nax auth import`). koda never sees them.

## Enroll

An admin creates an enrollment token in koda. As the service user:

```bash
koda-runner enroll --server https://koda.example.com --token ke_...
```

This writes `~/.koda-runner/runner.json` and `identity.json` and reports what nax says this machine can run. Leave
`runner.json` without a `capabilities` block: the runner probes nax at start, every 10 minutes and on SIGHUP. A block
there overrides the probe.

## Trust the workspace

nax refuses to run in a folder it does not trust. Every clone lives under the runner's `workspaceRoot`
(default `~/.koda-runner/workspace`), so one entry covers them all. Trusting it means: any repository an admin
registers in koda may run its code on this machine. As the service user:

```bash
nax trust add ~/.koda-runner/workspace --yes
```

The daemon refuses to start until this is done; `install-service --trust-workspace` runs it for you.

## Install the service

Look first, then install:

```bash
sudo koda-runner --home /Users/koda-runner/.koda-runner install-service --user koda-runner \
  --path /Users/koda-runner/.bun/bin:/usr/local/bin:/usr/bin:/bin --print
sudo koda-runner --home /Users/koda-runner/.koda-runner install-service --user koda-runner \
  --path /Users/koda-runner/.bun/bin:/usr/local/bin:/usr/bin:/bin
```

It checks the user, the enrolled home (owned by that user), nax on `--path`, and workspace trust, then writes
`/etc/systemd/system/koda-runner.service` (`systemctl enable --now`) or
`/Library/LaunchDaemons/dev.koda.runner.plist` (`launchctl bootstrap system`). Paths with spaces or quotes are
refused.

A restart or stop leaves running nax jobs alone (`KillMode=process`, `AbandonProcessGroup`); the next daemon
re-adopts them. Exit code 2 (the server refused the runner) is not restarted on Linux.

### Linux 24.04 and newer: AppArmor

Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`, which stops `bwrap`, so the nax sandbox is
unavailable and profiles that need it are not placed here. `install-service` warns about it. With
`--apply-apparmor` it writes `/etc/apparmor.d/koda-runner-bwrap`, which lets `bwrap` create user namespaces for
every user on the machine, and loads it with `apparmor_parser -r`. It refuses when another profile already
attaches to `bwrap`. Check afterwards, as the service user: `nax sandbox probe --json` reports `available: true`.

## Operate

| Task | Linux | macOS |
|:--|:--|:--|
| Logs | `journalctl -u koda-runner -f` | `tail -f ~koda-runner/.koda-runner/runner.log` |
| Probe nax again (after changing nax profiles or credentials) | `sudo systemctl reload koda-runner` | `sudo launchctl kill HUP system/dev.koda.runner` |
| Restart | `sudo systemctl restart koda-runner` | `sudo launchctl kickstart -k system/dev.koda.runner` |
| Status | `sudo -u koda-runner -H koda-runner status` | same |
| Remove | `sudo koda-runner uninstall-service` | same |

A job the machine cannot run fails before nax starts, with a `stateReason` such as
`capability mismatch: provider zai unavailable` or `project untrusted`.

## Live check (release gate)

Run once per release of the runner, by a person, with approval: steps 4 and 5 start billed nax runs.

1. Both machines (one macOS, one Linux 24.04) have nax 0.83.1 or newer. In a koda checkout on each:
   `cd apps/runner && KODA_NAX_LIVE=1 bun run test:live` (read-only; the merge gate).
2. Build the binaries: `cd apps/runner && bun run build:all`; copy `dist/koda-runner-<platform>` to each machine as
   `/usr/local/bin/koda-runner`.
3. On each machine: service user, enroll, trust, install-service (Linux: `--apply-apparmor` if warned). In koda's
   admin API, each runner shows online with probed capabilities.
4. Dispatch a PLAN of a trivial feature pinned to the macOS runner, then a RUN of it pinned to the Linux runner
   (and the reverse). Each ends COMPLETED; the RUN opens a pull request through the GitHub App.
5. During a RUN, restart the service (`systemctl restart` / `launchctl kickstart -k`). The nax process survives
   (`ps -p <pid>`), the log shows a READOPT, and the job still completes.
6. Dispatch with a profile that needs a provider neither machine has: the job fails with `capability mismatch`
   and no nax process starts.
````

- [ ] **Step 4: Update the runner context**

In `.nax/mono/apps/runner/context.md`:

- Architecture block: change the `src/main.ts` line to
  `src/main.ts          koda-runner run | enroll | status | install-service | uninstall-service (git-cred and shim are internal: git and the job shims call them)`;
  replace the `src/capabilities/` line with
  `src/capabilities/    CapabilityProbe seam: NaxCapabilityProbe (nax JSON) or StaticCapabilityProbe (runner.json override); JobCheck after checkout`;
  and add after it
  `src/nax/            NaxCli (read-only JSON commands, 30 s timeout), the 0.83.1 floor, trust check`
  `src/service/        systemd unit, launchd plist, AppArmor profile for bwrap (install-service)`
- Rules, add:
  `- Capabilities come from nax (`config --profile --json`, `auth list --json`, `sandbox probe --json`); the runner maps nax's documents and never re-derives nax's rules. A report must pass the server validator whole (64 profiles, 16 providers each, 64 credentials), so the probe drops what does not fit and warns instead.`
  `- nax 0.83.1 or newer. The daemon refuses to start without it, or while nax does not trust `workspaceRoot`; the runner never trusts a folder itself. After checkout, a job whose needs the machine does not meet fails with `project untrusted` or `capability mismatch: ...` before nax spawns.`
  `- `install-service` and `uninstall-service` do every effect through `ServiceDeps`; tests never write /etc or /Library and never run systemctl, launchctl, sudo or apparmor_parser.`
- Testing, add:
  `- Unit tests inject nax (`FakeNaxCli`, `test/helpers/fake-nax-cli.ts`) and `toolWorks`; they never depend on what the machine has installed. The fake nax process answers the probe commands from files in its nax home (`test/fixtures/fake-nax-probe.ts`). `test/live/` (`KODA_NAX_LIVE=1 bun run test:live`) is the merge gate against the installed nax, never in CI.`

- [ ] **Step 5: Design pointers**

In `docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md`, add under the `### 3.2 Capability probe (`NaxCapabilityProbe`)` heading:

```markdown
> **Amended by plan 3b-2 (D95-D104):** runner.json `capabilities` stays as an optional override. Machine profiles
> are the first 64 by name; a profile that fails to resolve is skipped with a warning rather than rejecting the
> report; a failed `auth list` reports the needed providers unavailable. nax 0.83.1 or newer is required and the
> daemon refuses to start without it. nax's trust gate (#2293) adds a start check on `workspaceRoot` and a per-job
> `project untrusted` check before the capability check. `nax sandbox probe --json` exists (nax 0.83.0), so the
> "until that command exists" fallback is gone.
```

and under the `### 3.3 Service units` heading:

```markdown
> **Amended by plan 3b-2 (D103, D105, D106):** `install-service` needs `--home` and `--user`, refuses paths it would
> have to quote, checks nax trust of the workspace as the service user (`--trust-workspace` adds it), and the units add
> `ExecReload` (SIGHUP re-probe) and `RestartPreventExitStatus=2`. Operator guide: `docs/deployment/runner.md`.
```

- [ ] **Step 6: Regenerate the agent files**

Run: `nax generate && nax generate --all-packages` (from the repo root; local and free)
Expected: `apps/runner/AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `codex.md` change to match the context; the root files do not change.

- [ ] **Step 7: Full verification**

Run: `cd apps/runner && bun run type-check && bun run lint && bun run test && KODA_DB_TESTS=1 bun run test:integration && KODA_NAX_LIVE=1 bun run test:live`
Expected: all clean and passing.

- [ ] **Step 8: Commit**

```bash
git add apps/runner/test/live/nax-probe.live.spec.ts apps/runner/package.json docs/deployment/runner.md .nax/mono/apps/runner/context.md docs/superpowers/specs/2026-09-30-fleet-s1-slice-3-runner-design.md apps/runner/AGENTS.md apps/runner/CLAUDE.md apps/runner/GEMINI.md apps/runner/codex.md
git commit -m "docs(fleet): runner operator guide, merge gate, context and design updates (3b-2)"
```

- [ ] **Step 9: PR text (a human opens the PR)**

Title: `feat(fleet): S1 slice 3b-2 — nax capability probe, post-checkout check, service install`

Body (fill the merge-gate summary from Step 2):

```markdown
## Summary

Slice 3b-2 (design §3.2, §3.3): the runner reports what nax says its machine can run, refuses a job it cannot run before nax starts, and installs as a service.

- `NaxCapabilityProbe`: `nax --version`, `config --profile <p> --json` per machine profile (first 64 by name), `auth list --json`, `sandbox probe --json`, `acpx`/`git`/`gh`/`glab`. At start (nax 0.83.1 or newer, or the daemon does not start), every 10 minutes and on SIGHUP; sent when the hash changes.
- nax trust (#2293): the daemon refuses an untrusted `workspaceRoot` and prints the `nax trust add` command; each job re-checks its clone.
- Post-checkout check: the job's chain resolved in the clone by nax, compared with the machine report and a fresh auth listing: `project untrusted` / `capability mismatch: ...`, before nax spawns.
- `install-service` / `uninstall-service`: systemd unit or launchd plist (`KillMode=process` / `AbandonProcessGroup`), user, home, trust and nax checks, `--trust-workspace`, and on Ubuntu 24.04+ the AppArmor userns check with `--apply-apparmor`.
- 3b-1 minors: the socket directory is re-checked before each listen; `job ended` and `reply too large` are pinned by tests.

Decisions D95-D109 are in the plan's register; the design carries pointers. Operator guide: `docs/deployment/runner.md`.

## Merge gate (D107)

`KODA_NAX_LIVE=1 bun run test:live` on this machine, nax <version>: <summary>.

## Test plan

- [x] Unit: nax JSON mapping, the probe (profile cap, failing profiles, failed listing, sandbox, version floor), reporter serialisation and warnings, trust, the job check (every reason), unit and plist rendering, AppArmor detection, install and uninstall with every effect injected.
- [x] The fake nax as a real process: probe end to end; HostExecutor.prepare with the job check over real git.
- [x] Integration against the real API: probed capabilities on the runner row, a matching job completes, a mismatch and an unknown profile fail before spawn; all 3a/3b-1 scenarios unchanged.
- [x] Merge gate against the released nax on this machine.
- [ ] Live check (docs/deployment/runner.md, "Live check"): two machines, service restart with a running job, PR through the GitHub App.
```

---

### Task 14: Live check (a person runs it; approval at launch)

**Files:** none in the repo; results go to the PR and the fleet SSOT doc (`projects/koda/koda-fleet-platform-design-2026-09-13.md` §9.15).

This is not a subagent task. It needs a koda API both machines can reach (home server over VPN), the GitHub App configured for a test repository with a trivial spec, one macOS and one Linux 24.04 machine, and the user's explicit approval before step 4 of the guide's "Live check" (PLAN and RUN are billed nax runs).

- [ ] **Step 1:** Follow `docs/deployment/runner.md`, "Live check", steps 1-3 (read-only and setup; no billing).
- [ ] **Step 2:** Ask the user for approval to dispatch the PLAN and RUN jobs. Only with that approval, run steps 4-6.
- [ ] **Step 3:** Record per machine: nax version, the merge-gate summary, the AppArmor outcome on Linux, job ids and final states, the PR URL, and the restart result (nax pid before and after, READOPT line). Put them in the PR body's live-check line and in §9.15 of the SSOT doc.

---

## Self-review

**Spec coverage** (slice 3 design §3.2, §3.3, §4; S1 spec §2.1):

| Requirement | Task |
|:--|:--|
| §3.2 probe at boot, every 10 minutes, on SIGHUP; sent when the hash (without probedAt) changes | 3 (reporter), 6 (schedule) |
| §3.2 `nax --version` | 1, 3 |
| §3.2 machine profiles, excluding `koda-job-*`, at most 64, resolved from an empty temp dir, failures skipped with a warning | 3 |
| §3.2 credentials from `auth list --json <union>` as `RunnerCredential[]` | 2, 3 |
| §3.2 `nax.protocols`: native, plus acp when `acpx --version` works | 3 |
| §3.2 tools by `--version` | 3 |
| §3.2 sandbox from `nax sandbox probe --json` | 2, 3 |
| §3.2 post-checkout check with the full chain in the clone, `capability mismatch: <detail>` | 7 |
| §3.3 systemd unit (`User`, `KillMode=process`, `Restart=always`) and launchd plist (`UserName`, `AbandonProcessGroup`, `KeepAlive`); user creation documented, not automated; `uninstall-service` | 9, 11, 13 |
| §3.3 Linux 24.04 AppArmor detection and `--apply-apparmor` | 10, 11 |
| §3.3 restart test per platform (a running nax survives) | 14 (live check step 5) |
| §4 unit: probe mapping from nax JSON fixtures, unit/plist generation | 2, 3, 9 |
| §4 3b merge gate against released nax | 13 |
| §4 live check (billed, approval at launch) | 14 |
| 3b-1 deferred minors | 8 |
| nax trust gate (#2293, released in 0.83.1 after the design) | 6, 7, 11 |

**Deliberately not covered:** the per-report 64 KiB server limit is not enforced by the runner (64 profiles of at most 16 providers and 64 credentials stay far below it); `events.jsonl` and account labels stay out of scope (design "Out of scope"); log rotation for the macOS `runner.log` is left to the operator.

**Placeholder scan:** no step says "TBD" or "similar to Task N"; every code step carries the code. The PR body's merge-gate line is filled from Task 13 Step 2's output by design.

**Type consistency:** `ProbeResult`/`CapabilityProbe` (Task 3) are what `StaticCapabilityProbe`, `NaxCapabilityProbe`, `createCapabilityProbe` (Task 5) and `enroll` use; `CapabilityReporter.refresh(): Promise<boolean>` and `latest()` (Task 3) are what the daemon (Task 6) and `NaxJobCheck` (Task 7) call; `NaxCli`/`NaxResult`/`parseNaxJson` (Task 1) are used unchanged by Tasks 3, 6, 7, 11 and the `FakeNaxCli` helper; `JobCheck.check(assign, repoDir)` (Task 7) matches the `HostExecutor` call; `ServiceDeps`/`InstallOptions` (Task 11) match `systemServiceDeps` and `main.ts`.

**Review Focus:** 1 (profile cap and failing profile) Task 3 and Task 13; 2 (hanging nax) Task 1 and Task 3; 3 (nax gone under a running daemon) Tasks 3 and 6; 4 (trust missing) Tasks 6 and 7; 5 (unsafe operator paths) Tasks 9 and 11.
