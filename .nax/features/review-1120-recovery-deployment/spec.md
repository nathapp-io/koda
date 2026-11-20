# SPEC: Recovery email, backup and deployment fixes

## Summary

Implement findings 1, 3, 4, 5, 6 and 7 from [the verified review](../../../docs/20261120-review-37b396c49.md) at `37b396c49`. A user can request a recovery email after disabling notification email. Operators can configure mail through either shipped Compose file, suspend delivery without losing queued mail, create private backups, and restore PostgreSQL to a verified fresh target.

## Motivation

The reset route reported success while the real notification service skipped the opted-out account. Both Compose renders omitted all three email settings. With SMTP temporarily disabled, an eligible queued row became permanently failed. At the configured fifth attempt a build error queued another retry. Separately, under umask 022 the backup created a 0755 directory and 0644 compressed and plaintext database files. The existing restore command exited zero on a populated PostgreSQL 16 fixture despite SQL errors and retained newer rows.

## Design

### Integration

- **Reset delivery.** `PasswordResetService.issueReset` stores user identity on the schedule row and also supplies it to `EmailDispatcher.sendOne`. Pass `null` only for the latter preference lookup, matching the existing invite path. The schedule retains the account and destination. Ordinary notification email continues to apply the master and category preferences. The reset route keeps its generic response and detached delivery.
- **Deploy configuration.** Add optional `SMTP_URL`, `EMAIL_FROM` and `WEB_PUBLIC_URL` to the API service in each Compose environment. An empty setting already means absent to `emailConfig`. Keep its existing validation when SMTP is supplied. Use synthetic credentials for Compose tests and inspect selected fields without logging the rendered environment.
- **Scheduled delivery.** Keep the dispatcher injectable for immediate sends. Install its periodic dispatcher only when mail is configured. Use EmailAvailability.configured (SMTP presence) at module initialization. Disabling the scheduled timer defers its whole tick, including closeAbandonedInvites. After restart with SMTP restored, the first scheduled tick closes expired SENDING INVITE and PASSWORD_RESET rows as FAILED/abandoned, then claims eligible queued notification rows. Immediate one-shot rows are never resent. For EmailContentBuilder.build failures use the claimed row’s existing attempt number, configured limit and backoff. Keep repository settlement failures separate from build errors. If settling a failed build itself throws, log it and continue to the next claimed row. Keep skip handling, transport permanent-error classification, existing backoff timings and per-row isolation.
- **Backup.** Set the host umask before creating any artifacts, enforce 0700 on the script's own backups directory even when it already exists, and create dump, temporary archive and published archive as owner-readable/writable only. Fail before dumping if the directory cannot be secured. Stream the archive from the project API container with no TTY (for example `compose run -T --rm --no-deps --user root --entrypoint tar api -czf - -C /data .`) into a host-created private partial; the invoking host account then owns and can recover it even on Linux. Keep project resolution and numeric ownership metadata inside the archive. Verify the exact existing pg_dump completion-marker line by consuming the entire decompressed stream under pipefail, without storing a plaintext copy. Keep gzip integrity checks, failure cleanup and timestamp/PID names.
- **PostgreSQL restore.** Replace the in-place SQL replay in the example guide and the equivalent shortcut in the PostgreSQL guide. Give a shell procedure with explicit Compose file/project and configured role, archive, current DB and distinct new DB names. Stop all writers before recovery, keep the original DB for fallback, use a newly created database from template0, and abort if creation fails (including an existing name). Run the marked command blocks in a Bash script with errexit and pipefail so a nonzero step terminates the procedure. Require `psql -X -v ON_ERROR_STOP=1`. Test gzip integrity, treat decompression or SQL failure as a failed restore, and leave a failed staging DB offline. Show successful completion plus database-level checks such as known application row counts and migration records against an expected baseline captured for that backup. Make an actual mismatch terminate the procedure with nonzero status before the connection setting is changed. A SELECT that merely prints false is insufficient. Give the operator explicit cutover instructions for changing the bundled Compose project’s persistent POSTGRES_DB setting, from which the api service derives DATABASE_URL, and recreating the affected service containers with the same project and volumes. A plain compose restart does not reread environment values. Reversal restores the original setting and recreates the services in that project. Stage fixture data in explicitly named databases using the configured role. Parameterize database names through PostgreSQL client arguments or identifier quoting, and check current and target names before creation. Document the separate LanceDB archive restored by rollback.sh.

### Failure Handling

Retry exhaustion ends a row in FAILED with its capped error. A disabled installation leaves due rows available for the next enabled process. A failed archive write removes its partial and leaves the independently verified SQL dump available. A failed restore never authorizes cutover or a writer restart. Use the existing canRunDbTests() opt-in for real Docker/PostgreSQL suites. Copy the shipped backup script alongside a synthetic docker-compose.yml and .env in a private fixture directory since it resolves services relative to its own path. Use unique explicit Compose project names and restrict cleanup to the synthetic containers, databases and files created by that case. The Compose rendering checks require only the Compose CLI. Run their focused Vitest file with DB opt-in unset to bypass the root DB bootstrap. For real fixtures canRunDbTests() requires KODA_DB_TESTS=1 outside NAX_SANDBOXED=1. The shared Vitest setup may provision its own test database there. Neither Compose fixture uses the inherited DATABASE_URL, KODA_TEST_DATABASE_URL or project name to address a service. Give its subprocesses an explicit env file and controlled environment so inherited values cannot override the synthetic inputs.

## Out of Scope

- Changes to authentication tokens, reset throttling, notification library APIs or the preference schema.
- Distributed email leases, exactly-once SMTP delivery and changes to the existing retry schedule.
- Encrypting backups, changing historical backup file ownership, or operating on an existing deployment.
- Automating PostgreSQL cutover in rollback.sh, changing the dump format, or changing the LanceDB rollback procedure.

## Stories

**US-001: Deliver requested recovery email independently of notification preferences (1).** Workdir: `apps/api`. No dependencies.

**US-002: Forward optional email settings through both Compose deployments (5).** Workdir: `apps/api`. No dependencies.

**US-003: Preserve due email across an SMTP-disabled restart (6).** Workdir: `apps/api`. No dependencies.

**US-004: Enforce the attempt limit during email preparation (7).** Workdir: `apps/api`. Depends on US-003.

**US-005: Create private, operator-readable PostgreSQL and data backups (4).** Workdir: `apps/api`. No dependencies.

**US-006: Document and exercise a verified restore into a fresh PostgreSQL database (3).** Workdir: `apps/api`. Depends on US-005.

### Context Files

**US-001**
- `apps/api/src/projects/invites/invite-mailer.ts`
- `apps/api/src/email/email-dispatcher.ts`
- `apps/api/test/integration/email/notify-send.integration.spec.ts`

**US-002**
- `apps/api/src/config/email.config.ts`
- `apps/api/turbo.json`

**US-003**
- `apps/api/src/notifications/notifications.module.ts`
- `apps/api/src/email/email-availability.ts`
- `apps/api/src/email/schedule/email-schedule.repository.ts`

**US-004**
- `apps/api/src/email/email-content.builder.ts`
- `apps/api/src/email/schedule/email-schedule.types.ts`

**US-005**
- `deployments/example/deploy.sh`
- `apps/api/test/unit/tooling/deploy-script.spec.ts`
- `apps/api/test/unit/tooling/deploy-script-harness.spec.ts`

**US-006**
- `deployments/example/backup-db.sh`
- `deployments/example/docker-compose.yml`
- `deployments/example/rollback.sh`
- `apps/api/test/helpers/test-environment.ts`

### Creates

**US-002**
- `apps/api/test/integration/email/compose-email-config.integration.spec.ts` — render both shipped manifests via the Compose CLI using isolated environment files and explicit project names.

**US-005**
- `apps/api/test/integration/db/backup-permissions.integration.spec.ts` — drive the shipped script against disposable Compose services with synthetic PostgreSQL rows and /data entries. Exercise the actual root archive producer and host file creation.

**US-006**
- `apps/api/test/integration/db/documented-restore.integration.spec.ts` — exercise the guide's actual marked shell block(s) against disposable PostgreSQL 16 databases. Pass synthetic variables, check exit codes and query results. Never select a database from developer environment settings.

### Modifies

**US-001**
- `apps/api/src/auth/password-reset/password-reset.service.ts` — decouple requested reset delivery from the preference principal while retaining schedule attribution.
- `apps/api/src/auth/password-reset/password-reset.service.spec.ts` — update the existing AC-3 argument assertion and preserve the attributed schedule assertion.
- `apps/api/test/integration/auth/password-reset-request.integration.spec.ts` — update its separate AC-3 assertion and exercise the real NOTIFY_SERVICE preference branch for the new cases. For these cases call through the suite's NOTIFY_SERVICE.send spy and record the email channel obtained through DELIVERY_CHANNEL_REGISTRY, as in notify-send.integration.spec.ts. Run the ordinary notify control under its existing SYSTEM/email test actor so the preference check and delivery logging have their production action context. Await completion of detached sends before restoring the channel spy or clearing fixtures.

**US-002**
- `docker-compose.yml` — forward the three settings to the api service.
- `deployments/example/docker-compose.yml` — forward the same settings to the api service.

**US-003**
- `apps/api/src/email/email-dispatcher.ts` — gate periodic dispatch on configured availability.
- `apps/api/src/email/email-dispatcher.spec.ts` — cover initialization with disabled and subsequently enabled configuration over a retained queue.

**US-004**
- `apps/api/src/email/email-dispatcher.ts` — distinguish preparation failure from dispatch bookkeeping and apply the attempt limit to preparation errors.
- `apps/api/src/email/email-dispatcher.spec.ts` — exercise below-limit, final and over-limit preparation failures and continued batch processing.

**US-005**
- `deployments/example/backup-db.sh` — create private host artifacts, verify SQL by streaming and publish only a completed volume archive.
- `apps/api/test/unit/tooling/backup-db-script.spec.ts` — replace the old exact bind-mount argv, archive-command stamp extraction and tar failure matcher with equivalent assertions for binary stdout, host partial publication, private modes and cleanup. Retain complete-marker, large-stream, gzip content, stop-on-failure and uniqueness coverage.
- `apps/api/test/unit/tooling/helpers/deploy-script-stubs/docker` — emit synthetic archive bytes to stdout for the new archive command, including a prefix on injected failure. Preserve existing pg_dump and rollback stub behavior.
- `apps/api/test/unit/tooling/helpers/deploy-script-harness.ts` — provide per-child umask and pre-existing-directory fixtures for the backup tests without changing the parent test process's umask.

**US-006**
- `deployments/example/README.md` — replace the in-place pipeline with the fresh-target recovery, verification, cutover and fallback runbook. Mark the executable example consumed by the integration fixture.
- `docs/deployment/postgresql.md` — replace its existing populated-target psql shortcut with guidance linked to the example recovery procedure, accounting for role and project names. Pair the gzip procedure with a gzip backup example, and explain how an existing plain SQL dump reaches the same fresh-target psql step.

### Seams

US-001 exercises the request through the real notification library and a recording delivery channel. US-002 uses Compose's evaluated API environment. US-003/004 exercise the scheduled tick and repository settlement calls. US-005 exercises host/container ownership and binary transfer. US-006 restores the plain gzip SQL format emitted by US-005; the directory-volume archive and its recovery stay separate.

## Acceptance Criteria

### US-001

- AC-1 [integration] POST /api/auth/password-reset for an active opted-out fixture account returns its ordinary response and eventually delivers exactly one PASSWORD_RESET email to the recording provider through the real notify service.
- AC-2 [integration] After AC-1's detached send finishes, its schedule row is SENT with the account ID, destination and selected locale, and the delivered link matches the persisted token hash.
- AC-3 [integration] With the same account opted in, the route still delivers once. A notification sent to the opted-out principal through the ordinary notify path causes zero provider calls.
- AC-4 [unit] The service's request fixture passes null as the reset delivery preference principal, keeps retry disabled and writes the user ID on the schedule entry.

### US-002

- AC-1 [integration] With an explicit synthetic env file, docker compose config for each shipped manifest returns the exact supplied SMTP_URL, EMAIL_FROM and WEB_PUBLIC_URL in services.api.environment, plus the control JWT_EXPIRES_IN=5m.
- AC-2 [integration] With only the manifests' required credentials supplied, both render successfully and all three email settings are absent or empty on the API; neither the web nor postgres service receives SMTP_URL in either render.

### US-003

- AC-1 [unit] Initializing the dispatcher with SMTP absent and the public URL present, then advancing the scheduler through two tick intervals, leaves an eligible due row pending with its original attempt count and zero calls to the provider, closeAbandonedInvites or claimDue.
- AC-2 [unit] Starting an enabled dispatcher with that retained row and advancing one interval invokes closeAbandonedInvites before claimDue, then claims the retained due notification once, delivers it once and settles it SENT. The expired immediate-send rows are handled by the existing close operation and never passed to the provider. Destroying the dispatcher stops later scheduled claims.

### US-004

- AC-1 [unit] A scheduled tick whose builder throws a preference lookup error on claim attempt five with a maximum of five settles the row FAILED with that error and issues no retry.
- AC-2 [unit] The same builder error on attempt six also settles FAILED; on attempt one it schedules the existing two-minute backoff and leaves the row retryable.
- AC-3 [unit] A batch with an exhausted preparation failure followed by an eligible row records one failure and one delivered message. A transient transport failure at the configured limit still ends FAILED. When marking the exhausted build failure fails at the repository seam, the dispatcher logs the settlement error and processes the next eligible row.

### US-005

- AC-1 [unit] Under child umask 022 the backup harness creates or tightens an existing 0755 backups directory to 0700 before the first dump output. The compressed dump and partial archive are private from creation. The verification step creates no plaintext dump file. A fixture with a regular file where the backups directory should be fails before any pg_dump call.
- AC-2 [unit] The harness feeds a completion marker followed by more than 1 MiB of data through the verifier successfully; missing marker, invalid compressed input or a failed dump return nonzero with no accepted SQL dump.
- AC-3 [unit] A container tar failure after writing partial stdout returns nonzero, removes the partial volume archive and leaves only the independently verified dump. Two successful same-second invocations have distinct final names.
- AC-4 [integration] Running the shipped backup script with umask 022 against an isolated Docker Compose fixture yields a 0700 directory and both 0600 final artifacts owned and readable by the invoking host user. Compare the host file owner to the invoking host UID wherever available. Exercise the Linux ownership regression on a non-root host runner. On root-only hosts report that ownership control as unexercised and still run the mode, readability and content checks.
- AC-5 [integration] The archive produced by AC-4 has tar headers with the synthetic source files’ numeric UID and GID, and extraction in the fixture reproduces their contents. Inspect the header to verify ownership so the test does not require a non-root host extractor to chown extracted files. The SQL gzip decompresses to a complete dump containing the synthetic database fixture.

### US-006

- AC-1 [integration] Given a PostgreSQL 16 snapshot containing (1,before), then a live fixture with (1,after) and (2,new), the documented commands restore the original snapshot into a distinct newly created database. A query returns exactly (1,before) there and both newer rows remain in the original.
- AC-2 [integration] Pointing the documented preparation and restore sequence at an already existing target returns nonzero before replay. Its pre-existing sentinel row and original database contents remain unchanged.
- AC-3 [integration] Feeding the documented restore sequence a valid gzip containing invalid SQL returns nonzero at the SQL error. A following sentinel insert never executes and no cutover occurs.
- AC-4 [integration] With an invalid or truncated gzip archive the documented procedure exits nonzero and the original database remains queryable with its pre-restore contents.
- AC-5 [integration] Exercise the documented cutover and reversal against an isolated Compose fixture with a synthetic API database client. After the fresh-target checks pass, the restarted client reads the backup sentinel from the restored DB; after reversal it reads the newer sentinel from the retained original DB. Supplying an incorrect expected row baseline to the same marked procedure produces a nonzero exit. The persisted target stays original and the fixture records zero writer starts after this failure.
