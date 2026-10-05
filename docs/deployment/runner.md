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

Every command it runs is bounded: the nax trust calls get 30 s, everything else 120 s, and a timeout is reported as
the failure it is rather than a hang. When a check cannot be completed — nax not on the service user's `PATH`, or
`/etc/apparmor.d` unreadable — it says so instead of assuming there is nothing to find.

A restart or stop leaves running nax jobs alone (`KillMode=process`, `AbandonProcessGroup`); the next daemon
re-adopts them. Exit code 2 (the server refused the runner) is not restarted on Linux.

### Service environment

launchd and systemd do not load shell startup files (`.zshrc`, `.bashrc`, etc.). Installing the runner as a
service does not copy the environment of the terminal used to enroll it. Set `--path` explicitly, and provide
any nax plugin credentials separately. Never put tokens in the generated, world-readable plist/unit or in
`runner.json`.

Both platforms support a wrapper through the existing `naxCommand` setting. As the service user, create a
private directory and a credentials file (directory mode `0700`, file mode `0600`, owned by that user):

```bash
mkdir -p ~/.config/koda-runner
chmod 700 ~/.config/koda-runner
install -m 600 /dev/null ~/.config/koda-runner/nax.env
```

Edit `nax.env` privately, using shell assignments for the variables your resolved nax configuration needs,
for example `NAX_TELEGRAM_TOKEN='...'` and `NAX_TELEGRAM_CHAT_ID='...'`. Treat this file as trusted shell code;
do not source a repository-controlled file or copy your whole shell startup file.

Create `~/.config/koda-runner/nax-service` with mode `0700`:

```sh
#!/bin/sh
set -eu
set -a
. "$HOME/.config/koda-runner/nax.env"
set +a
# Adapt these checks to the plugins this runner uses. They run for probe commands too.
: "${NAX_TELEGRAM_TOKEN:?NAX_TELEGRAM_TOKEN is required in the service env file}"
: "${NAX_TELEGRAM_CHAT_ID:?NAX_TELEGRAM_CHAT_ID is required in the service env file}"
exec /absolute/path/to/nax "$@"
```

Use the wrapper's **absolute path** in `runner.json`, for example:

```json
{ "naxCommand": ["/Users/koda-runner/.config/koda-runner/nax-service"] }
```

Merge that setting into the existing config. The wrapper is used by the startup/HUP capability probe,
post-checkout job checks, and PLAN/RUN processes. It inherits the runner's credential-filtered environment;
do not add GitHub/GitLab tokens to this file, since git credentials belong to the per-job broker.
Changing the file affects the next nax invocation. After configuring the wrapper, restart the service so
the daemon reloads `runner.json`, then request a capability refresh when credentials change. Already running
jobs keep their original environment. Test the wrapper as the service user with the service PATH before
dispatching a job; `nax config --json` can resolve config but does **not** initialize interaction plugins.
The wrapper's explicit checks catch missing required variables without contacting Telegram or billing a model.
A general plugin-initialization dry probe requires nax support; koda does not duplicate plugin-specific rules.

If PLAN produces no PRD, or RUN produces no status file, the runner emits an error lifecycle event containing
the last five non-empty lines of `nax.stderr` (at most 800 characters, secrets masked). The short failure reason
stays stable; inspect the job's lifecycle events for the underlying startup error. Full logs remain available
through the log viewer and run bundle under their existing access controls.

### Linux 24.04 and newer: AppArmor

Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`, which stops `bwrap`, so the nax sandbox is
unavailable and profiles that need it are not placed here. `install-service` warns about it. With
`--apply-apparmor` it writes `/etc/apparmor.d/koda-runner-bwrap`, which lets `bwrap` create user namespaces for
every user on the machine, and loads it with `apparmor_parser -r`. It refuses when another profile already
attaches to `bwrap` — and when it cannot read `/etc/apparmor.d` to find out, because a conflict it cannot see would
make the profile fail to load. Check afterwards, as the service user: `nax sandbox probe --json` reports `available: true`.

## Bash approvals (S1.5)

A job dispatched with `bashMode: gated` or `escalate` relays nax's bash approval asks to the koda approvals inbox.

- Upgrade the **API first**: it accepts protocol v1 and v2. A v2 runner against an older API gets 426 and stops.
- The runner reports the relay only with nax 0.83.0 or later. Placement never sends a gated/escalate job to a runner
  without it (misfit `approvals_relay`; a pinned dispatch to such a runner is refused).
- For each such job the runner listens on `127.0.0.1` on a free port and writes the address and a per-job secret into
  `~/.nax/profiles/koda-job-<id>.json` (mode 0600). Nothing listens on other interfaces.
- The repo's nax config needs `Bash(...)` allow rules for the stages that should run commands; a stage without one
  never gets the Bash tool and never asks.
- If the daemon is down when nax asks, nax denies the command (it is not queued). After a restart the receiver
  re-binds its port; if that port was taken meanwhile, pending asks time out and are denied.
- An unanswered ask is denied at the job's `approvalTimeoutSec` (default 600 s).
- Choose the mode per job: the web dispatch form and schedule dialog have a "Shell command approvals" select (RUN only)
  and an ask timeout in minutes; the CLI takes `--bash-mode gated|escalate` and `--approval-timeout <seconds>` on
  `koda fleet dispatch`, `koda fleet schedule add` and `schedule edit`.
- Answer asks in the project's approvals inbox (`/<project>/fleet/approvals`) or with
  `koda fleet approval decide <approvalId> --decision allow|allow_for_job|deny --project <slug>` (find ids with
  `koda fleet approval list --project <slug>`; without `--project` the CLI uses the global-admin routes). Project
  developers and admins may answer; the job page
  shows "Waiting for approval" while an ask is open, and the inbox shows whether the runner delivered the answer.
- An answer that reaches the runner after nax's deadline is not sent (`ask_expired`): nax has already denied it.

## Run logs (S2a)

A runner with protocol v3 streams nax's run log, stdout and stderr to koda while the job runs; nothing is sampled.

- Upgrade the **API first**: it accepts protocol v1, v2 and v3. A v3 runner against an older API gets 426 at enroll and
  sync and stops. Deploy the API and web of the same release before any v3 runner: until the web has the log viewer,
  a v3 job shows no log lines anywhere but `koda fleet job logs`.
- Read a job's logs on its page (Logs) at `/<project>/fleet/jobs/<id>/logs`: tabs for the run log, stdout and stderr,
  an attempt picker, and filters (minimum level, story, stage, role, text) that run on the server and live in the URL.
  While the job runs the viewer follows new lines; scroll up to stop, "Jump to latest" to resume. A filtered search
  reads at most 2 MiB per request and asks before reading further ("Keep searching"). Download saves a whole stream.
- A stream the runner could not finish uploading is filled from the job's bundle after it arrives; the viewer says
  "Filled from the bundle". A stream cut at `FLEET_LOG_MAX_BYTES` (256 MiB) keeps its full text only in the bundle.
- Logs, bundles and `log` timeline events of jobs that ended more than `FLEET_LOG_RETENTION_DAYS` (default 30, `0`
  keeps them) days ago are deleted at 04:45 every night; the job page then shows "Bundle expired".
- Unbilled check of the whole path on one machine (real daemon process, fake nax, ~50 MiB of logs, two daemon
  kills): `cd apps/api && bun run test:db:up && cd ../.. && bunx turbo run build --filter=@nathapp/koda-api`, then
  `cd apps/runner && KODA_DB_TESTS=1 KODA_LOG_LIVE=1 bun test test/live/log-shipping.live.spec.ts`. With
  `KODA_LOG_LIVE_KEEP=1` it leaves the stack up and prints how to open the web viewer on it.

## Operate

| Task | Linux | macOS |
|:--|:--|:--|
| Logs | `journalctl -u koda-runner -f` | `tail -f ~koda-runner/.koda-runner/runner.log` |
| Probe nax again (after changing nax profiles or credentials) | `sudo systemctl reload koda-runner` | `sudo launchctl kill HUP system/dev.koda.runner` |
| Restart | `sudo systemctl restart koda-runner` | `sudo launchctl kickstart -k system/dev.koda.runner` |
| Status | `sudo -u koda-runner -H koda-runner status` | same |
| Remove | `sudo koda-runner uninstall-service` | same |

A job the machine cannot run fails before nax starts, with a `stateReason` such as
`capability mismatch: provider zai unavailable` or `project untrusted`. A provider the machine simply cannot report
is `unavailable` (the job can be placed elsewhere), never `missing`.

The runner reports what this machine can really do, bounded by what the server accepts: at most 64 profiles, 16
providers each, 64 credentials, and 64 KiB for the whole report. Anything that does not fit is dropped and named in
`journalctl` as a capability-probe warning, because a report the server rejects leaves the runner unplaceable.

## Operate from the CLI

Runner and repo-registry commands need a global-admin user's access token (`KODA_API_KEY=<token>`); dispatch and
job commands need project membership (dispatch, cancel others' jobs and requeue need DEVELOPER or higher). Budget
commands without `--project` (global and runner policies) need the same admin token; project and repo budgets need
project ADMIN. Analytics commands need project membership; `koda fleet ingest …` and `koda fleet analytics spend
--all-projects` need the global-admin token.

```bash
koda fleet runner enroll-token --label linux       # prints the token once and the koda-runner enroll line
koda fleet runner list                             # online, enabled, labels, capacity, nax version, boot age
koda fleet runner disable <runnerId>               # drain: running jobs finish, nothing new is placed
koda fleet repo add acme/app --provider github     # GitLab subgroups: group/sub/app
koda fleet repo check <repoId>                     # exit 1 and a reason when koda can no longer broker git
koda fleet dispatch --repo acme/app --feature login --max-cost 5 --profile fast
koda fleet dispatch --repo acme/app --feature login --max-cost 2 --plan docs/specs/login.md --pin box-1
koda fleet dispatch --repo acme/app --feature login --max-cost 5 --bash-mode escalate --approval-timeout 900
koda fleet job list --state RUNNING
koda fleet job show <jobId>
koda fleet job cancel <jobId>
koda fleet job bundle <jobId> --out login.tar.gz
koda fleet job logs <jobId> --follow               # nax run log as it streams; --stream stdout|stderr, --level warn, --grep text
koda fleet budget list --project web                # spend against amount; WARN / PAUSED state
koda fleet budget set --scope project --window month --amount 50 --project web
koda fleet budget resume <policyId> --amount 80 --project web
koda fleet approval list                            # pending first; add --page / --size
koda fleet approval show <approvalId>               # a pending budget override lists its re-queue candidates
koda fleet approval decide <approvalId> --decision raise_budget_and_resume --amount 80 --project web
koda fleet schedule add --repo acme/app --feature login --cron "0 9 * * 1-5" --timezone Asia/Singapore --max-cost 5
koda fleet schedule list                            # next fire, or disabled (completed / no_progress / ...)
koda fleet schedule show <scheduleId>               # the template and the last 10 jobs it dispatched
koda fleet schedule disable <scheduleId>
koda fleet analytics spend --group-by stage         # where the money goes; --bucket, --from/--to, --all-projects (admin)
koda fleet analytics quality                        # first pass, attempts, reviews, finish outcomes, escalation reasons
koda fleet analytics stories --sort attempts        # most looping stories; jobs = most expensive jobs with ledger drift
koda fleet job analytics <jobId>                    # cost by stage/role/model, stories, reviews, live vs ledger
koda fleet ingest status --status failed            # bundle ingest health (admin); backfill; rerun <jobId> | --all
```

`--label` and `--pin` are exclusive. A dispatch for a feature that already has an active job on the repo prints
that job's id instead of starting a second one. A schedule dispatches one RUN of its feature at each fire,
continues it on whichever runner is free, and disables itself when the feature completes, when its finish fails
with every story passed, or after three runs in a row without a newly passed story.

Budgets are also managed on the web: global and runner policies on `/admin/fleet/budgets` (global admins), project and
repo policies on `/<project>/fleet/budgets` (members read; project ADMINs add, edit, delete and resume). A paused or
past-warn policy that covers a project shows as a banner on that project's fleet pages. The CLI and the web call the same
routes, so a pause resumed in one shows in the other within 30 seconds. A hard stop pauses the policy, cancels its
**queued** jobs, and now also raises an approval that has to be answered. A job that a runner already took
(ASSIGNED or RUNNING) is only stopped when the policy's `runningJobs` is `cancel`; under the default `finish` it runs
to completion and keeps billing, so a hard stop is not a kill switch for work already in flight.

A global or project ADMIN answers the approval with `koda fleet approval decide`: `koda fleet approval list --status
pending` finds it, `koda fleet approval show <approvalId>` shows what it wants, and `decide` either
`--decision keep_paused` or `--decision raise_budget_and_resume --amount <usd>` — the latter clears the pause and
re-queues the candidates named with `--requeue` (their job ids come from `show`; `--requeue all` is refused once the
candidate list is too long to be shown in full). `koda fleet budget resume` answers it too and resumes the policy,
but it needs `--amount`: without one the amount stays at the value the hard stop fired on, and a resume is only
accepted when the amount is above this window's spend.

Answer the override in the web: the header badge counts pending approvals, the jobs-list banner has a "Review
override" link, and `/<project>/fleet/approvals` (project and repo budgets) or `/admin/fleet/approvals` (fleet-wide
and runner budgets) lists them. "Raise and resume" takes a new limit above the spend and re-queues the ticked jobs the
pause cancelled before they started; "Keep paused" leaves the pause (resume later from the budgets page).

Schedules are also managed on the web: `/<project>/fleet/schedules` lists a project's schedules with their next fire in
the schedule's timezone and the reason a disabled one stopped; a schedule's page shows its template, the cost so far and
every run it dispatched (stories passed against the previous run, cost, merged fires, progress push, stop reason).
Project DEVELOPERs create schedules; the owner or a project ADMIN edits, enables, disables and deletes them. A job
dispatched by a schedule links back to it.

`FLEET_TEST_HOOKS=true` exposes a test-only route that fires a schedule at once; it is ignored when `NODE_ENV` is
`production`. Leave it unset outside the Playwright suite.

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
