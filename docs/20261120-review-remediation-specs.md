# Spec review of the three Koda remediation features

**Verdict — ready for planning.** Reviewed against `37b396c49` on 2026-11-20. Phases 1–8 cover 14 stories and 67 acceptance criteria. All 14 original findings have an owner. Phase 9 requires generated PRDs and remains a downstream check.

| Reviewed spec | Review finding IDs | Stories | Unit ACs | Integration ACs |
|---|---|---:|---:|---:|
| [Recovery and deployment](../.nax/features/review-1120-recovery-deployment/spec.md) | 1, 3, 4, 5, 6, 7 | 6 | 9 | 12 |
| [Fleet reliability](../.nax/features/review-1120-fleet-reliability/spec.md) | 2, 8, 9, 10 | 4 | 11 | 12 |
| [Client behavior](../.nax/features/review-1120-client-behavior/spec.md) | 11, 12, 13, 14 | 4 | 23 | 0 |

## Material findings resolved during the audit

| Story | Issue in the draft | Resolution and evidence |
|---|---|---|
| Recovery 001, 003–004 | A mocked notification service could bypass the preference decision. Pausing the timer also pauses cleanup of stale one-shot sends. A bookkeeping failure is distinct from a message-build failure. | Exercise the reset request with the real notification decision and a recording delivery channel. While SMTP is disabled the periodic tick pauses; the first enabled tick closes abandoned one-shot sends before claiming due rows. Limit preparation retries at the claim’s actual attempt count. [Dispatcher](../apps/api/src/email/email-dispatcher.ts) · [Schedule repository](../apps/api/src/email/schedule/email-schedule.repository.ts) |
| Recovery 005–006 | Non-root extraction cannot reliably reproduce arbitrary filesystem owners. A restored database can pass SQL replay while the API still connects to the original. | Assert numeric owners in tar headers and verify extracted contents separately. Exercise persistent database selection, writer recreation and reversal. A deliberately incorrect verification baseline must prevent cutover. [Backup script](../deployments/example/backup-db.sh) · [Bundled database configuration](../deployments/example/docker-compose.yml) |
| Fleet 001 | A journal failure could acknowledge unrecorded cleanup, or shutdown could wait on a job whose credential broker was still open. A simulated crash closes the journal immediately. | Withhold the ack on persistence failure, reconcile on redelivery, and keep graceful shutdown ordering distinct from crash recovery. Exercise explicit and unknown-job cleanup of the same epoch. [Daemon lifecycle](../apps/runner/src/daemon/daemon.ts) · [Command handler](../apps/runner/src/supervisor/command-handler.ts) |
| Fleet 002–004 | The existing FIX ingest fixture cannot drive a RUN retirement unchanged. A successful diagnostic probe can itself carry work. Thread cancellation can coincide with a genuine stream-open failure. | Specify a current-lease RUN fixture with a parsed workflow. Require a successful base-only control before suppressing the report after isolated rejection. Preserve commands and archive notices from successful probes. A genuine stream-open failure ends in FAILED; a daemon halt preserves recoverable state. [Bundle ingest](../apps/api/src/fleet/ingest/bundle-ingest.service.ts) · [Sync loop](../apps/runner/src/sync/sync-loop.ts) · [Thread lifecycle](../apps/runner/src/thread/thread-job-run.ts) |
| Clients 001–002 | Legacy cookies and malformed expiry claims made the refresh boundary ambiguous. Logout resolves the key and endpoint separately, so an endpoint override can select a different deployment. | Define the whole-second cookie boundary, legacy fallback, key provenance and endpoint-matching checks. Re-read the stored entry before clearing it. Cross-process file locking stays outside the feature. [Cookie writer](../apps/web/server/utils/api.ts) · [CLI config](../apps/cli/src/config.ts) |
| Clients 003–004 | A pre-filled context could make the ticket test pass even if project defaults were never read. Conflicting application and HTTP status fields could produce inconsistent login diagnostics. | Drive ticket creation through real project-config resolution, isolate the process exit on validation errors, and inspect the creation request. Exercise the shared error normalizer’s application-code precedence and preservation of saved credentials. [Ticket command](../apps/cli/src/commands/ticket.ts) · [Error mapping](../apps/cli/src/utils/error.ts) |

## Audit coverage

| Phase | Recovery | Fleet | Clients |
|---|---|---|---|
| 1 · Existence | 17 context and 15 modification entries exist; 3 proposed creations absent | 28 distinct existing files, 2 workdirs, 14 code targets, commit and stream event checked | 24 distinct repo-relative code/document paths checked |
| 2 · Shapes and test contracts | 8 contract boundaries including notify registration, schedule settlement, archives and Compose cutover | 14 method/shape groups and 4 affected fixture families | 4 result or entry-point contracts including config resolution and error mapping |
| 3 · Conventions | 16 canonical rule files, 0 fenced implementation blocks | 16 rules, 0 blocks | 16 rules, 0 blocks |
| 4 · Semantics | 6 baseline findings, 0 changed method signatures, 17 failure-case groups, 6 live baseline paths | 16 baseline claims, 14 mutated method/shape groups, 10 failure rows, 4 review baselines | 10 grouped baseline behaviors, 4 target contracts, 5 failure rows, 0 historical completion claims |
| 5 · Sizing, file roles and dependencies | 6 stories, 21 ACs, 2 dependency edges | 4 stories, 23 ACs, 1 edge | 4 stories, 23 ACs, 1 edge |
| 6 · Stale references | 6 original findings and 1 revision | 4 original findings and 1 revision | 4 original findings, 1 revision and the original review report |
| 7 · Verification anchors | All 21 ACs classified | All 23 ACs classified | All 23 ACs classified |
| 8 · Integration paths | 6 story seams; 0 production deletions or new exports | 11 producer/consumer groups, 1 interstory seam and 0 file/symbol deletions | 4 production chains from the web and CLI entry points |

## Story deadlock checks

Each cell gives unresolved issues divided by items examined. The categories follow spec-review P4.2, P4.4, P4.5, P4.7–10, P5 phrasing and P8 producer/consumer nouns. The counts describe each reviewer's grouped cases; the audit verdict concerns unresolved issues. The recovery stories introduce no new production exports and their six existing integration paths were checked separately.

| Story | Contradictions | Input classes | Interactions | Design mandates | Risk properties | Fixtures | Constants | Phrasing | Contract nouns | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Recovery US-001 | 0/4 | 0/3 | 0/2 | 0/4 | 0/3 | 0/3 | 0/2 | 0/4 | n/a | Clear |
| Recovery US-002 | 0/2 | 0/3 | 0/2 | 0/2 | 0/1 | 0/2 | 0/1 | 0/2 | n/a | Clear |
| Recovery US-003 | 0/2 | 0/3 | 0/2 | 0/3 | 0/2 | 0/2 | 0/2 | 0/2 | n/a | Clear |
| Recovery US-004 | 0/3 | 0/3 | 0/2 | 0/3 | 0/2 | 0/4 | 0/3 | 0/3 | n/a | Clear |
| Recovery US-005 | 0/5 | 0/5 | 0/3 | 0/5 | 0/4 | 0/5 | 0/4 | 0/5 | n/a | Clear |
| Recovery US-006 | 0/5 | 0/5 | 0/3 | 0/5 | 0/4 | 0/5 | 0/2 | 0/5 | n/a | Clear |
| Fleet US-001 | 0/8 | 0/6 | 0/5 | 0/5 | 0/4 | 0/6 | 0/0 | 0/17 | 0/3 | Clear |
| Fleet US-002 | 0/5 | 0/5 | 0/4 | 0/3 | 0/2 | 0/5 | 0/1 | 0/10 | 0/3 | Clear |
| Fleet US-003 | 0/5 | 0/5 | 0/5 | 0/4 | 0/3 | 0/5 | 0/4 | 0/9 | 0/3 | Clear |
| Fleet US-004 | 0/5 | 0/4 | 0/4 | 0/3 | 0/3 | 0/5 | 0/1 | 0/12 | 0/2 | Clear |
| Clients US-001 | 0/6 | 0/5 | 0/3 | 0/1 | 0/2 | 0/4 | 0/3 | 0/6 | 0/2 | Clear |
| Clients US-002 | 0/8 | 0/5 | 0/4 | 0/3 | 0/4 | 0/5 | 0/1 | 0/8 | 0/3 | Clear |
| Clients US-003 | 0/4 | 0/4 | 0/3 | 0/1 | n/a | 0/4 | 0/2 | 0/4 | 0/2 | Clear |
| Clients US-004 | 0/5 | 0/5 | 0/2 | 0/2 | 0/2 | 0/5 | 0/2 | 0/5 | 0/2 | Clear |
| Across features | 0/3 feature pairs | n/a | 0/3 write-set comparisons | n/a | n/a | n/a | n/a | n/a | n/a | Clear |

## Validation

Strict `nax spec lint` accepted all three final specs with zero blockers, errors or warnings. A separate path and dependency check verified each declared workdir, every read and write file role, the story dependency order and the absence of overlapping write sets between features. The largest story has eight ACs against the configured cap of fifteen.

Three existing recovery suites passed 58 baseline tests covering password-reset requests at the service level, email dispatch and the backup script. Those tests establish current behavior. The new regression criteria and restore/cancellation scenarios belong to the implementation runs.
