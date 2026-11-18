# Flow handoff: koda publishes and finishes a feature run in nax chat (#477)

Status: APPROVED 2026-11-17 by the owner. koda half specified in `.nax/features/flow-handoff/spec.md`.
Issue: koda #477. nax side: nathapp-io/nax#2968 items 6-7.

## Intent

The 2026-11-04 ruling splits the work: **koda owns the always-on flow**, including the finish (agent rulings, then
ready). A `nax chat` chain stays the tool for one feature watched in one sitting. Today the split has a hole: a
feature planned and run in a chat chain ends as a draft PR held by open items (advisor holds, cannot-verify items,
findings), and the only ways to finish it are by hand or by re-running the whole flow from its spec in koda.

The owner's goal is full automation including the finish. A feature run in chat must be able to go to koda, after
one koda approval, and come out ready with no human ruling whenever each item's evidence supports a ruling.

## What is in the way (verified 2026-11-17)

1. **nax trusts only its own login.** `readItemThreads` reads the item index and item threads through
   `ownComments(comments, login)` (`packages/nax/src/forge/marker.ts:27`). On nax PR #2965 the index was written by
   the owner's account. koda runs nax as its own bot (GitHub App or GitLab bot user), so its `nax bot fix` would
   report `no nax item index on this PR` (`packages/nax/src/bot/workflow-ready.ts:46`) and could never ready it.
2. **The run record is not on the branch.** `.nax/features/*/workflow/` is git-excluded. The record
   (`workflow/<runId>/result.json`, `ledger.md`) exists only on the machine that ran the chain, so a runner cannot
   run `nax workflow status` or anything else that needs it from a checkout.
3. **koda's finish is anchored on a koda RUN job.** RULE reads `openItems` from the flow's RUN job `workflow`
   snapshot (`fleet-flow-advance.service.ts:386,745`), rulings are stored against `runJobId`
   (`fleet-pr-rulings.service.ts:211`), and FIX's ruling snapshot finds that RUN by PR (`latestRunForPr`).

## Approaches

### Who publishes the PR koda finishes

- **A. Hand over before publishing. CHOSEN by the owner.** The chain runs the feature without publishing and hands
  the branch and the run record to koda. koda publishes under its own identity, then finishes. koda is the only
  publisher of anything it finishes, so nax's own-login rule holds unchanged.
- B. Re-publish on adoption: the owner's draft stays, koda re-posts the index and threads as itself. Works for
  already-published drafts, but every adopted PR carries two sets of item threads.
- C. nax trusts other publishers (an allow-list or anyone with write access). Least koda plumbing, but it loosens
  a trust rule nax keeps on purpose.

### How the run record reaches koda's runner

- **T1. Upload it with the handoff request. CHOSEN by the owner.** No forge side effects; costs a new, capped
  upload path.
- T2. Push it to a side ref (`refs/nax/handoff/<feature>`). No upload API, but leaves refs on the forge to clean
  up, and protected-ref rules can refuse the push.
- Ruled out: committing the record to the branch. It moves HEAD, and `--publish-only` refuses a moved HEAD.

## The mechanism nax already has

- `workflow.publish` (`pr | push | none`, `schemas-workflow.ts:57`) lets a run end without a PR: outcome `pushed`
  (branch on the remote) or `local-only`.
- `nax run -f <feature> --publish-only` (#2819) publishes such a run later from its record: it needs the newest
  prior record at `step: done` whose `head` equals HEAD, and outcome `local-only` or `pushed`; otherwise it refuses
  (`packages/nax/src/workflow/publish-only.ts:57`). Nothing is reviewed again.

So the handoff is: chain runs with no publish, sends branch + record, koda's runner restores the record and runs
`--publish-only` as koda. The result is exactly what a koda RUN produces: a PR, a result sha and a `workflow`
snapshot with open items.

## Design

### nax side (nathapp-io/nax#2968 items 6-7)

1. **Chain step `handoff`.** A chat chain may end in `handoff` instead of `publish`. `publish` stays for work
   watched to the end in one sitting. (Owner's call, as proposed.)
2. **The run step before a handoff does not publish.** When the chain's last step is `handoff`, its `run` step
   runs so the outcome is `pushed` or `local-only`, never a PR. How the run is told (a run flag or a per-run
   override of `workflow.publish`) is the builder's call.
3. **`handoff` = `nax-flow__send`, handoff form.** Instead of `features`, the request carries
   `handoff: { feature, headSha, record }` plus the existing top-level `remoteUrl`, `branch`, `roles` and
   `costCapUsd`; each record entry is `{ runId, file, mtimeMs, content }`. The exact wire shape is the contract in
   koda `.nax/features/flow-handoff/spec.md`. The tool pushes the
   branch if the run left it local (as it already pushes for spec flows), then calls koda.
4. **Local refusals before anything moves** (koda re-checks): no finished record for the feature; record not at
   `step: done`; outcome is `ready` or `draft` (already published); record `head` differs from HEAD; working tree
   dirty in tracked files; record larger than the cap.
5. **Chain result.** `handoff` ends `succeeded` with the koda flow id and URL. The chain stops there; the flow's
   progress is koda's.
6. **No second publisher (my call).** A successful handoff marks the local record handed off (flow id, koda URL,
   time). `--publish-only` and the chat `publish` step refuse a feature whose newest record is handed off, naming
   the flow. A fresh `nax run` that changes HEAD writes a new record and clears this naturally.
7. **A refused create (my call).** When koda refuses the create, `handoff` ends `failed` with koda's reason and
   leaves the local record untouched, so the owner can retry the handoff or publish locally. A later RUN failure in
   koda is the flow's stop, seen in koda, not in the chain.

### koda side

1. **API.** The existing NAX-entry create (`POST /api/fleet/flows`, `parseFlowInput`) accepts the handoff form as
   an alternative to `features`. Validation:
   - `feature` matches `FEATURE_RE`; `branch` matches `GIT_REF_RE` and is not the repo default branch;
     `headSha` is 40 hex; `remoteUrl` resolves to a registered FleetRepo (as today).
   - `record` is a list of `{ path, content }`. Each path is `<runId>/<file>` relative to
     `.nax/features/<feature>/workflow/`, no `..`, no absolute paths, only the files `--publish-only` reads (see
     builder's list below). Count and total size are capped (the builder sets the numbers; the files are KBs).
   - The newest run's `result.json` parses; its feature record is `step: done`, outcome `pushed` or `local-only`,
     and its `head` equals `headSha`.
   - Refused when a live flow already owns this repo and branch, or when the forge already has an open PR for the
     branch (read with the repo's read credential; fail closed for this check).
   - Works on GitHub and GitLab repos alike (GitLab flows shipped in #476).
2. **Storage.** The flow has one feature. The record is stored on that feature (a nullable JSON column, or a
   child table; builder's call), and its presence marks the flow as a handoff. `specSha`/`setSha` take
   `headSha`; `specPath` is `.nax/features/<feature>/spec.md`.
3. **Approval.** The flow is created `PENDING` and needs the usual koda approval. Nothing billed starts before it.
   The per-thread tickbox does not apply to the NAX entry, as today.
4. **Steps.** A handoff flow's first step is **RUN with publish-only**; then the existing chain applies unchanged:
   `RUN -> REVIEW -> RULE -> FIX -> complete`, with #413's one automatic RULE/FIX round and then one
   `WAITING_ANSWER` listing each item still held. SPEC_REVIEW, PLAN and PRD_REVIEW are skipped.
5. **Runner.** The RUN assignment for a handoff carries `publishOnly: true` and the record. The runner checks out
   the branch at `headSha` (refusing when the remote branch head differs), writes the record files under
   `.nax/features/<feature>/workflow/`, and runs
   `nax run --headless --json -f <feature> --profile <chain> --max-cost <cap> --publish-only`
   (`apps/runner/src/executor/nax-process.ts:57` plus the flag), with `workflow.publish` forced to `pr` for this
   job whatever the repo config says. It runs under koda's forge identity, so the item index and threads are
   koda's. The bundle ingest is unchanged: the job's `workflow` snapshot, PR and result sha come back exactly as for
   a normal RUN.
6. **Evidence for RULE (my call: parity with koda-made PRs).** RULE and FIX get exactly what they get after a
   normal koda RUN: the item snapshot from the RUN job plus a fresh checkout of the PR head. In a normal flow the
   record never reaches those jobs either, so the record is transported only for `--publish-only`, not as rule
   evidence.
7. **PRD on the branch.** `--publish-only` needs every story passed in `prd.json`; a workflow run auto-commits the
   PRD status, so it is on the pushed branch. The nax-side refusal list checks it (all stories passed in the
   committed PRD) so a handoff never fails at RUN for this.
8. **Failures.** A `--publish-only` refusal (HEAD moved, record invalid) fails the RUN, and the flow stops with the
   existing failed-step path; the stop detail carries nax's refusal text.
9. **Ticket and audit.** As NAX-entry flows today; the RULING comments are visible on the flow's ticket (#413).

## Goals

- A chat-run feature, handed over, reaches ready after one koda approval with no human ruling, whenever each
  item's evidence supports a ruling.
- Rulings are posted with evidence, and visible on the flow's ticket.
- After one automatic round, a PR still held produces exactly one `WAITING_ANSWER` listing each open item.
- Every refusal names its reason. Nothing billed starts before approval.

## Non-goals

- Adopting a draft already published from chat (approach B or C territory).
- Merging, releasing, deploying.
- A PR from another repo or a fork.
- Changing nax's own-login trust rule.

## Anti-goals

- A handoff that makes the owner rule items koda could have ruled.
- A second publisher on a koda-finished PR (two item indexes or two thread sets).
- A record that reaches the runner unchecked: path traversal, oversize, or a record for another head.

## Constraints

- 11-04 split: the flow runs in koda, not in the nax chain.
- nax PIPELINE mode is frozen; this is workflow mode only.
- The record comes from an authenticated user with flow-create permission; it gets the same trust as the specs
  `nax-flow__send` sends today. koda validates its shape, never its truth.

## Left to the builder

- The exact set of record files `--publish-only` reads (at least `result.json` and `ledger.md` of the run
  directories it walks; the large `package-branch*.diff` and `branch-review.json` only if publish needs them), and
  the count and size caps.
- How the chain's `run` step is told not to publish.
- The record's storage shape in koda and whether a flow-level discriminator is added.
- How the runner forces `workflow.publish: pr` for the job (a profile, a CLI override or a config layer).
