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

### Linux 24.04 and newer: AppArmor

Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`, which stops `bwrap`, so the nax sandbox is
unavailable and profiles that need it are not placed here. `install-service` warns about it. With
`--apply-apparmor` it writes `/etc/apparmor.d/koda-runner-bwrap`, which lets `bwrap` create user namespaces for
every user on the machine, and loads it with `apparmor_parser -r`. It refuses when another profile already
attaches to `bwrap` — and when it cannot read `/etc/apparmor.d` to find out, because a conflict it cannot see would
make the profile fail to load. Check afterwards, as the service user: `nax sandbox probe --json` reports `available: true`.

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
project ADMIN.

```bash
koda fleet runner enroll-token --label linux       # prints the token once and the koda-runner enroll line
koda fleet runner list                             # online, enabled, labels, capacity, nax version, boot age
koda fleet runner disable <runnerId>               # drain: running jobs finish, nothing new is placed
koda fleet repo add acme/app --provider github     # GitLab subgroups: group/sub/app
koda fleet repo check <repoId>                     # exit 1 and a reason when koda can no longer broker git
koda fleet dispatch --repo acme/app --feature login --max-cost 5 --profile fast
koda fleet dispatch --repo acme/app --feature login --max-cost 2 --plan docs/specs/login.md --pin box-1
koda fleet job list --state RUNNING
koda fleet job show <jobId>
koda fleet job cancel <jobId>
koda fleet job bundle <jobId> --out login.tar.gz
koda fleet budget list --project web                # spend against amount; WARN / PAUSED state
koda fleet budget set --scope project --window month --amount 50 --project web
koda fleet budget resume <policyId> --amount 80 --project web
```

`--label` and `--pin` are exclusive. A dispatch for a feature that already has an active job on the repo prints
that job's id instead of starting a second one.

Budgets are also managed on the web: global and runner policies on `/admin/fleet/budgets` (global admins), project and
repo policies on `/<project>/fleet/budgets` (members read; project ADMINs add, edit, delete and resume). A paused or
past-warn policy that covers a project shows as a banner on that project's fleet pages. The CLI and the web call the same
routes, so a pause resumed in one shows in the other within 30 seconds.

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
