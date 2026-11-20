# Koda whole-repository review, 2026-11-20 (consolidated and verified)

Reviewed `main` at `c7dfdf58ceee3c3bd02c9158292f73669b823e29`. This file merges the two review reports written on this commit:

- round one (8 findings, referred to here as R1-n)
- round two (12 findings, R2-n)

Every finding was re-checked against the source at the same commit before it was merged. All 20 hold. After verification there are **no High findings, 11 Medium and 9 Low**. Five severities changed:

| Finding | Was | Now | Why |
|:--|:--|:--|:--|
| R2-1 rollback volume | High | Medium | Needs an override of `COMPOSE_PROJECT_NAME`, and nothing in the repo documents one |
| R2-2 CI SIGPIPE | High | Medium | Reproduced, but needs a changed-path list above the pipe buffer (about 64 KB, roughly 1,000+ paths) |
| R1-3 PR URL variants | Medium | Low | The URL comes from nax's finish/workflow URL, which is the canonical forge URL; a variant needs a non-canonical sender |
| R2-6 CI webhook nested objects | Medium | Low | The controller's `catch` calls `replayGuard.forget`, so the delivery ID is not consumed. The effect is a 500 instead of a 400 for an authenticated sender |
| R2-8 cancel during upload | Medium | Low | Holds as described, but whether to honour or refuse a cancel after the work is done is a design ruling |

One finding is wider than reported: **R2-9** affects any requeue onto a runner that still holds the job's older-epoch row, not only a cancelled-while-queued job.

Finding IDs below are new (K1-K20). The original ID is given next to each one.

## Summary

| ID | Sev | Area | Finding | Orig |
|:--|:--|:--|:--|:--|
| K1 | Medium | Deploy | Compose drops both webhook signature switches | R1-1 |
| K2 | Medium | CLI | `koda ci-webhook trigger` cannot send v2 signatures | R1-2 |
| K3 | Medium | Deploy | Backup and restore hardcode the `koda-local` data volume | R2-1 |
| K4 | Medium | Deploy | Rollback stops api and web before checking the restore file | R1-4 |
| K5 | Medium | Deploy | Documented external `DATABASE_URL` is ignored | R1-5 |
| K6 | Medium | Deploy | Deploying onto a stopped stack migrates without a database dump | R2-4 |
| K7 | Medium | CI | Large PRs can skip every gated CI job (SIGPIPE under pipefail) | R2-2 |
| K8 | Medium | Release | Re-publishing an older tag moves `latest` and `X.Y` backwards | R2-3 |
| K9 | Medium | CLI/Web | `owner/name` repo shorthand picks the first of two hosts | R2-5 |
| K10 | Medium | Runner | A second restart before the READOPT ack leaves a job unsupervised | R2-7 |
| K11 | Medium | Runner | ASSIGN of a requeued job can stall the whole sync loop on a repo lock | R2-9 |
| K12 | Low | API | PR ruling lookup misses trailing-slash and query-string URLs | R1-3 |
| K13 | Low | Runner | Cancel acked during UPLOADING, job then reports COMPLETED | R2-8 |
| K14 | Low | API | CI webhook accepts a payload without `pipeline` or `commit` (500) | R2-6 |
| K15 | Low | API | CI failure tickets never include the source-file URL | R2-11 |
| K16 | Low | Web | A stale bell refresh can undo "Mark all read" on screen | R1-6 |
| K17 | Low | Web | Log download fails after the access cookie expires | R2-10 |
| K18 | Low | Runner | Shutdown waits out the sync backoff (up to 60 s) | R1-7 |
| K19 | Low | CI | `openapi-ts.config.ts` changes bypass CI | R1-8 |
| K20 | Low | Scripts | `scripts/seed.sh` cannot run against the shipped image | R2-12 |

K1 and K2 should ship together: v2 sender support (K2) has to land before operators can enforce v2 (K1).

---

## Deployment and configuration

### K1. Medium: Compose drops both webhook signature switches (R1-1)

The API `environment:` blocks in [`docker-compose.yml`](../docker-compose.yml#L20) and [`deployments/example/docker-compose.yml`](../deployments/example/docker-compose.yml#L11) are whitelists, and neither passes `CI_WEBHOOK_REQUIRE_V2` or `WEBHOOK_SIGNATURE_V1_ENABLED`. [`webhook-signature.config.ts`](../apps/api/src/config/webhook-signature.config.ts#L22) then falls back to `v1Enabled: true` and `ciRequireV2: false`. An operator who follows [`deployment/webhooks.md`](deployment/webhooks.md) and sets both switches still gets v1-only CI deliveries accepted and legacy outbound signatures sent.

**Verified:** neither key appears in either Compose file. The config defaults are as stated.

**Fix:** pass both switches with explicit defaults in both manifests, and add a Compose render test that asserts the non-default values.

### K3. Medium: backup and restore hardcode the `koda-local` data volume (R2-1)

The example Compose file sets `name: koda-local`, but `COMPOSE_PROJECT_NAME` takes precedence over it. With `COMPOSE_PROJECT_NAME=koda-staging`, the API mounts `koda-staging_koda_data`. However, [`backup-db.sh`](../deployments/example/backup-db.sh#L31) always archives `koda-local_koda_data`, and [`rollback.sh`](../deployments/example/rollback.sh#L61) runs `rm -rf /target/*` on that same volume before it extracts the archive. A staging operator would back up the wrong (or an empty, auto-created) volume, and a later restore would overwrite the default deployment's fleet artifacts and LanceDB.

**Verified in source.** Nothing in `deployments/` or `docs/` mentions `COMPOSE_PROJECT_NAME`, so the trigger is an undocumented override.

**Fix:** resolve the volume through the selected Compose project (for example, `docker compose ... config --format json` or a `docker volume ls` label filter), and check its identity before clearing it.

### K4. Medium: rollback stops api and web before checking the restore file (R1-4)

[`rollback.sh:50-57`](../deployments/example/rollback.sh#L50) runs `docker compose stop api web` and only then tests `[[ ! -f "$RESTORE_DB_FILE" ]]`. A typo in the path exits 1 with both services stopped and no restart path.

**Verified in source.** The order is exactly as shown.

**Fix:** validate the archive and pull the target images before stopping anything.

### K5. Medium: the documented external `DATABASE_URL` is ignored (R1-5)

[`deployments/example/README.md`](../deployments/example/README.md#L118) says to "set `DATABASE_URL` in `.env` to point at an external Postgres". However, the example Compose file always builds `DATABASE_URL` from the bundled `postgres` host, and Compose ignores a `.env` value for a key the `environment:` block sets explicitly. On top of that, [`deploy.sh`](../deployments/example/deploy.sh#L120) migrates through that same API service, and `backup-db.sh` dumps the bundled `postgres` service.

**Verified in source.**

**Fix:** honour one external database setting across Compose, migration and backup. If only bundled Postgres is supported, correct the README and refuse an explicit override.

### K6. Medium: deploying onto a stopped stack migrates without a database dump (R2-4)

[`backup-db.sh:19-26`](../deployments/example/backup-db.sh#L19) dumps Postgres only if the service is running. Otherwise it prints "skipping database dump" and exits 0. `deploy.sh` then runs `prisma migrate deploy`, which starts `postgres` through `depends_on`. A stopped stack with a full `koda_pg` volume is therefore migrated with no backup.

**Verified in source.**

**Fix:** if the `koda_pg` volume exists, start Postgres and take a verified dump before migrating. If the dump cannot be taken, stop the deployment.

### K20. Low: `scripts/seed.sh` cannot run against the shipped image (R2-12)

[`scripts/seed.sh:20`](../scripts/seed.sh#L20) runs `docker exec koda-api ... bun apps/api/prisma/seed.ts`, which fails for two reasons:

- Compose names the container `<project>-api-1`, not `koda-api`.
- The final stage of [`apps/api/Dockerfile`](../apps/api/Dockerfile#L108) copies only `dist`, `prisma.config.ts`, the schema and the migrations into `apps/runtime`, so no `apps/api/prisma/seed.ts` exists in the image.

**Verified in source.** Two further points:

- No document references the script.
- It defaults to the password `Admin123!` and interpolates the values into a single-quoted shell string.

**Fix:** delete the script, or rewrite it against `docker compose exec api` with a seed entry point that ships in the image.

---

## CI and release

### K7. Medium: large PRs can skip every gated CI job (R2-2)

[`ci.yml:64`](../.github/workflows/ci.yml#L64) runs `printf '%s\n' "$changed" | grep -qE "$CODE_PATHS"` under `set -euo pipefail`. `grep -q` exits on the first match. If `printf` still has data to write (more than one pipe buffer, about 64 KB), it dies with SIGPIPE (141). The pipeline then fails, the `else` branch sets `code=false`, and quality, test and smoke are all skipped. A skipped required check counts as passing, so the merge gate opens.

**Reproduced locally** using the 5,000 tracked `apps/` paths (231 KB): the result was `skip`, with `PIPESTATUS` `141 0`.

**Fix:** use `grep -qE "$CODE_PATHS" <<< "$changed"`, or drop `-q`. Add a test with a path list larger than the pipe buffer.

### K8. Medium: re-publishing an older tag moves `latest` and `X.Y` backwards (R2-3)

[`release.yml:88-96`](../.github/workflows/release.yml#L88) tags every non-canary build `:<tag>`, `:<major.minor>` and `:latest`. The workflow's `workflow_dispatch` input exists to re-publish an existing tag, and a pushed back-port tag (for example `v0.3.5` after `v0.4.x`) takes the same path. Either one moves `latest` and the minor alias backwards.

**Verified in source.**

**Fix:** always push the immutable tag. Move `latest` and `X.Y` only when this version is the highest semver tag for that alias, for example by comparing against `git tag --sort=-v:refname`.

### K19. Low: `openapi-ts.config.ts` changes bypass CI (R1-8)

The file is missing from both the `push.paths` list ([`ci.yml:7`](../.github/workflows/ci.yml#L7)) and `CODE_PATHS` ([`ci.yml:61`](../.github/workflows/ci.yml#L61)). It controls the generated CLI SDK's response style and its `throwOnError` setting, and [`release.yml:138`](../.github/workflows/release.yml#L138) regenerates the SDK from it before publishing.

**Verified in source.**

**Fix:** add it to both filters. Consider a check that keeps the two lists aligned.

---

## CLI and web

### K2. Medium: `koda ci-webhook trigger` cannot send v2 signatures (R1-2)

[`ci-webhook.ts:24-46`](../apps/cli/src/commands/ci-webhook.ts#L24) exposes only `--signature`, which it sends as `x-ci-signature`. It also generates `x-ci-delivery` internally, so a caller cannot pre-compute a v2 signature, which covers `<timestamp>.<delivery>.<body>`. When `ciRequireV2` is true, the controller ([`ci-webhook.controller.ts`](../apps/api/src/ci-webhook/ci-webhook.controller.ts#L77)) rejects any request without `x-ci-signature-v2`.

**Verified in source.**

**Fix:** add a `--secret` (or environment variable) path that has the CLI generate the timestamp and delivery ID and sign the exact serialized body. Keep `--signature` through the deprecation window.

### K9. Medium: `owner/name` repo shorthand picks the first of two hosts (R2-5)

[`resolveRepo`](../apps/cli/src/commands/fleet-shared.ts#L72) returns the first repo whose `owner/name` matches. The schema ([`schema.prisma:853`](../apps/api/prisma/schema.prisma#L853)) makes `host` part of repo identity, so two GitLab hosts can share an `owner/name`. [`fleet-dispatch.ts:56`](../apps/cli/src/commands/fleet-dispatch.ts#L56) dispatches to whichever repo the API happened to list first. The web dispatch chooser ([`dispatch.vue:79`](../apps/web/pages/%5Bproject%5D/fleet/dispatch.vue#L79)) also labels both options `owner/name`, with no host.

**Verified in source.**

**Fix:** match an ID exactly first. If the shorthand matches more than one repo, refuse it and list each host and ID. In the web chooser, add the host to the label whenever two labels collide.

### K16. Low: a stale bell refresh can undo "Mark all read" on screen (R1-6)

[`useNotifications.refresh`](../apps/web/composables/useNotifications.ts#L22) writes the shared `useState` without checking how old the response is. When a bell refresh that started earlier finishes after the inbox's post-`markAllRead` refresh, the badge goes back to unread. Server state is not affected, and the next 60 s poll corrects the display.

**Verified in source.**

**Fix:** keep a per-user refresh generation in `useState` and drop superseded responses.

### K17. Low: log download fails after the access cookie expires (R2-10)

The Download control is a plain `<a href download>` ([`logs.vue:156`](../apps/web/pages/%5Bproject%5D/fleet/jobs/%5Bid%5D/logs.vue#L156)). The request goes straight to the proxy ([`server/api/[...].ts`](../apps/web/server/api/%5B...%5D.ts#L25)), while [`shouldRefreshSession`](../apps/web/server/utils/session-refresh.ts#L29) refreshes only `text/html` requests outside `/api/`. As a result, after the access cookie expires the download returns a 401 even though the refresh cookie is still valid.

**Verified in source.**

**Fix:** refresh the session (for example with an authenticated HEAD or ping through `$api`) before opening the link. Alternatively, let the proxy refresh on a GET stream request.

---

## API

### K12. Low: PR ruling lookup misses trailing-slash and query-string URLs (R1-3)

`prNumberFor` ([`pr-attribution.service.ts:9-10`](../apps/api/src/fleet/sync/pr-attribution.service.ts#L9)) accepts `/pull/42/` and ignores `?query`. The repository's pre-filter in [`latestRunForPr`](../apps/api/src/fleet/rulings/prisma-fleet-pr-ruling.repository.ts#L85) is `endsWith: '/pull/42'` (or `/merge_requests/42`), so those variants never reach the parser. When the newest run's URL is such a variant:

- `ruleTarget` can answer `notLatest`.
- A FIX snapshot can miss pending rulings.
- An older run with a canonical URL can be picked instead.

**Verified in source.** In practice the runner stores nax's finish/workflow URL ([`status-snapshot.ts:69`](../apps/runner/src/watcher/status-snapshot.ts#L69)), which is the canonical forge URL, hence Low.

**Fix:** store a normalized PR number (or a normalized URL) when the snapshot is written, and query that. If the lookup keeps using raw URLs, make the filter a superset of what the parser accepts.

### K14. Low: CI webhook accepts a payload without `pipeline` or `commit` (R2-6)

[`CiWebhookPayloadDto`](../apps/api/src/ci-webhook/ci-webhook.dto.ts#L51) has `@ValidateNested()` but no `@IsDefined()`/`@IsObject()` on either parent object. For a `pipeline_failed` event with failures, `createTicket` then dereferences `payload.pipeline.id` and throws a `TypeError`, which becomes a 500 ([`ci-webhook.service.ts:88`](../apps/api/src/ci-webhook/ci-webhook.service.ts#L88)).

**Reproduced** with a throwaway vitest spec calling the real `parseInboundPayload`:

| Payload | Result |
|:--|:--|
| no `pipeline`, no `commit` | accepted |
| `pipeline` only | accepted |
| `pipeline: {}` | rejected |

The report's "after replay bookkeeping" is true, but the controller's `catch` calls `forget`, so the sender can retry with the same delivery ID.

**Fix:** add `@IsDefined()` and `@IsObject()` to both parent fields, with one test per omitted field.

### K15. Low: CI failure tickets never include the source-file URL (R2-11)

[`buildDescription`](../apps/api/src/ci-webhook/ci-webhook.service.ts#L123) builds `{ gitRemoteUrl: undefined }` inline and passes it to `buildGitUrl`, so the URL line never appears. In addition, [`findProjectBySlug`](../apps/api/src/ci-webhook/prisma-ci-webhook.repository.ts#L15) does not select the project's remote.

**Verified in source.**

**Fix:** select the remote, pass the project through to `buildDescription`, and add a test that asserts the URL line.

---

## Runner

### K10. Medium: a second restart before the READOPT ack leaves a job unsupervised (R2-7)

The sequence:

1. Boot 2 applies a READOPT, journals the command as `ok`, and restarts before the ack reaches the API.
2. On the API, `reconcileBoot` ([`command-ack.processor.ts:150`](../apps/api/src/fleet/sync/command-ack.processor.ts#L150)) sees that the READOPT is still pending and queues no new one, so the same command ID goes to boot 3.
3. Boot 3 finds the journaled command, and [`handleOne`](../apps/runner/src/supervisor/command-handler.ts#L55) replays the stored ack. Only an `ASSIGN` replay calls `resumeStranded`, so no watcher is attached.
4. The `ok` ack sets `runnerBootId` to boot 3 ([`command-ack.processor.ts:97`](../apps/api/src/fleet/sync/command-ack.processor.ts#L97)), and no further READOPT is ever sent.

I found no server-side heartbeat sweeper that would catch the job. The nax process keeps running, but nobody reports its progress or verdict.

**Verified by tracing both sides.** The window is narrow: it needs two restarts in a row.

**Fix:** on a READOPT replay whose row is not yet done and has no run in memory, run `supervisor.readopt` again. Alternatively, stamp the journaled result with the boot ID and treat a result from a previous boot as not applied.

### K11. Medium: ASSIGN of a requeued job can stall the whole sync loop on a repo lock (R2-9)

[`CommandHandler.assign`](../apps/runner/src/supervisor/command-handler.ts#L141) awaits `supervisor.abandon` for every older-epoch row of the same job ID. Both the in-memory and the after-restart path end in [`JobRun.abandon`](../apps/runner/src/supervisor/job-run.ts#L225), which awaits `mutex.acquire(row.repoKey)`. The sync loop awaits `handleCommands` inline ([`sync-loop.ts:171`](../apps/runner/src/sync/sync-loop.ts#L171)). While another job holds that repo's lock (a long RUN), every sync on this runner waits, including heartbeats, cancel commands and token refreshes for its other jobs.

**Wider than reported.** `journal.abandon` deletes the row, but finished rows otherwise stay until `jobRetentionDays` pruning ([`daemon.ts:92`](../apps/runner/src/daemon/daemon.ts#L92)). That means any requeue (after a cancel, crash or failure) onto a runner that still holds the older row triggers the stall, not only a job cancelled while queued.

**Verified in source.**

**Fix:** retire an older row that is already `doneAt` without taking the mutex. Move the remaining cleanup out of the response handler, while keeping the rule that it finishes before the new epoch's prepare.

### K13. Low: cancel acked during UPLOADING, job then reports COMPLETED (R2-8)

[`FleetJobsService.cancel`](../apps/api/src/fleet/jobs/fleet-jobs.service.ts#L210) accepts a cancel for any held, non-terminal state, including UPLOADING. [`requestCancel`](../apps/runner/src/supervisor/job-run.ts#L181) records the flag and acks `ok`. The finish path, however, computes `judged` before the upload and, after the upload returns, calls `transition(verdict.state)` without checking the flag again ([`job-run.ts:668`](../apps/runner/src/supervisor/job-run.ts#L668)). The user sees an accepted cancel followed by COMPLETED.

**Verified in source.**

**Needs a ruling:** either honour the cancel at the terminal transition (keeping the uploaded result metadata), or have the API refuse a cancel once the job is in UPLOADING. Either way, the ack should not say `ok` and then be ignored.

### K18. Low: shutdown waits out the sync backoff (R1-7)

[`SyncLoop.stop`](../apps/runner/src/sync/sync-loop.ts#L99) aborts only an in-flight request. The `retry` and `minGap` sleeps ([`sync-loop.ts:115-116`](../apps/runner/src/sync/sync-loop.ts#L115)) use the daemon's `systemSleep`, which cannot be cancelled. The daemon's `stop` awaits `running` before any cleanup ([`daemon.ts:330`](../apps/runner/src/daemon/daemon.ts#L330)). During an API outage, a SIGTERM can therefore wait up to 60 s ([`backoff.ts`](../apps/runner/src/sync/backoff.ts#L2)). A service manager with a shorter stop timeout could kill the daemon before cleanup runs (not checked against the shipped unit or plist).

**Verified in source.**

**Fix:** give the sleep an abort signal that `stop()` triggers.

---

## Verification notes

- Every finding was re-read in the source at `c7dfdf58`. HEAD had not moved since both reports were written.
- K7 and K14 were reproduced. I ran nothing else. The other findings rest on the source reading above, plus the probes that the original reports describe and ran.
- K7 reproduction (any shell):

  ```bash
  bash -c 'set -euo pipefail; changed=$(git ls-files apps | head -5000)
    if printf "%s\n" "$changed" | grep -qE "^apps/"; then echo run; else echo "skip ${PIPESTATUS[*]}"; fi'
  # -> skip 141 0
  ```

- K14 reproduction: a temporary spec under `apps/api/src/ci-webhook/` that calls `parseInboundPayload(CiWebhookPayloadDto, body)` for each of the three payloads in K14, run with `NAX_SANDBOXED=1 bunx vitest run <spec>`. The spec was deleted afterwards.
- Original test baseline (from R1, not re-run):
  - Lint, type-check, build: all passed.
  - Unit tests: CLI 890, web 5,705 and runner 2,704 passed.
  - API focused suites: 107 passed.
  - Full API unit command: 63 failures, all `listen EPERM` socket binds denied in the sandbox, not code defects.
  - Postgres integration, host-only runner checks and browser E2E were not run in either round.
