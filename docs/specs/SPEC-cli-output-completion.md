# SPEC: Complete CLI output before a successful exit

## Summary

A normal, successful Koda CLI action must deliver its complete result to an open stdout destination before terminating with status 0. Apply this to finite action results and to the natural completion of log streaming, across JSON, NDJSON and human-readable output.

## Motivation

Finding 2 of the November 25 review used a real Node CLI process and identical input. A regular file received all 1,239,393 bytes of a 100-row JSON result. A slow pipe received only the first 65,536 bytes. Both processes exited 0. One-off fixes in KB list would leave the same pattern in other commands. [Review evidence](../review-evidence/20261125/cli.py)

## Design

### Approach

Give normal successful actions a shared completion operation. It preserves explicit exit 0 for existing callers and tests, while delaying the exit until previously accepted stdout writes have finished. A single place owns the stream completion logic. Each action returns at its current success branch, including branches that finish halfway through a formatter. A formatter keeps writing in its existing format as pages arrive. Buffering the whole result would change the behavior of log follow.

Illustrative control flow:

```text
render result using existing formatter
return from this success branch through the shared completion operation
  when preceding writes have finished, exit with 0
  if pending output fails to reach the local writable stream, exit with 1
```

### Failure Handling

For an open pipe, backpressure delays completion until the reader makes progress. A failed result write, including a consumer closing early, yields status 1. This also applies if the stream failed between pages and the queue is empty by the time the command finishes. Diagnostics belong on stderr. No progress text, completion banner or delimiter is added to stdout. Existing nonzero command statuses and deliberate signal exits retain their meanings. For example, `kb list --json` given an empty array writes `[]` and a newline. `fleet job logs job-1 --json` emits one JSON object per line. Output equivalence is measured against the same command with the same input redirected to a regular file.

### Integration

The baselines locate existing code. The targets define the behavior to implement.

- `apps/cli/src/utils/output.ts` contains the existing synchronous renderers. **Target addition:** export `finishSuccess(): void` here for command actions. With an idle, healthy stdout, the existing successful exit may happen immediately. If output is pending, register completion and return control to the caller. Callers terminate their own branch explicitly. Completion accounts for stdout’s existing error or destroyed state as well as errors while waiting. A zero-length queue is an immediate-success case only for a healthy stream. The implementation can use a write-completion callback ordered behind previous bytes. A drain event alone need not mean that all bytes finished writing.
- `kbCommand(program: Command): void`, `registerLogs(job: Command, deps?: LogsDeps): void` and sibling Commander registrations keep their public signatures. **Baseline:** normal actions often call `process.exit(0)` immediately after rendering. **Target:** all Koda-owned success exits following result output use the completion operation, including synchronous root actions and conditional exits such as reachable `fleet repo check`. Ordinary actions already returning naturally with complete output can keep doing so. The log-follow interrupt callback and process signal handlers are separate lifecycle paths.
- `evaluateCommand` is a control-flow example. Its JSON branch exits before the human report and threshold check. That branch must return when scheduling completion. Existing error mapping in `utils/error.ts` and the generated API client are read-only inputs.

## Out of Scope

- Changes to generated API types, KB array rendering and KB indexing-result messages belong to separate findings.
- Framework-generated help and version flags and internal Commander parser exits are outside the Koda action-result contract.
- Interrupted commands retain existing signal behavior. Normal completion of log follow remains in scope.
- Reworking diagnostics on pre-existing nonzero command paths, guaranteeing delivery of stderr, and retrying a failed stdout write are deferred.
- Remote receipt, filesystem durability after OS write completion, and consumption by downstream applications are outside the local stream guarantee.

## Stories

**US-001: Complete ordinary CLI action output before success.** Workdir: `apps/cli`. No dependencies.

Implement the completion operation for idle, pending and failed stdout. Adopt it in root, configuration and non-fleet actions. Preserve their early returns and exit contracts. Exercise the executable with large JSON and human-readable output. An idle stream still supports synchronous exit spies. Verify with the package’s `bun run test`, `bun run type-check` and `bun run lint`.

**US-002: Complete fleet action output and preserve incremental log delivery.** Workdir: `apps/cli`. Depends on US-001.

Apply the shared completion operation to the fleet actions, including a conditional exit and natural completion of paginated and follow-mode logs. Existing follow interruption retains its separate path. Verify with the same CLI package commands.

### Context Files

**US-001**
- `apps/cli/src/utils/output.ts`
- `apps/cli/src/commands/kb.ts`
- `apps/cli/src/commands/config.ts`
- `apps/cli/src/commands/evaluate.ts`
- `apps/cli/src/index.ts`

**US-002**
- `apps/cli/src/utils/output.ts` — US-001 adds the callable completion operation to this existing file.
- `apps/cli/src/commands/fleet-repo.ts`
- `apps/cli/src/commands/fleet-job-logs.ts`
- `apps/cli/src/commands/fleet-repo.spec.ts`
- `apps/cli/src/commands/fleet-job-logs.spec.ts`

### Creates

**US-001**
- `apps/cli/src/cli-output-completion.integration.spec.ts` — real Node child-process tests for ordinary action completion.

**US-002**
- `apps/cli/src/commands/fleet-output-completion.integration.spec.ts` — executable fleet streaming tests and registered-action wiring coverage.

### Modifies

**US-001**
- `apps/cli/src/utils/output.ts` — expose the normal-success operation alongside existing renderers and keep their formatting contracts.
- `apps/cli/src/utils/output.spec.ts` — exercise idle, pending and failed stdout completion with controlled streams.
- `apps/cli/src/commands/auth.spec.ts` — its whole-module output mock exposes only table and error. Retain those stubs and pass through the real finishSuccess so successful action tests still observe exit 0 on idle output.
- `apps/cli/src/commands/user.spec.ts` — its whole-module output mock exposes only table. Retain the table stub and pass through the real finishSuccess so successful action tests still observe exit 0 on idle output.
- `apps/cli/src/commands/admin.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/agent.ts` — End the JSON and empty-result pickup branches at their success boundary so they cannot enter the ticket formatter.
- `apps/cli/src/commands/approval.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/auth.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/ci-webhook.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/code-intel.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/comment.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/config.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/context.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/evaluate.ts` — Return from the JSON success branch before the human report and threshold evaluation.
- `apps/cli/src/commands/init.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/kb.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/label.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/login.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/member.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/memory.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/notifications.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/project.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/role-binding.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/ticket-watch.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/ticket.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/user.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/vcs.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/webhook.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/index.ts` — Complete the root version and config actions after their existing stdout writes.

**US-002**
- `apps/cli/src/commands/fleet-analytics.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/fleet-budget.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/fleet-config.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/fleet-dispatch.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/fleet-ingest.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/fleet-job-logs.ts` — Complete the final page after NDJSON or text writes finish. Preserve the separate follow-interrupt callback.
- `apps/cli/src/commands/fleet-job-rulings.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/fleet-job.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/fleet-repo.ts` — Complete the reachable check and ordinary successful repo actions after pending writes. Preserve the unreachable status 1 and the safe-result warning channel.
- `apps/cli/src/commands/fleet-runner.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/fleet-schedule.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.
- `apps/cli/src/commands/fleet-status.ts` — Replace immediate successful termination in this command’s result branches with output-aware completion, preserving its existing rendering and failure paths.

### Seams

US-001 adds `finishSuccess(): void`. US-002 drives the registered `fleet repo check fr1 --json` action with a reachable API result and a recording collaborator. The unreachable result exercises the existing nonzero exit. Separate real Node child-process cases cover byte delivery for the log commands.

## Acceptance Criteria

Use fresh Node processes for CLI criteria. Feed identical deterministic API responses to both runs. The large payload must exceed the host pipe capacity, include multibyte text and carry a known final record. Delay reading through a controlled pipe, then drain it. A regular-file reference must itself contain the known final record. Capture stdout, stderr and the actual child exit status independently. Use job ID `job-1` for the fleet-log fixture, with a valid project context and an attempt containing log entries.

### US-001

- [cli] For a 100-row response exceeding one MiB, `koda kb list --json` delivers exactly the regular-file reference bytes to a slow pipe, including the final newline.
- [cli] In the successful slow-pipe `kb list --json` case the actual Node child exits 0. Observe exit independently of when the reader consumes the last bytes.
- [cli] With enough named profiles in a disposable CLI config to exceed pipe capacity, `koda config profile list` delivers the same complete human-readable table through a slow pipe as through a regular file.
- [cli] With an evaluation below the human-mode threshold and enough per-query results to leave stdout pending, `koda evaluate --json` emits exactly the expected JSON document followed by a newline.
- [cli] In that backpressured below-threshold fixture, the actual `koda evaluate --json` child exits 0.
- [unit] When a registered `kb list --json` action successfully renders one API result, the recording `finishSuccess` collaborator is invoked once.
- [unit] With an idle healthy stdout, calling `finishSuccess()` invokes the success exit synchronously.
- [unit] With one pending stdout write held by the fixture, `finishSuccess()` defers the success exit until that write completes.
- [cli] If the reader closes a pipe while a large `kb list --json` result still has pending writes, the process exits 1.
- [unit] When stdout has already failed a result write and its queue is now empty, `finishSuccess()` selects exit 1.

### US-002

- [cli] A multi-page `koda fleet job logs job-1 --json` run with a known last entry delivers the expected ordered NDJSON bytes to the slow reader.
- [cli] An actively polling `fleet job logs job-1 --follow --json` exposes its first complete NDJSON record to the reader before the fixture marks the stream complete.
- [cli] On natural completion of `fleet job logs job-1 --follow --json`, the slow reader receives through the final expected entry.
- [unit] With a reachable API result and a recording `finishSuccess` collaborator, invoking the registered `fleet repo check fr1 --json` action calls it once with no arguments.
- [cli] An unreachable `koda fleet repo check <id>` keeps its existing exit status 1.
