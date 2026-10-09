# Code Review: PR 249 — feat(fleet-s4c): team access, agent roster and scoping

**Date:** 2026-10-09
**Reviewer:** Subrina (AI)
**Scope:** 119 files vs `main` (API roster/scoping/assignees, web roster page + picker, CLI `project agents`, openapi.json + generated client)
**Spec:** `.nax/features/fleet-s4c-team-access/spec.md` (US-001..US-007)

---

## Overall Grade: B+ (84/100)

Solid, well-tested feature work: fail-closed scoping, lock-serialized roster writes, contract cleanly regenerated, no CRITICAL or HIGH findings. The main deductions are three MEDIUM web interaction bugs (stale select after failed PATCH, add-dialog double submit, AssigneePicker error handling), the deferred roster-read cost, and the scoping-flag duplication. During review, two reviewer questions were settled in code: the global error envelope was **removed per spec** (no envelope change), and the 409 refs separator was aligned to the spec's `', '`.

---

## Spec Questions — Resolutions

| # | Question | Resolution |
|:--|:--|:--|
| 1 | Refs separator in `hasOpenTickets.409`: spec table says `', '`, AC-34 refined text said `','` | **Spec wins.** The PRD itself (prd.json US-003) says "refs = up to 10 refs joined with `, `" — the refinement introduced the deviation. Changed `agents.service.ts` to `join(', ')` (matches the existing `fleet-jobs.service.ts` precedent); AC-34 refined text corrected in `acceptance-refined.json` to be message-based and separator-accurate. |
| 2/6 | Self-call PATCH on an unrostered agent: spec table says 404, US-002 AC12 says 403 | **Both are right — the contract is caller-dependent, keep current behavior.** An unrostered agent calling with its own key is refused 403 by `ProjectMembershipGuard`/`resolveMembership` (fail-closed roster check, scoping on) — that is AC12. An *admin* PATCHing an unrostered agent gets 404 from the roster resolution — spec table + AC11. The extra self-403 branch in `updateProjectAgent` only fires where the guard is bypassed (unit tests calling the handler directly); harmless, LOW note below. |
| 3 | Error envelope (deviation 1) | **Resolved by decision: follow the spec, no envelope change.** `KodaExceptionsFilter` deleted (it was byte-identical to the library `GlobalExceptionsFilter` once `data` was dropped — proven by the deleted module spec's own control test). `app.module.ts` registration removed; e2e `refusal()` helper now asserts `{ ret, message }` and **pins that `data` is absent**; i18n key specs kept (comment-only updates). Nothing in web/CLI ever read `data.key`/`data.args`. |
| 4 | Roster read cost (deferred) | **Deferral accepted.** `findProjectRoster` loads all open tickets per read and `addToProject` re-reads the whole roster under the lock to return one row. Query-shape change (`groupBy` count + capped per-agent refs) belongs in a follow-up with its own tests. |
| 5 | Scoping flag duplicated across services (deferred) | **Deferral accepted.** "Absent means on" lives in `ProjectAccessService.agentScopingEnabled`, `AgentsService.agentScopingEnabled`, and the `auth.config` default. Single-source refactor as follow-up. |

## Deviations — Verdicts

1. **Global error envelope** — **Removed** (see Q3). Moot.
2. **Radiogroup semantics** — Acceptable. Final agents-page status control is a native `<select aria-label="Status">`; the radiogroup+`aria-pressed` pattern remains only in `ProjectMembersPanel`, where every group has an accessible name. Radio-semantics cleanup can ride a later a11y pass.
3. **Env validation message overwrite** — Keep. Spec line ("API startup fails validation naming the variable") is only observable in the boot log, which prints `message`; the overwrite *implements* the spec rather than deviating from it.

---

## Findings

### 🔴 CRITICAL / 🟠 HIGH
None.

### 🟡 MEDIUM

#### WEB-1: Stale status shown after a failed PATCH (BUG)
`apps/web/pages/[project]/agents.vue:123-132,253-262` — after a rejected status change, `refresh()` returns items with the same `status` values, so the `<select :value>` vnode is unchanged and Vue never reverts the DOM selection; the row keeps displaying the refused status.
**Fix:** remount the select on failure (`:key` including an attempt counter) or reset `select.value` in the catch.

#### WEB-2: Add-agent dialog allows double submit (BUG)
`apps/web/pages/[project]/agents.vue:105-121`, `AddProjectAgentDialog.vue:129` — Confirm stays enabled during the POST; a double-click emits `added` twice and the duplicate 409 reopens the dialog with a bogus error after a successful add.
**Fix:** `adding` ref + re-entry guard + disabled Confirm (mirroring `TicketProperties.assigning`).

#### WEB-3: AssigneePicker hides fetch errors and lazy-uses `useAppToast` (BUG)
`apps/web/components/AssigneePicker.vue:48-58` — a failed search renders the "no matches" empty state (indistinguishable from a legit empty result); `useAppToast()` is captured inside the async catch rather than at setup, which can throw outside the Nuxt instance and get swallowed.
**Fix:** capture the toast at setup; render an inline error state like the add-dialog's `candidatesError`.

#### API-1: Roster read cost (PERF, deferred by review)
`agents.service.ts` — `findProjectRoster` loads every open ticket for the project per read; `addToProject` runs that read under the roster lock just to return one row. Accepted follow-up (Q4).

#### API-2: Scoping flag sourced in three places (ENH, deferred by review)
`project-access.service.ts:19-21`, `agents.service.ts:346-348`, `auth.config.ts:77`. Accepted follow-up (Q5).

### 🟢 LOW

| ID | Where | Note |
|:--|:--|:--|
| API-3 | `projects.controller.ts:243-251` | Self-403 branch is a guard mirror kept for unit-level AC12; refusal key differs from the guard's (`projectAgents` vs `projects`) for the same caller state. Consider exercising AC12 through the guard instead. |
| WEB-4 | `useProjectAgents.ts:42-54` | No request-sequence guard on `load()`; overlapping refreshes can resolve out of order. |
| WEB-5 | `agents.vue` | No per-row pending state on status select / Remove; concurrent per-row mutations possible. |
| WEB-6 | `AssigneePicker.vue:39-59` | No AbortController; superseded searches run to completion. |
| WEB-7 | `agents.vue:49-62` | Hand-rolled viewer role resolution; siblings use `useProjectViewerRole`. |
| WEB-8 | `useProjectAgents.ts:68-70` | Status union lives in the page only; export from the composable. |
| WEB-9 | `layouts/default.vue` | No nav/breadcrumb entry for `/[project]/agents` (reachable by URL only). |
| WEB-10 | `i18n/locales` | Dead keys (`agents.project.openTickets`, `addFailed/removeFailed`, `removeProjectAgent.blocked`); zh halfwidth `?`. |
| CLI-1 | `.gitignore:22` | `apps/cli/src/generated/` ignored while docs claim it is source-controlled; fresh checkout fails type-check until `bun run generate`. |
| CLI-2 | `project.ts:41` | Scoping-off notice printed via `error()` (red ✗, stderr) but exits 0; not the structured JSON error shape in `--json` mode. |
| CLI-3 | `project.ts:22-84` | No CLI command for PATCH roster status (API/web only). Record as intentional or add `agent-update`. |
| CLI-4 | `project.ts:69-84` | `agent-remove` has no `--force` confirmation while `project delete` does. |
| CLI-5 | `project.spec.ts:582` | 409 mocked as `{ statusCode, message }`; the real client throws `{ ret, message }`. |

## Verified correct (highlights)

- Scoping is fail-closed and single-decision (`resolveMembership`), absent-config-means-on, legacy roles allow-listed; runners unscoped by design.
- Roster writes serialize on one advisory lock class shared with the assignment path (no lock ordering → no deadlock); the concurrency AC is pinned by e2e.
- Web blocked-removal flow uses `openTicketRefs` off the roster row — never parses the error message; picker eligibility is enforced server-side, not duplicated client-side.
- CLI uses the generated client only, prints the translated message, exits 1 on API errors; no `data.key`/`data.args` reads anywhere.
- openapi.json + generated client match the implemented routes/DTOs field-for-field.

## Verification after review fixes

| Gate | Result |
|:--|:--|
| API unit (`bun run test`) | 4460/4466 suites' tests pass (Δ −6 = deleted filter specs) |
| API e2e `endpoint.e2e.spec.ts` (DB mode, compose PG) | 173/173 |
| `turbo lint` / `type-check` (api) | pass |

## Priority Fix Order

| Priority | ID | Effort | Description |
|:--|:--|:--|:--|
| P1 | WEB-1 | S | Revert select display after failed status PATCH |
| P1 | WEB-2 | S | Guard add-dialog double submit |
| P1 | WEB-3 | S | AssigneePicker inline error + setup-time toast |
| P2 | API-1 | M | Follow-up: roster count via `groupBy`, capped refs |
| P2 | API-2 | M | Follow-up: single source for the scoping flag |
| P3 | LOWs | S | Batched polish (web races/a11y/nav, CLI hygiene) |
