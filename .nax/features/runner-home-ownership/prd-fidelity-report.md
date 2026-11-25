# Runner home ownership PRD fidelity review

**Verdict — PASS after one correction to the generated criteria.** All 15 acceptance criteria in the committed runner spec map to US-001. The reviewed PRD fits the repository’s story-size limits. The story is pending implementation. [Committed spec](../../../docs/specs/SPEC-runner-home-ownership.md) · [Reviewed PRD](prd.json)

**Phases run:** 1 of 9 (`--phase 9`: phases 1–8 skipped by request).

**Inputs.** Spec commit `9ee9f9498`, branch `feat/runner-home-ownership`, feature `runner-home-ownership`, profile `native-codex-ds`. The planner exited 0. The comparison used the spec at that commit and the final PRD emitted after the planner exited.

## Correction to the planner output

The planner produced 17 criteria for one story. Generated AC12 and AC13 covered a directory occupying the lock path. AC16 and AC17 repeated the same exit-code and diagnostic assertions for a lock database the process could not access. Both errors come from the spec’s failure-handling section. The two additional criteria exceeded Koda’s configured maximum of 15.

Reviewed AC12 now checks status 1 for each of the two fixtures. Reviewed AC13 checks the full lock path in stderr for each. AC1–11 and AC14–15 retain the planner’s wording. Comparing the parsed JSON before and after the edit confirmed that only the acceptance-criteria array changed. [Story-size configuration](../../../.nax/config.json)

## Acceptance-criterion mapping

Numbers refer to the order within US-001. The input conditions and expected results below were checked in the PRD’s acceptance criteria and executable story description.

| Spec | Generated | Reviewed | Behavior preserved |
| --- | --- | --- | --- |
| 1 | 1 | 1 | Two processes start together on one idle home. Exactly one boot ID reaches the sync transport. |
| 2 | 2 | 2 | An independent SQLite writer holds `daemon-lock.db`. The contender exits 1 within one second of the post-Git readiness barrier. |
| 3 | 3 | 3 | A relative directory symlink resolves to the occupied home. The structured stderr message retains the absolute spelling of the supplied alias. |
| 4 | 4 | 4 | The contender’s event log records zero attempts to create workspace `.jobs`, rotate the log, prepare sockets, open a writable journal or sync. Preparing the home itself is allowed. |
| 5 | 5 | 5 | With redelivery pending and no worker PID recorded, the controller waits for B’s refusal before releasing A. The executor launches once for the job and lease epoch. |
| 6 | 6 | 6 | Two independent homes with separate resources both sync while their processes overlap. |
| 7 | 7 | 7 | Read-only CLI status returns the known active job ID while its daemon owns the home. |
| 8 | 8 | 8 | A contender is refused while clean stop waits for a held journal writer. |
| 9 | 9 | 9 | After clean stop, a replacement retrieves the persisted job ID from the same journal. |
| 10 | 10 | 10 | After real owner-process death with an inert child still alive, a replacement syncs without file cleanup. |
| 11 | 11 | 11 | After the initial capability probe fails, a fresh caller syncs while the failed caller’s process remains alive. |
| 12 | 12, 16 | 12 | A directory or inaccessible database at the lock path yields CLI status 1. |
| 13 | 13, 17 | 13 | Each unusable lock fixture produces a stderr diagnostic containing the full lock database path. |
| 14 | 14 | 14 | After the in-process crash stand-in, replacement startup returns a daemon handle. |
| 15 | 15 | 15 | Repeating stop on a retired handle leaves a newer owner protected against a third contender. |

## Story, file and scope checks

| Check | Result |
| --- | --- |
| Story identity and dependencies | US-001 is the only story. Its workdir is `apps/runner` and its explicit dependency set is empty. The PRD branch matches the checked-out branch. |
| File roles | All five context paths exist. Both new test and fixture paths appear only in `expectedFiles`. The sole `modifiedFiles` entry names the daemon source and carries the spec’s reason verbatim. |
| Scope | All five exclusions survive verbatim in the root list and the story description. No criterion requires a deferred behavior. |
| Earlier review corrections | The SQLite writer, post-Git timing barrier, relative alias spelling, protected-event observer and controller-driven release after B exits all reach the story description or criteria. |
| Interfaces and verification | Startup, stop and crash retain the declared signatures. The CLI run and status checks use the existing command routes, including the read-only journal path. The three runner verification commands survive in the story description. [CLI entry points](../../../apps/runner/src/main.ts) · [Status reader](../../../apps/runner/src/commands/status.ts) · [Daemon lifecycle](../../../apps/runner/src/daemon/daemon.ts) |
| Story size | 15 acceptance criteria and 8 description bullets, within the configured limits of 15 each. No terminal-cleanup story or cross-story dependency was specified. |

## Execution precheck

After the review, `nax precheck -f runner-home-ownership --json` stopped at its clean-working-tree gate. It named the untracked November 25 review document and its evidence directory. Phase 9 passed. A full execution precheck and an implementation run are still outstanding.
