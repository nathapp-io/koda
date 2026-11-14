# Whole-Repo Code Review and Gap Analysis: koda

**Date:** 2026-11-14
**Reviewer:** Subrina (AI)
**Version:** 0.4.2, main `b98893e4`
**Scope:** `apps/api`, `apps/runner`, `packages/fleet-protocol`, `apps/cli`, `apps/web`, CI and release workflows, Dockerfiles, compose files and `deployments/`.
**Prior review:** `docs/20261101-review-whole-repo.md` (base `61052931`, C+ 74/100). 56 commits since. The main ones:
- the P0 bundle (#381)
- fleet PR finish (#390) and the provider credential vault (#398)
- thread agents and modes (#397)
- the full fleet-flow series (#400-#419)
- the thread placement bundle (#427)
- memory notes, search and outbox actions (#389, #440, #457)
- web UX audit work (#441-#455)
- the nax-agent 0.92.0 bump (#454)

**Baseline:** Tests were not run. This is a static review.

**Method:**
- Four read-only reviewers, one per area (same split as 11-01). Each did three passes:
  1. Status of every 11-01 finding in its area.
  2. Code review, weighted towards the 56 new commits.
  3. Gap analysis of the designs and specs against what is built.
- Checked by hand during consolidation:
  - **A/SEC-12 held.** `permissions/catalog.ts:170-183`: `HIGH_RISK_PREFIXES` does not cover `fleet.job.dispatch`, `fleet.job.config.edit` or `fleet.schedule.create`, so they classify `medium`.
  - **B/BUG-4 held.** `fleet/flows/fleet-flow.ticker.ts:58-60`: the per-flow catch only logs. Nothing counts failures or writes a stop.
  - **D/SEC-14 downgraded to LOW.** Although the runner writes `forge-token` into the job dir for GitHub RUN, nax reads and deletes the token file at startup, before the raw RUN agent can read it. The separate fresh-wait/expiry defects remain under D/BUG-9.
  - **D gap "TLS and Secure cookies" held, with a nuance.** `apps/web/server/utils/api.ts:47,56` hard-codes `secure: true`. Browsers accept Secure cookies on `localhost`, which is why koda-wk works. A LAN or prod host reached over plain HTTP cannot keep a session.
  - **Two reviewer-B gap rows were wrong and are corrected in section B.4:**
    - #374 is built: a per-repo FIX check-commands override in `fleet/repos/*fix-checks*` plus the runner's `nax/trust.ts`, closed by PR #383.
    - #375 was closed by a decision in PR #427 to keep the koda thread skill tools.

Finding IDs are prefixed with their area letter and continue after the 11-01 numbering, so IDs never collide. For example, **A/SEC-12** is new, and **A/SEC-1** is the 11-01 item.

---

## Overall Grade: B- (76/100)

| Area | Security | Reliability | API Design | Code Quality | Best Practices | Total | 11-01 |
|:--|--:|--:|--:|--:|--:|--:|--:|
| A: API platform, permissions, approvals, tickets | 16 | 15 | 16 | 15 | 15 | 77 | 74 |
| B: Fleet control plane, flows, threads, MCP | 17 | 16 | 16 | 15 | 17 | 81 | 82 |
| C: Fleet ops, memory, VCS, webhooks, outbox, RAG | 16 | 14 | 16 | 14 | 15 | 75 | 72 |
| D1: Runner, protocol, CLI | 14 | 15 | 16 | 14 | 15 | 74 | 73 |
| D2: Web, CI, deploy | 15 | 14 | 15 | 15 | 14 | 73 | 68 |
| **Mean** | **15.6** | **14.8** | **15.8** | **14.6** | **15.2** | **76.0** | 73.8 |

This is the first review with **no HIGH findings**. All four 11-01 HIGHs are fixed or closed by ruling:
- **A/SEC-1, A/SEC-2:** fixed in #381.
- **D/BUG-1:** the SSR probe now refreshes.
- **D/SEC-1:** closed by ruling; the `trust_domain` placement rule was built in place of the socket nonce.

The backlog finally moved. 11-01 had 0 of 42 D/E items fixed. This time:

| Area | Fixed | Partial | Open | Closed by ruling | Total |
|:--|--:|--:|--:|--:|--:|
| A | 6 | 5 | 8 | 0 | 19 |
| B | 3 | 1 | 6 | 0 | 10 |
| C | 6 | 2 | 5 | 0 | 13 |
| D | 12 | 5 | 6 | 1 | 24 |
| **All** | **27** | **13** | **25** | **1** | **66** |

The new code is solid:
- **Fleet flows** (about 20 PRs) is a state machine that runs a spec to a ready PR with one approval. It locks rows, fences runner writes and declares its refusals.
- **Memory notes, search and export** showed no cross-project or cross-user leak and no FTS injection.

What remains falls into three groups:
1. **Trust-posture decisions that are drifting rather than being made.** The FIX push scope beyond the default branch (B/SEC-1 partial, D/SEC-3), sandboxing for raw kinds (D/SEC-2) and agent-held spend keys at tier `none` (A/SEC-12). Each needs a ruling, not a patch. D/SEC-14 is LOW: nax reads and deletes the RUN token file at startup.
2. **Production readiness.** koda-wk is a localhost deployment. The 11-14 prod plan (k3s api+web+Postgres, runner on the Mac) has no manifests, no TLS path (and Secure cookies need one), no off-host backups or restore drill, and `/api/health` has no DB readiness check.
3. **Table-stakes product gaps.** There is no self-service password change or reset, refresh tokens are not one-time, and there are no ticket due dates, bulk operations, attachments or full-text ticket search.

---

## Findings index

### HIGH (0)

None.

### MEDIUM (2 new)

| ID | Title | Location |
|:--|:--|:--|
| A/SEC-12 | Spend and repo-write keys that agents hold (`fleet.job.dispatch`, `fleet.job.config.edit`, `fleet.schedule.create`) classify `medium`, so a Developer agent runs them at approval mode `none`. Budgets are the only cap. Needs consolidated ruling 6. | `permissions/catalog.ts:170-183,234,247,264`; `permissions/system-roles.ts:75,84` |
| B/BUG-4 | A flow that hits an undeclared error is retried on every tick. There is no failure budget, no stop and no user-visible reason, only one error log per tick. | `fleet/flows/fleet-flow.ticker.ts:58-60`; `fleet-flow-advance.service.ts:168,305,400,417-421,658` |


### Prior MEDIUMs still open or partial (carried, see the area tables)

| Area | IDs |
|:--|:--|
| A | SEC-6 partial (credential-write tiering; `user.update` lets an agent with Admin disable other admins); BUG-1 partial (invite email still sent inside the approval transaction); ENH-1 partial (workflow comments mutable) |
| B | SEC-1 partial (REVIEW is now read-only; FIX keeps a repo-wide write token) |
| C | SEC-2 partial (approver verified, but the PR author can approve their own "not a defect"); carried BUG-1 partial (budgets still count soft-deleted projects) |
| D | SEC-2 partial (runner git hardening, sandbox for raw kinds); SEC-3 partial (FIX push to non-default branches); BUG-4/5/6 partial (BUG-6: a 5xx from `/api/auth/me` on page load still logs the user out) |

### LOW (15 new)

| Area | IDs |
|:--|:--|
| A (4) | SEC-13 (`fleet.thread.preapprove` granted to agents at `none`; inert only because the controller refuses agents), BUG-5 (a PR created after commit can lose its TicketLink, and a later verify opens a second PR), BUG-6 (status PATCH picks its approval key from an unlocked read), STYLE-3 (`ticket-transitions.service.ts` 856 lines) |
| B (3) | BUG-5 (ticker restarts from the lowest id each tick and starves flows beyond 500; merge watch polls GitHub every tick with no backoff), PERF-2 (`GET /fleet/flows/:id` loads all the caller's projects), ENH-1 (`fleet-flow-advance.service.ts` 1008 lines) |
| C (3) | BUG-6 (a concurrent write of the same note slug becomes an unhandled P2002 or serialization error), SEC-4 (outbound webhook signature has no timestamp), PERF-2 (ranked search runs `count(*)` over every match on each page) |
| D (5) | SEC-14 (LOW; nax reads and deletes the RUN token file at startup), BUG-9 (the RUN identity waits for 50 minutes of token life but the API ignores `fresh` for RUN), SEC-15 (release passes `TURBO_TOKEN` as an undeclared build-arg), BUG-10 (DATABASE_URL built by raw password interpolation), SEC-16 (tracked `apps/api/.env.test` with secret-named keys) |

---

## Gap analysis summary

The full per-area tables are in sections A.4 to D.4 below.

**Designed and now built (closed since 11-01):**
- **nax-integration issues #367-#375:** all closed.
  - #367 nax-agent bump: now 0.92.0.
  - #368 ACP thread backends (Claude Code, Codex, Cursor).
  - #369 coding threads: built as modes `read`/`ask`/`full`, not the `write`/`shell` profile names in the issue.
  - #370 C11 rule and context overrides.
  - #371 vault on nax `credentials.source`.
  - #372 ESCALATED draft promote.
  - #373 FIX ready result.
  - #374 FIX check-commands override.
  - #375 closed by decision.
- **2026-07-06 gap list and specs:**
  - outbound webhooks through the outbox
  - VCS phases 2-4
  - budget ledger reconciliation
  - story graph, analytics and dashboard
  - memory SPEC-003/005
  - memory notes (user scope, FTS, export, proposals)

**Open gaps, ranked:**

| # | Gap | Area | State | Priority |
|--:|:--|:--|:--|:--|
| 1 | TLS path for prod; Secure cookies make plain-HTTP LAN or prod logins impossible | D | Missing | P1 |
| 2 | Off-host DB backups, schedule and restore drill | D | Local-only script | P1 |
| 3 | k3s manifests and migrate Job, per the 11-14 prod plan | D | Missing (compose only) | P1, after the k3s decision |
| 4 | Self-service password change and password reset | A | Missing | P1 |
| 5 | One-time refresh tokens with reuse detection | A | Missing (logout bumps `tokenVersion` only) | P1, ruling 12 |
| 6 | Invite email after commit, as the S4b design says | A | Partial | P1 |
| 7 | Sandbox for raw job kinds; FIX push refspec allowlist | D | Not built | P1/P2, rulings |
| 8 | Budget pause for soft-deleted projects | C | Half-built | P1, ruling |
| 9 | CI webhook and outbound webhook signature v2 (timestamp, delivery id) | C | Open | P1/P2, ruling |
| 10 | `/api/health` readiness with a DB ping; metrics and tracing | D | Liveness only | P2 |
| 11 | Retention for AuditEntry, ApprovalRequest/Decision, WebhookDelivery | A | Not built | P2, ruling 10 |
| 12 | MFA for Owner and Admin; agent API-key expiry | A | Missing | P2 |
| 13 | Ticket due dates, bulk operations, ticket and comment FTS, attachments | C | Missing (FTS: title `contains` only) | P2/P3, product |
| 14 | E2E coverage: expired-access-cookie reload, outage path, deep link after login; a deploy smoke job in CI | D | Missing | P1 (one e2e) / P2 |
| 15 | API routes with no web or CLI consumer: ticket workflow `start/fix/verify/verify-fix`, KB import, memory export, budget resume, repo auto-review and fix-check toggles (heuristic: 67 of 215 operations unmatched) | D | Verify each | P2 |
| 16 | Docs: S4c section 2/3.1 agent-scoping flag superseded; the flow design's open question on review-spec edits is answered in code; the C11 "deferred" note | A/B | Stale docs | P3 |

---

## Rulings needed (decisions for you, not defects)

Numbers in this list are the consolidated numbering used by the index, the gap table and the Priority Fix Order. The area sections keep their own numbering. For example, area A's "ruling 18" is item 6 here.

**Trust and token posture:**
1. **RUN forge token (D/SEC-14, downgraded to LOW).** nax reads and deletes the token file at startup, before a raw RUN agent can access it. The login-only identity is implemented. The separate fresh-wait and token-expiry defects remain D/BUG-9.
2. **FIX push scope (B/SEC-1, D/SEC-3).** Options:
   - Accept "default branch must be protected" as a deployment prerequisite.
   - Or add a runner refspec allowlist (PR head branch only).

   Also decide whether `fixAllowUnprotected` needs a second approval.
3. **Sandbox for raw kinds (D/SEC-2, carried ruling 4).** Force `sandbox` on for REVIEW, FIX, THREAD and RUN in `job-profile.ts`, or rely on the global nax config.
4. **ACP `read` mode.** It runs unsandboxed with `inheritEnv: true`. Confirm that the read guarantee relies on nax-agent-acp's profile mapping, and add a test that asserts it.
5. **Disabled runner tokens (B/SEC-4).** Should a disabled runner still receive git and provider tokens for jobs it holds? Proposed: no, and crash the held jobs.

**Permission model:**

6. **Ruling 18 (A/SEC-12).** Tier for agent-held `fleet.job.dispatch`, `fleet.job.config.edit` and `fleet.schedule.create`: keep at `none`, or make them `high` (agent-approved) or `critical` (human-approved)?
7. **Ruling 19.** May an agent with global Admin disable other admins with no approval?
8. **Rulings 7, 9 and 10 are decided in code.** Confirm and record:
   - 7: agents may request `member.add` and `invite.create`; a human approves.
   - 9: only an Owner disables an Owner.
   - 10: a PAUSED agent's gated writes are refused; its reads are allowed.
9. **Ruling 8 (still open).** Keep the project-first policy ranking?
10. **Ruling 11 (still open).** Retention periods for audit, approval and webhook-delivery rows.

**Auth and product:**

11. **Ruling 20.** Is self-service password change and reset in scope before prod?
12. **Ruling 21.** One-time refresh with reuse detection, or keep `tokenVersion` on logout as the model?
13. **Page-load outage (D/BUG-6 residual).** Recommendation: keep the session on a 5xx from `/api/auth/me` and retry, as the streams already do.
14. **Ticket due dates, bulk ops, attachments, ticket FTS.** Do these stay on the roadmap, and in what order?

**Fleet behaviour and review memory:**

15. **Flow failure policy (B/BUG-4).** How many consecutive undeclared failures before a flow stops with `internal_error`? Proposed: 5.
16. **Thread mode names (#369).** Keep `read`/`ask`/`full` and document it, or rename them to the `write`/`shell` profiles in the issue.
17. **Thread SSE for API-key principals (B/BUG-2).** Users only (fix the comment), or support keys with a re-check of the key?
18. **K2 self-approval (C, carried ruling 13).** Must the approver of a "not a defect" decision differ from the PR author?
19. **Budget pause on a soft-deleted project (C, carried ruling 15).** Keep it in force, or release it the way VCS, placement and schedules already stop?
20. **Deferred `vcs.sync.all` (C/BUG-2).** Cap the approved import, or run it after commit as its own pass?
21. **Webhook signature v2 (C/SEC-3, C/SEC-4).** Sign timestamp and delivery id under a new header, with a deprecation window.
22. **Cross-project visibility of a user's notes in the export feed.** Confirm.

**Deployment:**

23. **TLS terminator for prod.** Traefik with cert-manager, or a local CA. Without one, a non-localhost deploy cannot log in.
24. **Backup target.** Choose the off-host destination; require a restore drill before the first prod deploy.
25. **Readiness semantics.** Should `/api/health` ping the DB for the k3s readiness probe, or stay a liveness check?
26. **Release TURBO cache (D/SEC-15).** Pass it through `secrets:`, or drop the cache step.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:--|:--|:--|:--|
| LOW | D/SEC-14 | Done | Downgraded: nax reads and deletes the RUN token file at startup; the login-only identity removes the file and fresh-wait defects remain tracked as D/BUG-9. |
| P0 | B/BUG-4 | S | Per-flow consecutive-failure counter. After N failures, `writeStop('internal_error')` with an activity row; reset on success. |
| P0 | A/SEC-12 | S | After ruling 6: add the spend and repo-write keys to `HIGH_RISK_PREFIXES` or a named set, and pin each spend key's tier in a catalog test. |
| P1 | Prod bundle | M | TLS terminator, Secure-cookie-compatible config, off-host backup plus restore drill, migrate Job, DB-ping readiness, `NODE_ENV=production`. Blocked on the k3s decision. |
| P1 | A auth bundle | M | Password change and reset (ruling 11), one-time refresh with reuse detection (ruling 12), invite email after commit (A/BUG-1 remainder). |
| P1 | D/SEC-2, D/SEC-3 | S-M | After rulings 2 and 3: sandbox for raw kinds, FIX refspec allowlist. |
| P1 | C carried | S-M | Budget pause on soft-delete (ruling 19), K2 self-approval (ruling 18), CI webhook signature v2 (ruling 21). |
| P1 | D/BUG-6 residual + e2e | S | Keep the session on a `/me` 5xx; one e2e that expires the access cookie and reloads. |
| P2 | A/SEC-6, A/SEC-13 | S | `user.update` disable path tiered `high`; drop `fleet.thread.preapprove` from Developer or make it `critical`. |
| P2 | B/BUG-5, B/PERF-2 | S | Round-robin ticker cursor, merge-watch backoff, direct flow lookup. |
| P2 | A/MEM-1, retention | M | Retention jobs after ruling 10. |
| P2 | B carried | S | Runner revocation and disabled-runner tokens (ruling 5), SSE re-check, relay fence under a row lock. |
| P2 | Deploy smoke | M | CI job: compose up, migrate, `/api/health`, log in through web. |
| P2 | API consumer audit | S | Verify the 67 unmatched operations; add CLI commands or mark them agent-only. |
| P3 | Product gaps | L | Due dates, bulk ops, ticket FTS (reuse the memory tsvector pattern), attachments: after ruling 14. |
| P3 | LOW items and file sizes | - | Fold into the fix PRs they touch (`fleet-flow-advance.service.ts` 1008 lines, `ticket-transitions.service.ts` 856). |

---

# Area reports

Each section below is the area reviewer's report, with the consolidation corrections marked.


---

## Review A: API platform, permissions/approvals, ticket domain (koda main @ b98893e4, 2026-11-14; base 61052931)

Scope: `apps/api/src/{permissions, approvals, policy, audit, auth, users, projects, tickets, comments, labels, ticket-links, notifications, email, agents, config, common, action-context, outbox}`, `main.ts`, `app.module.ts`, `prisma/schema.prisma` and migrations since base.
Method: static, read-only. Prior findings were checked against current source with file:line evidence. New code was traced through route decorator -> `RequiresGuard` / `ProjectMembershipGuard` -> `ApprovalRouteGate` -> `ApprovalGate` / resolver -> command -> service -> repository. A mechanical scan of all 85 controllers (280 route handlers, 284 `@Requires`, 14 public routes) found no route without an authorization decorator. Not run: tests, builds. `@nathapp/*` packages are not installed in the checkout, so claims that depend on library behaviour are marked unverified.

### 1. Summary

The 11-01 P0 work landed. Both HIGH findings (A/SEC-1 agent-granted Project Admin through invites, A/SEC-2 agent self-unpause) are closed in code, and so are the three gate bypasses (verify-fix self-approval, MCP decide, status PATCH under the wrong key) and agent hard delete. The permission catalog now tiers role-grant keys as `critical` with a human floor, credential writes as `high`, and clamps every resolved mode to the catalog floor. Approval-execution external effects (PR creation) moved to after-commit.

What remains is mostly partial work and the 11-01 LOW backlog, plus one design ruling on spend-generating keys. I found no new HIGH defect in scope.

| Dimension | Score (/20) | Basis |
|:--|--:|:--|
| Security | 16 | Both HIGHs and SEC-3/4/5 fixed. SEC-6 partial (`user.update` still `none` for agents). Open LOW: RFC1918 proxy trust, refresh tokens not one-time, no secret minimum length, GCM tag length. New SEC-12 is a tiering ruling. |
| Reliability | 15 | BUG-2 fixed; PR side effects after commit. Invite email still sent inside the approval transaction (BUG-1 partial). API-key DB error still masked as 401 (BUG-3 open). New BUG-5/BUG-6 (LOW). |
| API Design | 16 | Gate parity across REST and MCP. Workflow comments immutable on edit and create (ENH-1 partial, delete still allowed). `GET /agents/:slug/pickup` still writes (SEC-11 open). |
| Code Quality | 15 | `ticket-transitions.service.ts` is 856 lines (over the 800 limit, up from 749). Fail-closed patterns are consistent. New STYLE-3 (LOW). |
| Best Practices | 15 | No retention for audit/approval/webhook rows (MEM-1, ruling 11). No `enableShutdownHooks` (ENH-2). No password change or reset, no MFA, no agent key expiry (see gap table). |
| **Total** | **77 / 100** | Up from 74 at 61052931. Grade about B-. |

Counts:
- Prior (11-01 Area A, 19 items): 6 FIXED, 5 PARTIAL, 8 OPEN.
- New: 0 CRITICAL, 0 HIGH, 1 MEDIUM (ruling-dependent), 4 LOW.

---

### 2. Prior findings status

Source: `docs/20261101-review-whole-repo.md` Review A (base 61052931). Line numbers are at b98893e4.

| ID | 11-01 title | Status | Evidence |
|:--|:--|:--|:--|
| SEC-1 [HIGH] | Agent creates a human Project Admin, or grants any role, with no human floor | FIXED | `permissions/catalog.ts:447` `ROLE_GRANT_KEYS` (`member.add`, `invite.create`, `invite.resend`) and `:450-453` classify them `critical`, so the floor is `human` (`:497`). `approval-policy.resolver.ts:58` clamps to the floor via `strictestMode`. `invite-route.commands.ts:40,52` `toResult` strips `invitePath` from the stored result. An agent gets a parked request, not a raw token. |
| SEC-2 [HIGH] | Agent self-update on the roster route skips parse, gate and approval; PAUSED agent can unpause itself | FIXED | `projects/projects.controller.ts:262-268`: the self branch parses the DTO and accepts only one defined key, `status`, with value `PAUSED` or `OFFLINE`; anything else is 403. `maxConcurrentTickets` is no longer reachable from the self path. |
| SEC-3 [MEDIUM] | Verify-fix self-approval rule not implemented | FIXED | `tickets/tickets.controller.ts:412-414` calls `selfFixApprovalFloor` and passes `minMode: 'agent'`. `tickets/tickets.service.ts:197-209` compares the latest VERIFY_FIX status-change actor with the caller. `approval-gate.service.ts:120-126` applies `minMode` as a raise only. Transition-level re-check under lock: `ticket-transitions.service.ts:652` (`assertSelfFixApproval`). |
| SEC-4 [MEDIUM] | MCP `koda_decide_approval` skips the policy gate | FIXED | `approvals/mcp/approval-mcp-tools.ts:85-90` now calls `routeGate.run` with `approval.decide` and `APPROVAL_ROUTE_VARIANTS.decide`, the same as `approval-requests.controller.ts:108-117`. |
| SEC-5 [MEDIUM] | `PATCH /tickets/:ref {status}` gated under `ticket.update` | FIXED | `tickets/tickets.controller.ts:249-256`: `edgeKey = transitionKeyFor(...)` becomes the gate key, with `alsoKeys: ['ticket.update']`. The gate takes the strictest of both. Residual race: BUG-6. |
| SEC-6 [MEDIUM] | Key and credential writes tiered below design | PARTIAL | Fixed: `permissions/catalog.ts:186` `CREDENTIAL_KEYS` (`agent.create`, `agent.key.rotate`, `user.create`) classify `high`, default `agent`. Owner disable needs `role.binding.owner` (`users/users-admin.service.ts:122-124`). CI-token write carries `minMode: 'agent'` (`projects/projects.controller.ts:145`). Open: `user.update` (`catalog.ts:360`) is `medium`, floor `none`. An agent with global Admin can disable other admins. Only Owner and the last-admin count are checked (`users-admin.service.ts:122-124`, `:131`). |
| BUG-1 [MEDIUM] | Deferred approval runs external side effects inside the DB transaction | PARTIAL | Fixed for PR creation: `ticket-transitions.service.ts:211` defers through `AfterCommitService`; `approval-execution.service.ts:281` wraps the transaction in `afterCommit.scope`. Still open for invite email: `projects/invites/project-invites.service.ts:213` calls `sendInvite`, which calls `dispatcher.sendOne` synchronously (`invite-mailer.ts:50`). On the deferred path that runs inside the approval transaction. A rollback leaves a sent link for a non-existent invite, and the 5-minute retry sends a second one. |
| BUG-2 [MEDIUM] | `DELETE /agents/:slug` hard delete nulls authorship | FIXED | Migration `20261120100000_agent_soft_delete`. `agents/prisma-agent.repository.ts:114-122` tombstones (`deletedAt`, OFFLINE, slug renamed, key hash replaced). Bindings are removed in the same transaction (`agents/agents.service.ts` `remove`). Auth lookup excludes tombstones (`auth/prisma-auth.repository.ts:111`). |
| ENH-1 [MEDIUM] | Workflow comments mutable, deletable, outside a transition | PARTIAL | Fixed: create accepts only `GENERAL` (`comments/dto/create-comment.dto.ts`, `IsIn(['GENERAL'])`). Edit blocked for non-GENERAL (`comments/comments.service.ts:61,227`, `comments.workflowImmutable`). Open: delete of a workflow comment is still allowed and is a soft delete with no revision kept (`comments.service.ts:262-266`). |
| SEC-7 [LOW] | Every RFC1918 peer is a trusted proxy | OPEN | `main.ts:26` unchanged. |
| SEC-8 [LOW] | Refresh tokens not one-time | OPEN | `auth/auth.service.ts:145-160` `refresh` calls `issueSession` with no jti, family or reuse detection. |
| SEC-9 [LOW] | No minimum length on JWT and API-key secrets | OPEN | `config/env.validation.ts:28-32`: `secret()` (`:12-19`) refuses only the `change-me` placeholder in production. No `.min()`. |
| SEC-10 [LOW] | GCM `setAuthTag` without `authTagLength` | OPEN | `common/utils/encryption.util.ts:57-60`: `createDecipheriv(..., keyBuffer, iv)` with no options. |
| SEC-11 [LOW] | `GET /agents/:slug/pickup` writes; `agent.pickup` gate ignored on GET | OPEN | `agents/agents.controller.ts:147-151` still `@Get`. Writes an AgentEvent and an audit row. |
| BUG-3 [LOW] | API-key DB error swallowed, falls through to JWT, shows as 401 | OPEN | `auth/guards/combined-auth.guard.ts:55-58` logs and continues. |
| BUG-4 [LOW] | P2002 becomes 500 on TicketLink and project slug | PARTIAL | Fixed: labels (`labels/prisma-label.repository.ts:30`) and agent slug (`agents/agents.service.ts:132`). Open: `ticket-links/ticket-links.service.ts:99-121` and project create (`projects/projects.service.ts`) have no unique-violation mapping. |
| PERF-1 [LOW] | PR creation on the request path | PARTIAL | Now after commit (`ticket-transitions.service.ts:211`), but `AfterCommitService.scope` awaits each task before the caller's response returns, so the request still waits for the GitHub calls. |
| MEM-1 [LOW] | `WebhookDelivery` never purged | OPEN | Only `forget()` deletes (`webhook-security/webhook-replay.guard.ts:105`). No retention processor for webhook rows. |
| ENH-2 [LOW] | No shutdown hooks | OPEN | No `enableShutdownHooks` and no `onApplicationShutdown` in `apps/api/src`. `main.ts` calls `ready()` then `start()` only. |

---

### 3. New findings

##### SEC-12 [MEDIUM] Spend and repo-write keys that agents hold default to `none`, outside the design's high tier (needs ruling 18)
- **Location:** `permissions/catalog.ts:234` (`fleet.job.dispatch`), `:247` (`fleet.job.config.edit`), `:264` (`fleet.schedule.create`), all `medium`; `permissions/system-roles.ts:75` (Developer holds `fleet.job.*`) and `:84` (`fleet.schedule.create`); `fleet/jobs/fleet-jobs.controller.ts:40` (`@Requires('fleet.job.dispatch')`); `fleet/repo-config/repo-config-route.commands.ts:35` (config edit queues a job that opens a repo PR).
- **Excerpt:** `classifyRisk` returns `medium` for any key that matches no prefix, so `fleet.job.dispatch` and `fleet.schedule.create` land at `none` for agents.
- **Failure scenario:** a Developer agent (default role for agents) dispatches jobs or creates a recurring schedule without a human seeing it. A CONFIG_EDIT job runs an agent that opens a repo PR. Spend is bounded only by the budget windows (`fleet.budget.*`, high), not by approval. The design's high list (`docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md:187`) names budget, credential, key, webhook, VCS, repo and runner writes, but not job dispatch or scheduling.
- **Fix:** Decide the tier (ruling 18). If agents should not start spend or repo writes unattended, add `fleet.job.dispatch`, `fleet.job.config.edit` and `fleet.schedule.create` to `HIGH_RISK_PREFIXES` or a named set. Add a catalog test that pins the tier of each spend-generating key.

##### SEC-13 [LOW] A human-only key is granted to agents at default `none` (`fleet.thread.preapprove`)
- **Location:** `permissions/catalog.ts:158` (medium, floor `none`), `permissions/system-roles.ts:79` (Developer), `fleet/flows/thread-preapproval.controller.ts:42` and `:64` (`assertHuman(principal)` before the gate).
- **Failure scenario:** none today. The controller refuses agents before the gate runs. The catalog still says agents may hold and perform the key at `none`. If someone removes the controller check, or reaches the same command through the approval registry, an agent can set a thread's cost cap and advance approval with no review.
- **Fix:** Remove `fleet.thread.preapprove` from the Developer role, or classify it `critical` (floor `human`). Either way the catalog should match the controller.

##### BUG-5 [LOW] A PR created after commit can lose its TicketLink, and a later verify opens a second PR
- **Location:** `tickets/state-machine/ticket-transitions.service.ts:319-322` (`hasPrLink` guard), `:354-364` (`createPullRequest`, then `createTicketLink`), `:386-389` (failure caught and logged).
- **Failure scenario:** `createPullRequest` succeeds, then `createTicketLink` fails on a DB error. The catch logs a warning, so the PR stays open with no `pr` link. The next VERIFIED or VERIFY_FIX cycle sees `hasPrLink() === false` and creates a second draft PR for the same branch name.
- **Fix:** Look up an existing PR by head branch before `createPullRequest` (GitHub returns it, so the create is idempotent), or retry the link write with backoff and alert on failure.

##### BUG-6 [LOW] Status PATCH selects the approval key from an unlocked read
- **Location:** `tickets/tickets.controller.ts:250-252` (`findByRef`, then `transitionKeyFor(ticket.status, patch.status)`), gate at `:253-261`.
- **Failure scenario:** the ticket's status changes between the read and the gate. The approval mode resolved for the stale edge is applied to the edge actually taken. The service still refuses an invalid edge and checks edge permission (`assertTransitionAllowed`), so this is a mode mismatch, not a state-machine bypass. Narrow race.
- **Fix:** Re-resolve the edge key inside the transaction under the row lock, the same way `assertSelfFixApproval` (B2) does, or reject a status PATCH whose resolved key differs from the one gated.

##### STYLE-3 [LOW] `ticket-transitions.service.ts` exceeds the 800-line limit
- **Location:** `tickets/state-machine/ticket-transitions.service.ts`, 856 lines (749 at base).
- **Failure scenario:** not a runtime failure. The file now holds the transition state machine, PR creation, auto-index, self-fix floor and after-commit wiring, which makes review and change risk higher.
- **Fix:** Move PR creation (`createPrForTicket`, `createPrAfterCommit`) and auto-index into a collaborator service. Move `assertSelfFixApproval` next to the state machine it guards.

---

### 4. Gap analysis

Sources: `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md`, `2026-10-08-fleet-s4a-notifications-core-design.md`, `2026-10-08-fleet-s4b-email-and-invites-design.md`, `2026-10-09-fleet-s4c-team-access-design.md`, `2026-11-05-provider-credential-vault-design.md` (config only), `docs/specs/SPEC-agents-management.md`, `SPEC-ticket-links.md`.

| Gap | Design source | Current state | Evidence | Suggested priority |
|:--|:--|:--|:--|:--|
| Self-service password change | None in designs (table stakes) | Missing. Only admin-created users with a temporary password. No password change route. | `auth/auth.controller.ts:37-113` routes are register, registration-status, login, refresh, me, logout. `users/admin-users.controller.ts:29-64` admin only. | P1 |
| Password reset (forgot-password flow) | None in designs | Missing. Invite acceptance sets a password, but there is no reset path for an existing user. | Same as above. | P1 |
| Refresh-token rotation and per-session revocation | Redesign assumes revocation works (`revoked` flag) | Logout bumps `tokenVersion` for all sessions. Refresh tokens are reusable until expiry. | `auth/auth.service.ts:188-203`, `:145-160`. SEC-8. | P1 |
| MFA / 2FA for Owner and Admin | None in designs | Missing. | Grep for totp, mfa, two-factor, reset found no code. | P2 |
| Agent API key expiry and rotation policy | Redesign covers rotation (`agent.key.rotate`) but not expiry | Keys never expire. `Agent` has no `expiresAt`. Rotation is manual. | `prisma/schema.prisma` `model Agent` (`apiKeyHash` only). | P2 |
| Retention for AuditEntry, ApprovalRequest/Decision, WebhookDelivery | Ruling 11 (undecided) | Not built. Retention jobs exist only for logs, notifications and enrollment (`permissions/catalog.ts:382-393`). | MEM-1 (`webhook-replay.guard.ts:105`). | P2 |
| Invite email after commit on the deferred path | S4b `4.3`: "after commit, the request inserts an EmailSchedule row" | Partial. Email is sent synchronously inside the approval transaction. | BUG-1, `invite-mailer.ts:50`. | P1 (correctness) |
| Per-project agent scoping flag (`AGENT_PROJECT_SCOPING`, `AgentProject` table) | S4c `2`, `3.1` | Superseded. Roster now comes from bindings (`agentHasProjectAccess`). The flag is removed, and two integration specs pin the removal (`test/integration/permissions/agent-scoping-removed.integration.spec.ts`, `test/unit/config/agent-scoping-flag-ignored.spec.ts`). | `agents/prisma-agent.repository.ts:159-161`. | Doc only: mark S4c section 2/3.1 superseded. |
| Assignees typeahead | S4c `3.3` | Built. | `projects/assignees/project-assignees.controller.ts:18`. | None. |
| @mentions in tickets | S4a `2.3` | Built. | `notifications/mentions.ts`, `ticket-mention.resolver.ts`. | None. |
| `/me/notifications`, unread count, read, read-all, preferences, `/me/events` SSE | S4a `3`, `4` | Built. | `notifications/me-notifications.controller.ts` (`/me/*`), `live/me-live.controller.ts`. | None. |
| Ruling 10: PAUSED agent semantics | Redesign section 7 | Partly built: PAUSED agents authenticate (`combined-auth.guard.ts:95`) and gated writes are refused (`actor-principal.loader.ts:45`). Ungated reads still work. | Needs a recorded decision. | Ruling only. |
| Project policy weaker than global policy (ruling 8) | Redesign section 4 | Built as project-first ranking. Floors still bound it. | `approval-policy.resolver.ts:46-51` (tier 0-3 for project, 4+ for global). | Ruling only. |
| Shutdown hooks (ENH-2) | Not in designs | Missing. | No `enableShutdownHooks` in `apps/api/src`. | P2 |
| Audit viewer | Redesign section 5 | Built. | `audit/audit.controller.ts:12`. | None. |

---

### 5. Rulings needed

Carried from 11-01 (status updated):
- **Ruling 7** (may agents hold `member.add` / `invite.create`): decided in code. Agents may request them; a human must approve (critical, human floor). Confirm and record.
- **Ruling 8** (project policy weaker than global): open. Project-first ranking is built (`approval-policy.resolver.ts:46-51`). Decide whether to keep it.
- **Ruling 9** (global Admin disables Owner): decided in code. Only an Owner (`role.binding.owner`) may disable an Owner (`users-admin.service.ts:122-124`). Confirm.
- **Ruling 10** (PAUSED semantics): partly decided in code (gated writes refused, reads allowed). Record it.
- **Ruling 11** (retention for audit, approval and webhook rows): open. MEM-1 depends on it.
- **Ruling 12** (single replica): settled. Not re-raised.

New:
- **Ruling 18 (SEC-12):** should agents hold `fleet.job.dispatch`, `fleet.job.config.edit` and `fleet.schedule.create` unattended (default `none`), or should they be `high` (agent-approved) or `critical` (human-approved)? Budgets are the only cap today.
- **Ruling 19 (user.update, A/SEC-6 remainder):** may an agent with global Admin disable other admins with no approval? If no, classify disabling a user as `high`.
- **Ruling 20 (password lifecycle):** is self-service password change and reset in scope before the next release? Auth has no way to rotate a temporary password.
- **Ruling 21 (refresh rotation, SEC-8):** is one-time refresh with reuse detection required, or is `tokenVersion` on logout the accepted model?

Unverified (not scored):
- Email HTML escaping. Templates say values are HTML-escaped (`email/templates/en.ts:6`), but the renderer is in `@nathapp/nestjs-notify`, which is not installed in this checkout. Confirm before relying on it.
- Revocation of a disabled user's access token. `auth/jwt-auth.provider.ts:53` sets `revoked`, and an integration test exists (`test/integration/auth/disabled-user.integration.spec.ts`). Enforcement sits in `@nathapp/nestjs-auth`, which I could not read here.
- ENH-2 library behaviour: whether `AppFactory.start` enables shutdown hooks internally. Not checked.

---

## Review B: fleet control plane, flows, tokens, threads, MCP (koda main @ b98893e4, 2026-11-14)

Scope: `apps/api/src/fleet/{flows, threads, jobs, sync, git-broker, ingest, runners, provider-credentials, rulings, reviews, assistant (incl. mcp), approvals}`. Prior baseline: `docs/20261101-review-whole-repo.md` (base 61052931). Read-only static review. No tests or builds run. 56 commits reviewed via `git log 61052931..HEAD`; traced flow advance, token grant, ingest and thread SSE through their callers.

### 1. Summary

| Dimension | Score (0-20) | Prior (11-01) | Notes |
|---|--:|--:|---|
| Security | 17 | 16 | REVIEW token scope and PROJECT anchor mint fixed. FIX still holds a repo-wide write token. Runner labels, runner revocation and SSE re-checks still open. |
| Reliability | 16 | 15 | Sweeper and placement isolation and bundle ingest bounds fixed. The flow state machine has no failure budget, so a persistent non-declared error retries forever. |
| API Design | 16 | 17 | Flow routes use consistent `@Requires` keys and `@ApprovalGated`. Agent SSE still contradicts its own comment. `GET /fleet/flows/:id` scans every principal project. |
| Code Quality | 15 | 17 | `fleet-flow-advance.service.ts` is 1008 lines (rule: 800 max). Otherwise small, well-named modules with design references. |
| Best Practices | 17 | 17 | Locks and fences on every runner write, inputs bounded with explicit limits, flow dispatch kept outside transactions with a documented recovery path. |
| **Total** | **81/100** | 82 | |

No CRITICAL or HIGH findings. New code is strong: the flow engine decides under row locks, dispatches outside transactions, recovers from a crash between dispatch and record through a flow-linked job insert, and bounds every flow input (20 features, 300-char spec paths, 12 PRD edits, 1000-char answers). The remaining gaps are mostly prior items that did not move.

| Severity | New findings | Prior items |
|---|--:|--:|
| HIGH | 0 | n/a |
| MEDIUM | 1 (BUG-4) | 4 open or partial |
| LOW | 3 (BUG-5, PERF-2, ENH-1) | 6 open |

Prior status (10 Area B items): **Fixed 3**, **Partial 1**, **Open 6**.

### 2. Prior findings status

| ID | 11-01 title | Status | Evidence |
|:--|:--|:--|:--|
| B/SEC-1 | REVIEW and FIX get repo-wide `contents: write` | PARTIAL | REVIEW fixed: purpose `review` maps to `mintReviewToken` (`contents: read`, `pull_requests: write`) at `git-broker/github-app-client.ts:108-113`, selected at `git-broker/git-token.broker.ts:101-102`, requested from `sync/sync.service.ts` (`purpose: 'review'`). FIX still uses `mintInstallationToken` (`github-app-client.ts:97`, `contents: write`). Only guard is the default-branch protection check, `git-token.broker.ts:112-115`, with a per-repo `fixAllowUnprotected` override. Other branches stay writable. |
| B/SEC-2 | PROJECT-thread job mints an anchor write token | FIXED | `sync/sync.service.ts:~168`: `job.command === 'THREAD' && ['WORKSPACE','PROJECT'].includes(scope.kind)` with no `repoId` is refused `repo_not_assigned`. PROJECT with `repoId` gets a read-only grant (`readOnly: true`, lines ~156-165). |
| B/MEM-1 | Bundle ingest has no file-count or total-bytes cap | FIXED | `ingest/domain/bundle-ingest.domain.ts:17-26`: `fileBytes` 32 MiB, `totalBytes` 64 MiB, `maxFilesPerSlot` 5000. `ingest/bundle-reader.ts` tracks `keptBytes` and per-slot counts (diff +75 lines since base). |
| B/BUG-1 | Sweeper and sync do not isolate per-item failures | FIXED (residual minor) | `sync/fleet-sweeper.ts:~59-75`: each id runs in its own `try`, logs `error.name`, and continues. `sync/sync.service.ts`: `fillRunner` and `fillRunnerThreads` are each wrapped in `try` and logged, so tokens and commands still deliver. `afterTerminal` (`sync.service.ts:297-305`) is not wrapped, but it only evicts and fires `void` calls. |
| B/SEC-3 | Runner-chosen labels merged into enrollment labels | OPEN | `runners/enrollment.service.ts:68`: `labels: uniqueSorted([...enrollment.labels, ...body.labels])`. Unchanged. |
| B/SEC-4 | Runner not revocable while holding jobs; disabled runner still gets tokens | OPEN | `auth/guards/combined-auth.guard.ts` `authenticateRunner` looks up by key hash only, and `toRunnerPrincipal` hardcodes `revoked: false`. `sync/sync.service.ts` has no `enabled` check in `grantTokens`, so a disabled runner still receives tokens for held jobs. `runners/runners.service.ts:64-77` still refuses delete while jobs are unfinished. |
| B/BUG-2 | Thread SSE: comment says agents pass, but route needs a JWT | OPEN | `threads/thread-events.controller.ts:41-44` comment says "the key decides, so an agent passes". Lines 57-58: `decodeJwtPayload(...)`, and `if (!jwtPayload) throw new ForbiddenAppException({}, 'live')`. API-key callers always get 403. |
| B/SEC-5 | Thread SSE `stillAllowed` does not re-check `thread.read` | OPEN | `threads/thread-events.controller.ts:96-104`: `stillAllowed` checks `fresh.revoked` and `assertProjectMembership`, not `permissions.can(..., 'thread.read')`. |
| B/BUG-3 | Tool relay fence checked without the job row lock | OPEN | `assistant/runner-tool.service.ts:47-56`: `jobs.findById`, then `fence.holds`, then `executor.execute`, all outside any transaction or lock. |
| B/PERF-1 | Broker and notifier whole-map copies | OPEN (accepted) | `git-broker/git-token.broker.ts:40-56` still replaces a `ReadonlyMap` wholesale. Not re-traced for `runner-notifier.ts`. |

### 3. New findings

Prior IDs run through B/PERF-1, so new IDs start at BUG-4, BUG-5, PERF-2 and ENH-1 (no collisions).

##### BUG-4 [MEDIUM] A flow that hits a non-declared error is retried every tick with no failure budget and no stop path
- Location: `apps/api/src/fleet/flows/fleet-flow.ticker.ts:43-49` (catch logs only); `fleet-flow-advance.service.ts:168`, `:305`, `:400`, `:658` (invariant throws); `fleet-flow-advance.service.ts:417-421` (`refuseDispatch` rethrows anything not in the declared list); `fleet-flow-feature-passes.ts` `pollAwaited` (`if (!(error instanceof RepoCheckException)) throw error`).

```ts
// fleet-flow.ticker.ts
try {
  await runAsSystem('flow', () => this.engine.advance(flow.id, now), { ... });
} catch (error) {
  this.logger.error(`Flow ${flow.id} failed: ${messageOf(error)}`);
}
```
- Failure scenario: a flow in `RUNNING` or `WAITING_MERGE` hits an error that is neither a declared refusal nor a transient forge error (for example a bad invariant, or a non-`RepoCheckException` from the GitHub client on a path that is not transient). `advance` throws before any `writeStop`. The row is never changed, so `listAdvanceable` returns it again on every tick (`flowTickMs`). The user sees no state change and no stop reason, and the only evidence is one error log per tick. Note that most invariant throws are preceded by decision-engine guards (`flow-step-decision.ts:111,190`), so reachability is limited, but nothing bounds the retry if one is reached.
- Fix: add a per-flow consecutive-failure counter (a column or an outbox row). After N failures, write a `stop` with reason `internal_error` through `writeStop` and record an activity row. Reset the counter on a successful pass.

##### BUG-5 [LOW] Ticker restarts from the lowest flow id every tick, and merge watch polls GitHub on every tick with no backoff
- Location: `fleet-flow.ticker.ts:31-38` (`afterId = null` at the start of each tick, `ORDER BY id ASC`); `fleet-flow-feature-passes.ts` `pollAwaited` (`Promise.allSettled(targets.map(getPullRequest))`, lines ~317-318).
- Scenario: beyond `PAGE_SIZE * MAX_PAGES` = 500 advanceable flows, the highest-id flows are never reached while lower-id flows are still advanceable, and the warning fires every tick. Separately, each `WAITING_MERGE` flow makes one forge call per awaited PR (up to 20 per flow, in parallel) on every tick. Both are fine at current scale.
- Fix: order by a `lastTickedAt` column (oldest first), and back off WAITING_MERGE polls with a `nextPollAt` value.

##### PERF-2 [LOW] `GET /fleet/flows/:flowId` loads every project the caller can reach to find one flow's project
- Location: `apps/api/src/fleet/flows/fleet-flows.controller.ts:37-45`:

```ts
const project = (await this.projects.findAllForPrincipal(principal)).find((candidate) => candidate.id === flow.projectId);
```
- Impact: per-request cost grows with the caller's project count. Authorization is still correct, since the key is checked afterwards.
- Fix: look up the flow's project by id (for example `projects.findById`) and check membership through the existing membership and `permissions.can` path.

##### ENH-1 [LOW] `flow-advance.service.ts` is 1008 lines, over the 800-line project limit
- Location: `apps/api/src/fleet/flows/fleet-flow-advance.service.ts` (1008 lines). The companion `fleet-flow-feature-passes.ts` is 396 lines and already holds the extracted passes.
- Fix: move the calls and rulings branches (`advanceCalls`, `advanceSetCalls`, `advanceRulings`, `advancePrdEdits`) into their own module, the same way `fleet-flow-feature-passes.ts` was split.

### 4. Gap analysis

Koda open issues: `gh issue list --state open` returns **0** (checked 11-14). All nine 11-01 nax-integration issues are CLOSED. Build status checked in the code:

| Gap | Design source | Current state | Evidence | Suggested priority |
|---|---|---|---|---|
| #368 ACP thread backends | S5a chat threads, thread-agents-modes (11-04) | BUILT, partial scope | `apps/runner/src/capabilities/acp-agent-probe.ts` uses `@nathapp/nax-agent-acp` 0.92.0. `packages/fleet-protocol/src/threads.ts:15` admits only three agents (Claude Code, Codex, Cursor), while the comment says nax-agent-acp knows more. | LOW: widen the agent list when needed |
| #369 interactive coding threads (write and shell profiles) | thread-agents-modes (11-04) | BUILT under different names | Modes are `'read' \| 'ask' \| 'full'` (`threads.ts:13`). `full` gives `bashApproval: 'raw'` (`apps/runner/src/thread/session-factory.ts:163-167`). No `write` or `shell` profile names exist. Needs a ruling (section 5). | MEDIUM: confirm naming, then document |
| #370 C11 koda-managed rule and context overrides | Design §9.31 DEFERRED 10-07, later re-scoped | BUILT | `apps/runner/src/executor/rule-override.ts` (`koda-rules`, `koda-context.md` in the job dir). API: `fleet/repos/fleet-repos.controller.ts` `RULE_OVERRIDE_BODY`, `fleet/jobs/assign-payload.ts` `RULE_OVERRIDE_COMMANDS`, migrations `20261204090000_fleet_repo_rule_override` and `20261204100000_fleet_job_rule_override`. | Done (close the design's deferred note) |
| #371 vault builds on nax `credentials.source` exec | Vault design 11-05 | BUILT | `apps/runner/src/thread/nax-credentials.ts`, `apps/runner/src/commands/vault.ts`, `apps/runner/src/supervisor/job-run.ts` | Done |
| #372 promote an ESCALATED draft PR from koda | PR finish design 11-04 | BUILT (runner side) | `apps/runner/src/verdict/run-verdict.ts:10,28` treats `promoted` and `already-ready` as completing. `apps/api/src/fleet/flows/flow-step-decision.ts` handles the verdict. No dedicated promote endpoint found. | LOW: confirm the ESCALATED path has an API test |
| #373 record FIX ready result and thread replies | PR finish design | BUILT | `fixReady` on jobs (`apps/api/src/fleet/jobs/fleet-jobs.service.ts`, `prisma-fleet-job.repository.ts`), `flow-step-decision.ts:229` completes on `markedReady`, `fleet-flow-advance.service.ts:721,864` | Done |
| #374 FIX on repos without nax check commands fails after a billed review | PR finish design | BUILT (corrected in consolidation) | Per-repo FIX check-commands override: `apps/api/src/fleet/repos/dto/update-fix-checks.dto.ts`, `fix-checks.exception.ts`, `fleet-repos.controller.ts`; runner `apps/runner/src/nax/trust.ts`. Closed by PR #383. | Done |
| #375 reconcile koda skill tools with nax-agent resource catalog | thread-agents-modes | CLOSED BY DECISION (corrected in consolidation) | PR #427 `09018df9` records the decision to keep the koda thread skill tools. No code change expected. | Done |
| Fleet flow: project-wide auto-approve | Flow design 11-04, non-goal | DEFERRED by user (designed as deferred) | Flow design lines 51, 79 | None |
| Fleet flow: automatic Finish dispatch | PR finish design 11-04, non-goal | DEFERRED (designed as deferred) | `2026-11-04-fleet-pr-finish-design.md:101` | None |
| Vault: spend caps per key | Vault design 11-05, non-goal "Later" | DEFERRED (designed as deferred) | `2026-11-05-provider-credential-vault-design.md:33`; attribution only | LOW: schedule when needed |
| Vault: HashiCorp / OpenBao / KMS backend | Vault design 11-05 | DEFERRED; the storage sits behind an interface | `provider-credentials/secret-store.ts` | None |
| Flow review-spec edits as same vs follow-up AGENT job | Flow design open question, line 211 | Built as a follow-up AGENT job (`fleet-flow-advance.service.ts` `apply_calls`). Open question not closed in the doc. | Design line 159 | LOW: update the doc |
| Assistant (S5b) and standalone assistant (design (i)) | Fleet platform design | BUILT (`apps/api/src/fleet/assistant/`) | MCP and tool executor present | Done |

### 5. Rulings needed

1. **FIX token scope (B/SEC-1, still partial).** FIX pushes need `contents: write` on every branch. Option A: accept "default branch must be protected" as a deployment prerequisite, and document it. Option B: restrict the push target to the PR head ref. The `fixAllowUnprotected` override is audited but skips the protection check entirely. Keep it, or require a second approval?
2. **Flow failure policy (BUG-4).** After how many consecutive non-declared failures should a flow stop with `internal_error`? Proposed default: 5.
3. **Thread mode names (#369).** Keep `read`/`ask`/`full` and close #369 as built, or rename to write/shell profiles?
4. **Thread SSE for API keys (B/BUG-2).** Users only (fix the comment and OpenAPI note), or support API-key principals with a re-check of the key in `stillAllowed`?
5. **Disabled runner tokens (B/SEC-4).** Should a disabled runner receive git and provider tokens for jobs it already holds? Proposed: no, and crash the held jobs on disable.
6. ~~Verify #374 and #375.~~ Resolved in consolidation: #374 built (#383), #375 closed by decision (#427).

---

## Review C: fleet ops, review memory, VCS/webhooks, RAG/memory/code-intel (koda main @ b98893e4, 2026-11-14)

Scope: `apps/api/src/{memory, rag, retrieval, outbox, webhook, webhook-security, ci-webhook, vcs, context, code-intel, entity-graph, skills, events, live, monitoring, health, home}` and `apps/api/src/fleet/{knowledge, reviews, budgets, schedules, analytics, dashboard}`. Base for prior status is `61052931` (11-01 review). 56 commits since. Static, read-only. Nothing was built, run or written in the repo. Findings were traced through callers and guards.

Not audited line by line: the SPEC-000..004 story lists, the `policy-gates` script body, and the web-side memory and story-graph components (only their existence was checked).

### 1. Summary

**Grade: 75/100 (C+ range, up from 72).**

| Dimension | Score (/20) | Rationale |
|:--|--:|:--|
| Security | 16 | KB source confusion closed (SEC-1). Review approver is now verified, with a downgrade for unverified ones (SEC-2 partial). CI replay via unsigned headers still open (SEC-3). Outbound webhook signature has no timestamp (new SEC-4). |
| Reliability | 14 | Placement starvation, optimize race, import duplicates, entity-graph keys and VCS soft-delete all fixed. Duplicate-review window (BUG-1), deferred `vcs.sync.all` transaction (BUG-2) and budget soft-delete (carried BUG-1 partial) remain. New note-upsert race (BUG-6, LOW). |
| API Design | 16 | Export cursor is strict and keyset-correct. Reserved-prefix guard on `AddDocumentDto.sourceId`. `/context` decision list capped at 100. Memory list `text` bounded to 100. |
| Code Quality | 14 | Dispatch-error duplication still present (STYLE-1). Several large files. The new memory code is small, focused and well-commented. |
| Best Practices | 15 | Migrations dedupe before adding unique indexes. Policy gates run in CI. Audit records approver and mode. The merged-PR ticket history still has null actors (ENH-1). |
| **Total** | **75** | |

What changed since 11-01:
- Fixed: C/SEC-1, C/PERF-1, carried BUG-2 (placement), BUG-3 (import), BUG-4 (entity graph), BUG-5 (optimize). Six of thirteen.
- Partial: C/SEC-2, carried BUG-1.
- Open: C/SEC-3, C/BUG-1, C/BUG-2, C/ENH-1, C/STYLE-1.
- New: BUG-6 (LOW), SEC-4 (LOW), PERF-2 (LOW). No new HIGH or MEDIUM findings in scope.

New memory code (notes, search, export cursor, user scope, proposal mode) was checked for cross-project and cross-user leakage, FTS injection, unbounded queries, idempotency and races. No leak or injection was found. Details are in section 3, where BUG-6 and PERF-2 cover the two real (low) issues.

Verified clean:
- Export cursor (`memory-export-cursor.ts`) is strict. Garbage, non-canonical base64 and bad timestamps decode to null, and the route answers 400. The cursor carries only `(updatedAt, id)`, so it cannot leak another project's rows.
- Export scope is `projectId = X OR ownerKey = caller` (`prisma-memory-item.repository.ts:257`). `ownerKey` is always defined on this path (`memory-governance.service.ts:82`), so the Prisma `undefined`-drops-filter pitfall does not occur.
- FTS: user text is always a bound parameter inside `websearch_to_tsquery(...::regconfig, ${text})` (repository ~lines 98-106). The any-word pass replaces only the ` & ` separator of the parsed tsquery, and only when `!` is absent.
- User-scoped notes are visible in every project to their owner. This is the design (memory-notes spec line 170 and out-of-scope list), not a leak. `/context`, governance and canonical state never see user rows (`context-builder.service.ts:99-110` passes no owner).
- Assistant memory tools derive the owner from `ctx.actor` (`knowledge-tools.ts:151-153`), never from tool arguments.
- The note retire path re-runs ownership, membership, kind and status checks inside the row-lock transaction (`memory-write.service.ts`, `resolveNoteRetireTarget`).

### 2. Prior findings status (11-01 Area C)

| ID | 11-01 title | Status | Evidence |
|:--|:--|:--|:--|
| SEC-1 | KB writer injects into `koda_get_doc`; indexer deletes rows by `source_id` only | **Fixed** | `fleet/knowledge/knowledge-chunk-store.ts:78,89,96-98` now filter with `sourceRowFilter(source, sourceId)`, and `sourceFor()` (`:164-170`) derives the source from the reserved prefix. `rag/dto/add-document.dto.ts:25` rejects `repo:` and `outcome:` with 400. |
| SEC-2 | Review-minted DECISION credits any repo writer named in `disagreedBy`, no thread check | **Partial** | `fleet/reviews/review-event.minter.ts:~113-124` `verifiedWriter` checks that a writer authored a comment in `threadId`, on the same PR and repo. Unverified events are still minted, downgraded to `satisfiedBy: 'none'` (`:~93-96`), which matches ruling 14. The `approverId` still names an unverified login, and PR-author self-approval (ruling 1) is not addressed. |
| SEC-3 | CI webhook replay via unsigned `X-CI-Delivery` / `Date` | **Open** | `ci-webhook/ci-webhook.controller.ts:46` and `:73-76` sign the body only. Unchanged since base. |
| PERF-1 | `findActiveDecisions` unbounded; `/context` returns all K2 decisions | **Fixed** | `memory/prisma-canonical-state.repository.ts:136-146` has `take: ACTIVE_DECISIONS_LIMIT` (100), `orderBy` and `OR sourceType != review_event`. The `/context` path uses canonical state (`context-builder.service.ts:99-110`). |
| BUG-1 | Failed `markDispatched` leaves `pending` claim, so the same head is reviewed twice | **Open** | `fleet/reviews/fleet-review-claim.service.ts:19-38` and `review-head-dispatcher.ts:86-91` (`reopenStaleClaim` removes the stale `pending` row with no job lookup). `:134` still calls `markDispatched` in a separate write. |
| BUG-2 | Deferred `vcs.sync.all` imports in one approval transaction, no cap | **Open** | `vcs/vcs-manual-sync.service.ts:89` still passes `{ isolate: false }`. `approvals/approval-execution.service.ts` has no transaction timeout option. No cap on issue count. |
| ENH-1 | Merged-PR comment and activity rows carry no actor | **Open** | `vcs/prisma-vcs.repository.ts:411-412` (`authorUserId: null, authorAgentId: null`) and `:423-424` (`actorUserId: null, actorAgentId: null`). |
| STYLE-1 | Dispatch-error classification duplicated | **Open** | `fleet/reviews/review-head-dispatcher.ts:118-125` and `fix-follow-up.subscriber.ts:119-125` each carry their own `getExceptionResponse`. No shared `classifyDispatchError`. |
| BUG-1 (carried) | Soft-deleted projects keep background work | **Partial** | VCS fixed: `vcs/vcs-project-deletion.listener.ts` (new) deactivates connections and unschedules polling, and `prisma-vcs.repository.ts:113,121,130` filter `project.deletedAt: null`. Placement and schedules fixed: `prisma-fleet-job.repository.ts:280`, `prisma-schedule.repository.ts:46`. Budgets still open: `fleet/budgets/prisma-budget.repository.ts:97-99` counts the soft-deleted project as an existing scope. Budget pauses are not released. |
| BUG-2 (carried) | Placement scans only the 50 oldest queued jobs | **Fixed** | `fleet/jobs/placement.service.ts:277-291` keyset-pages (`findQueuedPage` with `(queuedAt, id)` cursor, `prisma-fleet-job.repository.ts:272-303`) up to `MAX_QUEUED_SCAN_PAGES = 10` pages of 50 (`placement-rules.ts:259-265`). Warns when the cap is hit. |
| BUG-3 (carried) | Issue import check-then-insert race | **Fixed** | `prisma/schema.prisma:239` `@@unique([projectId, externalVcsId])`, added by migration `20261120090000_ticket_external_vcs_unique`, which dedupes existing rows first. `prisma-vcs.repository.ts:270-285` maps P2002 to null (`skipped`) outside a transaction. Inside a transaction the violation still fails the whole transaction (see BUG-2). |
| BUG-4 (carried) | Entity-graph `assigned` keys no producer sends | **Fixed** | Consumer `entity-graph/entity-graph.service.ts:241-253` reads `event.data.assignedTo` and `assigneeType`. Producer `tickets/tickets.service.ts:530-532` sends `assignedTo` and `assigneeType`. |
| BUG-5 (carried) | LanceDB `optimize` races index writes | **Fixed** | `rag/vector-store.service.ts:141-145` `optimizeTaskFor` runs `table.optimize()` inside `this.lanceTable.exclusive(...)`, the same per-table write mutex as `replaceFile`. |

Counts: Fixed 6, Partial 2, Open 5 (13 items).

### 3. New findings

##### BUG-6 [LOW] A concurrent write of the same note slug fails as an unhandled error instead of becoming a no-op or a supersede

- **Location:**
  - `apps/api/src/memory/prisma-memory-item.repository.ts:353` (`upsert` runs `withTransaction`), `:438` (`isolationLevel: 'Serializable'`)
  - `node_modules/@nathapp/nestjs-prisma/dist/prisma.service.js:97-125` (`withTransaction` passes errors through, with no retry)
- **Code excerpt:**
  ```ts
  const existingActive = await db.memoryItem.findFirst({ where: { ...scopeKey, activeKey, deletedAt: null } });
  if (existingActive && /* same fields */) return this.toDomain(existingActive);
  ...
  const created = await db.memoryItem.create({ data: { ..., activeKey, ... } });
  ```
- **Failure scenario:** Two writers send the same NOTE slug for the same project at the same moment, for example a REST write and an outbox replay, or two agents. Both `findFirst` calls see no active row and both insert. Postgres rejects one insert with P2002 on `@@unique([projectId, activeKey])`, or aborts one with a serialization failure (40001) under Serializable. Neither is retried, so the caller gets an error. The restatement case is supposed to be an idempotent no-op (the comment at `:380-385` says so), and the loser should have been one. The outbox path retries, but the REST caller does not.
- **Not verified by a test run.** The conclusion is from the code. The wrapper has no retry path.
- **Fix:** Wrap the transaction in a bounded retry (for example 3 attempts) for P2034 and 40001. On P2002 with the `activeKey` target, re-run the transaction once, so the second pass finds the winner and either no-ops or supersedes it.

##### SEC-4 [LOW] Outbound webhook signature has no timestamp, so receivers cannot reject replays

- **Location:** `apps/api/src/webhook/webhook-delivery.handler.ts:35-49`
- **Code excerpt:**
  ```ts
  const sig = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
  const deliveryId = crypto.createHash('sha256').update(`${input.webhookId}:${input.event}:${body}`).digest('hex');
  ... 'X-Koda-Signature': `sha256=${sig}`, 'X-Koda-Delivery-Id': deliveryId,
  ```
- **Failure scenario:** A captured signed delivery (a proxy log, a receiver's log) can be re-sent to the receiver unchanged at any time. The signature still checks out. The receiver can only block it if it stores every delivery id forever. `deliveryId` is a content hash, so retries are stable (good for dedupe), but nothing in the signed bytes binds the message to a time.
- **Scope:** This mirrors the inbound CI problem (SEC-3). The outbound scheme is koda's own, so changing it is within koda's control. Receivers already in the wild would need a versioned header.
- **Fix:** Add `X-Koda-Timestamp` and sign `${timestamp}.${body}` in a new `X-Koda-Signature-V2` header, with a deprecation window. Document the receiver tolerance (for example 5 minutes).

##### PERF-2 [LOW] Ranked memory search runs a full `count(*)` over every match on each page, plus a second full pass for any-word

- **Location:** `apps/api/src/memory/prisma-memory-item.repository.ts:~622-626` (`counted` query), `:~548-557` (the any-word pass repeats the same two queries).
- **Failure scenario:** A broad query, for example a single common word, matches thousands of rows. Every page request runs `count(*)` over the full match set, and an empty all-words result runs it twice more. The cost grows with the match set, not with the page. The GIN index helps the match, but the count still touches every match.
- **Scope:** Low at current volumes (the memory table is per project). Worth fixing before the memory table grows.
- **Fix:** Cache the total for the first page only, or cap the total with `LIMIT n+1` where the UI only needs `hasNext`.

Checked and found no issue (no finding):
- `memory-export-cursor.ts` and `ExportMemoryQuery`. The cursor is strict and keyset-correct. The settle window is `MEMORY_EXPORT_SETTLE_MS = 5000` (`memory-governance.service.ts:29`), and rows newer than it are not returned. That matches the interactive transaction default of 5 s, so the window is adequate for default-timeout writes.
- `findChangedAfter` has indexes for both `OR` legs (`@@index([projectId, updatedAt, id])`, `@@index([ownerKey, updatedAt, id])`).
- `memory-note.ts` size caps match nax (8192 UTF-8 bytes, 200 description chars). Description length is counted in JS code units, not code points. Not verified against nax's counting, so not reported.
- `memory-write-mode.service.ts`: read-only resolver. Proposal mode applies to agent actors only.
- W2 (#440, `001baf72`, `849f7eb6`): web-only, no API surface in scope.
- VCS deletion listener: never rejects, records audit per connection, unschedules after commit. Correct per its docstring.
- Review minter `verifiedWriter`: checks PR number and repo owner and name, not just thread id (`review-event.minter.ts:~120-124`).
- Outbound webhook dispatch now goes through the outbox (`webhook/webhook-dispatcher.service.ts:12-26`), so it is no longer fire-and-forget.

### 4. Gap analysis

Design sources: `docs/specs/SPEC-000..005-memory-*`, `docs/adr/ADR-001`, `docs/specs/SPEC-webhook-outbox-unification.md`, `docs/specs/SPEC-vcs-phase{2,3,4}*`, `docs/specs/SPEC-graphify-kb.md`, `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md`, `2026-10-04-fleet-s2b-d-analytics-design.md`, `2026-10-05-fleet-s2b-c-dashboard-design.md`, `2026-10-05-fleet-s2b-j-story-graph-design.md`, `2026-10-31-fleet-s6-k2-review-memory-design.md`, `.nax/features/memory-notes/spec.md`, `docs/20260706-gap-analysis-missing-features.md`.

| Gap | Design source | Current state | Evidence | Suggested priority |
|:--|:--|:--|:--|:--|
| Outbound webhooks fire-and-forget (gap #3) | SPEC-webhook-outbox-unification | **Built.** Route through the outbox with backoff, and deliveries are recorded. Residual: no timestamp in the signature (SEC-4). | `webhook/webhook-dispatcher.service.ts:12-26`; `webhook/webhook-delivery.handler.ts` | Closed. Address SEC-4 |
| Ticket due dates / SLA | 2026-07-06 gap list (Notifications, Due dates) | **Missing.** `Ticket` has no `dueAt`. Only `EmailSchedule.dueAt` exists (`schema.prisma:388`, unrelated). | `prisma/schema.prisma` | P2, needs product definition |
| Ticket and comment keyword search | 2026-07-06 gap list | **Half-built.** Title-only `contains` in the koda tool (`tickets/prisma-tickets.repository.ts:200`). No FTS on tickets or comments. Memory has FTS (`searchVector`), tickets do not. | `prisma-tickets.repository.ts:200` | P2 (could reuse the memory tsvector pattern) |
| Bulk ticket operations | 2026-07-06 gap list | **Missing.** No batch update, close, label or assign for tickets. | none found | P2 |
| Attachments | 2026-07-06 gap list | **Missing.** No model or endpoints. Fleet `artifacts/` is runner bundles, a different thing. | none found | P3, product decision |
| Budget ledger reconciliation (B2) | S1b spec B2 deferred to S2a | **Built.** Ingest raises job cost to the ledger total. | `fleet/ingest/ingest-corrections.ts`, `bundle-ingest.service.ts` | Closed |
| Budget pause after soft-delete | S1b spec (and 11-01 carried BUG-1) | **Half-built.** VCS, placement and schedules filter deleted projects. Budget scope existence still counts them (`prisma-budget.repository.ts:97-99`). | see section 2 | P1 (needs ruling 2) |
| VCS Phase 2 auto-create PR on VERIFIED | SPEC-vcs-phase2 | **Built.** | `tickets/state-machine/ticket-transitions.service.ts` calls `createPullRequest`; `vcs/providers/github.provider.ts` | Closed |
| VCS Phase 3 PR status sync | SPEC-vcs-phase3 | **Built.** | `vcs/vcs-pr-sync.service.ts` | Closed |
| VCS Phase 4 branch and commit links | SPEC-vcs-phase4 | **Built.** | `vcs/vcs-link-extractor.service.ts` (`extractLinksFromPr`) | Closed |
| Fleet story graph (j) | 2026-10-05 story-graph design | **Built** in web (`apps/web/components/fleet/story-graph/`, `apps/web/lib/fleet-story-graph.ts`). Post-mortem view was explicitly out of scope. | web files | Closed |
| Fleet analytics (d) | 2026-10-04 design | **Built** (`fleet/analytics/`). | `fleet/analytics/` | Closed |
| Fleet dashboard (c) | 2026-10-05 design | **Built.** The project-scope credential board is metadata-only. | `fleet/dashboard/` | Closed |
| Memory SPEC-005 hardening (isolation gates) | SPEC-005 hardening | **Built.** Policy gates run in CI (`.github/workflows/ci.yml:125`), results and SLO snapshot written. Per-gate coverage not audited. | `apps/api/test/policy-gates/`, `apps/api/scripts/policy-gates-runner.ts` | Closed, with a follow-up to audit gate coverage |
| Memory SPEC-003 semantic memory in context | SPEC-003 US-005 | **Built.** | `context/context-builder.service.ts:99-110` | Closed |
| Memory notes: user scope, search, export, proposal mode | `.nax/features/memory-notes/spec.md` | **Built** (#389, #457, #440 web). | see section 3 | Closed |
| Memory live-check: thread triples never reach nax (design gap) | `koda-memory-live-check-2026-11-13` | **Closed by ruling 1 (option 1).** Thread `koda_add_memory` writes NOTE only, and #457 landed it. The live check recorded PASS in §9.198. | `fleet/assistant/tools/add-memory-tool.ts` | Closed |
| Memory live-check: CJK fallback (koda #456) | same | **Closed** in #457 (live PASS). | same | Closed |
| Memory live-check: proposal-mode `forget` (nax #2905) | same | **Open, nax-side.** Not a koda defect. | nax issue | Track in nax |
| Memory retrieval eval: synonym and typo misses (2 of 30) | memory-notes-search | **Open, accepted.** Out of scope for the any-word pass. | live-check §9.198 | P3 |
| Review decision: PR author may approve own "not a defect" | K2 design, ruling 13 | **Open.** Not in the code. | `review-event.minter.ts` (no author check) | P1 (needs ruling) |
| K2 non-goals (forge-login mapping, path-scoped decisions, agreed findings as memory, GitLab) | K2 design §Non-goals | **Intentionally not built.** | design doc | Track, no action |
| CI webhook signature v2 | 11-01 C/SEC-3 | **Open.** | `ci-webhook/ci-webhook.controller.ts:73-76` | P1 (needs ruling 4) |
| Soft-delete semantics for queued work | 11-01 ruling 15 | **Partly decided by behaviour**: VCS quiesces on delete. Not ruled for budgets or schedules. | `vcs/vcs-project-deletion.listener.ts` | P1 (ruling needed) |
| Multi-replica safety | Settled: API single-replica | Not re-raised. | n/a | n/a |

### 5. Rulings needed

1. **Review approver self-approval (K2 ruling 13).** The PR author can be the first `disagreedBy` login and then approve a "not a defect" decision on their own PR. The minter now verifies that the login commented in the thread, but a PR author always can. Should the approver be required to differ from the PR author?
2. **Budget pauses for soft-deleted projects.** Keep the pause in force, or release it when the project is deleted? Other background work (VCS, placement, schedules) already stops on delete.
3. **Deferred `vcs.sync.all` (BUG-2).** Cap an approved import (for example 50 issues), or run it after commit as its own pass? The current single transaction can fail on a large repo or a ticket-number conflict, and the retry fails the same way.
4. **CI webhook signature v2 (SEC-3).** Sign timestamp and delivery id under a new header with a deprecation window?
5. **Outbound webhook signature v2 (SEC-4).** Same question for koda's own outbound scheme. Receivers would need to adopt the new header.
6. **Ticket due dates, bulk operations, attachments, ticket FTS.** These are product decisions and are missing from the design docs. Confirm whether they stay on the roadmap, and in what order.
7. **Cross-project visibility of a user's notes.** The spec makes a user's own notes visible in every project (designed, and listed in out-of-scope). Confirm that the export feed should keep doing the same.

### 6. Other notes

- The 11-01 prior-status table counts Area C at 13 items. Of those, 6 fixed, 2 partial, 5 open. The 5 open are the ones the 11-01 priority table already ranked P1 or P2 (BUG-1, BUG-2, SEC-3, ENH-1, STYLE-1).
- Migration `20261121090100_memory_full_text_search` is dated after today's date (2026-11-14). Prisma applies migrations in name order, and nothing later sorts before it, so this is harmless. It is noted only for awareness.

---

## Review D: runner, fleet-protocol, CLI, web, CI/deploy (koda main @ b98893e4, 2026-11-14)

Read-only static review. Base: 61052931 (prior Review D and E in `docs/20261101-review-whole-repo.md`). No tests or builds were run. Evidence is file:line at HEAD b98893e4. Prod plan read: `/Users/williamkhoo/workspace/subrina-coder/projects/koda/koda-prod-deployment-options-2026-11-14.md`.

### 1. Summary

**Grades (0-20 per dimension)**

| Dimension | D1 runner + protocol + CLI | D2 web + CI + deploy |
|:--|:--|:--|
| Security | 14 | 15 |
| Reliability | 15 | 14 |
| API Design | 16 | 15 |
| Code Quality | 14 | 15 |
| Best Practices | 15 | 14 |
| **Total /100** | **74** (prior 73) | **73** (prior 68) |

Prior at 61052931: D1 13/14/16/15/15, D2 13/12/15/16/12.

**What moved since 61052931**
- The web session is now sound on the page path and the streams. SSR refresh exists (`server/middleware/session-refresh.ts`), logout revokes through refresh when the access cookie is gone, and outages no longer stop streams.
- The runner hardened the git calls it makes (`HARDENING_ARGS`), bounded the sync retry loop, moved the watch loop to a process-identity check, and rotates `runner.log`.
- Forge tokens for FIX/REVIEW now have a 50-minute minimum life, with a `fresh` mint.
- The settled Ruling 5 substitute is built: a `trust_domain` placement misfit (`apps/api/src/fleet/jobs/placement-rules.ts:148-152`, applied at `:231` and `:237`).
- Deploy and release: the API image runs as `koda`, host ports are loopback-only, the example compose requires secrets, Ollama is pinned and loopback-only, release permissions are scoped per job, actions are SHA-pinned, dependabot is on, and the release checkout uses the tag.

**What is still open**
- Still open: the sandbox for raw job kinds (SEC-2 ruling 4), the FIX push-scope residual (SEC-3), the cancel-path pgid signal without an identity check (BUG-4), the bidi/control-character render (SEC-12), FIX diagnostics not sanitized (SEC-13), no CSP or security headers (E SEC-11), `ci.yml` with no `permissions:` and tag-pinned actions (E SEC-13), and the CLI secrets on argv (prior SEC-8).
- Prod gaps are the largest block: no Kubernetes manifests, no off-host backup, a backup script that is local-only, no TLS, `secure: true` cookies hard-coded, no readiness that checks the DB, no metrics.

**New findings (this review):** HIGH 0, MEDIUM 1, LOW 5 (including D/SEC-14 downgraded to LOW because nax reads and deletes the token file at startup). Details in section 3.

**Prior-status counts (24 Area D IDs from 11-01):** Fixed 12, Partial 5, Open 6, Closed by ruling 1.

**Top gaps:** (1) TLS and cookie `Secure` path for prod; (2) off-host backups and restore; (3) k3s manifests and migrate Job; (4) CSP and security headers; (5) RUN and FIX token scope decisions (raw bash default with a repo write token in a file).

---

### 2. Prior findings status

Status key: Fixed, Partial, Open, or Closed by ruling. IDs are as used in the 11-01 Review D section.

| ID | 11-01 title | Status | Evidence (HEAD b98893e4) |
|:--|:--|:--|:--|
| SEC-1 | Raw REVIEW/FIX can mint any concurrent job's push token (Ruling 5 nonce) | Closed by ruling | Nonce dropped by ruling. Substitute built: `apps/api/src/fleet/jobs/placement-rules.ts:148-152` (`hasTrustDomainMisfit`), `:231`, `:237`; spec `.nax/features/review-p0-bundle/spec.md` US-003. Residual: raw kinds are not sandboxed (SEC-2). |
| BUG-1 | Page load more than 15 min after refresh forces re-login | Fixed | `apps/web/server/middleware/session-refresh.ts:1-36` refreshes when the access cookie is missing and the refresh cookie is present; `apps/web/server/utils/session-refresh.ts:29-51`; `apps/web/server/utils/api.ts:39-61` sets cookies. Test `tests/server/session-refresh*.spec.ts`. |
| BUG-2 | Forge token handed to nax is a snapshot with about 5 minutes left | Fixed | `apps/runner/src/executor/host-executor.ts:44` (`FORGE_TOKEN_MIN_REMAINING_MS = 3_000_000`), used at `:273-275` and `:296-298`; `apps/runner/src/credentials/broker.ts:163-180` (`freshToken`); `apps/api/src/fleet/git-broker/git-token.broker.ts:76` (no reuse when `fresh`); `apps/api/src/fleet/sync/sync.service.ts:179` passes `fresh` for FIX and REVIEW only. RUN gap: see BUG-9. |
| SEC-2 | Runner git in the shared clone honours repo hooks and config | Partial | `apps/runner/src/executor/git.ts:65` `HARDENING_ARGS` now sets `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `submodule.recurse=false`, applied at `:85`. Missing: `protocol.file.allow=never`. Missing: sandbox forced for raw kinds (`apps/runner/src/executor/job-profile.ts:25-60` has no `sandbox` key). |
| SEC-3 | FIX raw agent holds a token that can push to any branch | Partial | Default-branch gate added: `apps/api/src/fleet/git-broker/git-token.broker.ts:110-116` refuses a FIX mint when the default branch is not protected (`isBranchProtected` in `github-app-client.ts:168`), unless the per-repo override `fixAllowUnprotected` is set (commit db7ed657, #393). Residual: no runner-side refspec allowlist (`apps/runner/src/executor` has no refspec filter), so non-default branches stay writable. |
| BUG-3 | Persistent 400 makes sync loop hot-loop and overwrite events | Fixed | `apps/runner/src/sync/sync-loop.ts:195-199` halving is bounded; `:200-208` acks retry is once; `:209-232` drops the poison event (`replaceEvent`) and returns `this.retry(error)`, which sleeps through `run()` at `:112-115`. |
| BUG-4 | Watch liveness is `kill(pid,0)` only; EPERM counts as alive | Partial | EPERM fixed: `apps/runner/src/executor/nax-process.ts:83-91` returns false on any throw. Identity check added on watch: `apps/runner/src/supervisor/job-run.ts:442-449` with `host-executor.ts:318-333` (`processIdentity`). Still open: cancel path signals the pgid with no identity check: `job-run.ts:199-203` (`sendTerm`, called at `:188`, `:421`, `:437`) and `:382-388` (`escalateKill`). |
| OPS-1 | launchd `KeepAlive` unconditional; `runner.log` never rotated | Fixed | `apps/runner/src/service/units.ts:119-123` `KeepAlive` is `SuccessfulExit false`. Rotation: `apps/runner/src/service/log-rotate.ts:1-30` (10 MB, copy then truncate, `O_NOFOLLOW`), wired at `apps/runner/src/daemon/daemon.ts:122-129` and `:310`. |
| SEC-4 | Logout skips revocation with no access cookie | Fixed | `apps/web/server/api/auth/logout.post.ts:16-37` refreshes with the refresh cookie and then calls `/auth/logout` with the new bearer. |
| BUG-5 | `SameSite=Strict` plus no return-to sends deep links to `/` | Partial | Return-to fixed: `apps/web/middleware/auth.global.ts:23-25` keeps `redirect`; `apps/web/pages/login.vue:91` uses `safeRedirectPath`. Still open: refresh cookie `sameSite: 'strict'` (`apps/web/server/utils/api.ts:55`) and `secure: true` hard-coded (`:47`, `:56`). |
| BUG-6 | API outage treated as logout; streams stop permanently | Partial | Streams fixed: tri-state `refreshSession` (`apps/web/composables/useAuth.ts:140-155`); `apps/web/lib/project-event-stream.ts:215-234` and `apps/web/lib/thread-event-stream.ts:87-106` stop only on `unauthorized`. Still open on page loads: `apps/web/server/api/auth/me.get.ts:19-21` returns `{ user: null }` for any upstream status of 400 or more; `apps/web/composables/useAuth.ts:126-128` (`fetchUser` catch) sets `user` to null; `apps/web/middleware/auth.global.ts:17-26` redirects to `/login`. A 502 during a deploy logs a valid session out on navigation. |
| SEC-5 | Raw invite token in client paths | Open | Client paths still carry the raw token: `apps/web/pages/invite/[token].vue:43` (`apiPath\`/invites/${token}\``), `apps/web/composables/useAuth.ts:86`. The Nitro accept route encodes it (`apps/web/server/api/invites/[token]/accept.post.ts`, `encodeURIComponent`). |
| SEC-6 | Example compose falls back to `change-me` secrets | Fixed | `deployments/example/docker-compose.yml:13,15` use `${VAR:?set ...}` (no default). |
| SEC-7 | API image runs as root | Fixed | `apps/api/Dockerfile:138` `USER koda` (uid 1001), with writable dirs `/data`, `/app/data`, `/app/lancedb` only. |
| SEC-8 | API port published on all interfaces | Fixed | `docker-compose.yml:18-19` `127.0.0.1:${API_PORT}`; `deployments/example/docker-compose.yml:9-10` loopback. |
| SEC-9 | Ollama published on 0.0.0.0, `:latest` | Fixed | `docker-compose.yml:105-111`: `ollama/ollama:0.35.1`, `127.0.0.1:11434`, `profiles: ["rag"]`. |
| SEC-10 | Compose token TTL 7d access and 30d refresh | Fixed | `docker-compose.yml:23,25` default `15m` access and `7d` refresh; example `:14,16`; dev `docker-compose.dev.yml:13,15` (7d refresh). |
| SEC-11 | Release grants broad write and id-token workflow-wide; tag-pinned actions | Fixed | `.github/workflows/release.yml:17` top-level `permissions: {}`; per-job `contents: read`; `id-token: write` only on the cli job (`:101`); actions SHA-pinned (`:62`, `:103`, `:166`, `:180`); `.github/dependabot.yml` (github-actions, weekly). Caveat: `ci.yml` still uses `@v7`/`@v2` tags (see E carry). |
| BUG-7 | `workflow_dispatch` re-publish checks out default branch | Fixed | `release.yml:64`, `:105`, `:168` `ref: refs/tags/...`. |
| SEC-12 | Bidi and zero-width characters invisible in approval panel | Open | No filter found: `apps/web/lib/fleet-approvals.ts`, `apps/web/components/approvals/ApprovalRequestBashPanel.vue`, `apps/runner/src/approvals/detail-parser.ts` (grep for bidi/zero-width ranges returned nothing). |
| SEC-13 | FIX `stateReason` is raw nax stderr, not sanitized | Open | `apps/runner/src/executor/host-executor.ts:402-405`: `.slice(0, 200)` only, no `sanitizeDiagnostic`. |
| ENH-1 | FIX step-2 output never streamed live | Open | `host-executor.ts:356-359` `logSources` names only `nax.stdout`/`nax.stderr`; `fix.stdout`/`fix.stderr` appear only in the bundle. |
| BUG-8 | `assertCloneUrl` accepts `http:` and `file:` | Open | `apps/runner/src/executor/workspace.ts:7` `CLONE_SCHEMES = https, http, file`; `:17` check. |
| STYLE-1 | File size | Open (worse) | `apps/runner/src/thread/thread-job-run.ts` 1114 lines (was 1045); `apps/runner/src/supervisor/job-run.ts` 754 (was 727); `host-executor.ts` 552. |

**Carried items from the 10-18 Review D/E that are not in the 11-01 Area D list**

| ID | Title | Status | Evidence |
|:--|:--|:--|:--|
| E BUG-6 | `deploy.sh` health race | Fixed | `deployments/example/deploy.sh:76-77` `up -d --wait api web`. |
| E SEC-9 | `${{ }}` inside `run:` | Fixed | `release.yml:35` routes inputs through env; `ci.yml:251,255` interpolate matrix integers only. |
| E OPS-1 | Release gaps (TURBO cache not wired) | Partial | `release.yml:192-193` passes `TURBO_TOKEN` as a build-arg, with no `secrets:` input; the Dockerfiles read `/run/secrets/TURBO_TOKEN` (`apps/api/Dockerfile:62-63`), so the cache is never used. See SEC-15. |
| E SEC-10 | Refresh cookie path `/` | Open | `apps/web/server/utils/api.ts:48,57` `path: '/'`. |
| E SEC-11 | No CSP or security headers | Open | No `routeRules` headers in `apps/web/nuxt.config.ts`; no header middleware under `apps/web/server/middleware/` (only `client-ip.ts` and `session-refresh.ts`). |
| E SEC-12 | `.dockerignore` only root `.env` | Open | `.dockerignore` lists `.env` and `.env.*` at root only; `apps/api/.env.test` is tracked (see SEC-16). |
| E SEC-13 | CI `TURBO_*` to every job; no `permissions:`; tag-pinned actions | Open | `.github/workflows/ci.yml:32-33` workflow-level `env`; `grep '^permissions' ci.yml` returns 0; `uses: actions/checkout@v7`, `oven-sh/setup-bun@v2`, etc. |
| E ENH-1 | API image lacks `NODE_ENV=production` | Open | `apps/api/Dockerfile` sets `ENV_NAME=production` only; neither Dockerfile sets `NODE_ENV`. |
| E BUG-5 (api) | `secure: true` hard-coded | Open | `apps/web/server/utils/api.ts:47,56`. |
| E PERF-1 | No refresh single-flight | Open | `apps/web/composables/useAuth.ts:140-155`. Low impact: refresh tokens are stateless (`apps/api/src/auth/auth.service.ts:145-156`, tokenVersion), so concurrent refreshes do not revoke each other. |
| E STYLE-1 | Duplicated stream recovery | Open | `apps/web/lib/project-event-stream.ts:215-234` and `apps/web/lib/thread-event-stream.ts:87-106` repeat the same shape. |
| 10-18 D BUG-3 | `pruneJobs` throws outside try | Open | `apps/runner/src/daemon/daemon.ts:86-89` (`assertInside` before the try), `:308` `void pruneJobs(...)`. |
| 10-18 D SEC-4 | Journal mode skipped when root | Open | `apps/runner/src/journal/journal.ts:9` `process.getuid() === 0`. |
| 10-18 D SEC-5 | Enroll token on argv | Open | `apps/runner/src/main.ts:37` `--token` (env fallback exists at `:44`); `apps/cli/src/commands/fleet-runner.ts:96` prints the argv form. |
| 10-18 D SEC-8 | Secrets on argv | Open | `apps/cli/src/commands/auth.ts:49` (`--password`), `user.ts:63` (`--password`), `webhook.ts:21` (`--secret`). |
| 10-18 D SEC-9 | Repo config selects profile | Open | `apps/cli/src/config.ts:154-155`. |
| 10-18 D STYLE-2 | `??` for apiKey | Open | `apps/cli/src/config.ts:165-170`. |
| 10-18 D PROTO-1 | Dead `nextPollAfterMs` | Open | `packages/fleet-protocol/src/index.ts:374`. |
| 10-18 D ENH-1 | systemd hardening | Partial | `apps/runner/src/service/units.ts:78-81` adds `RestartPreventExitStatus=2`; no `NoNewPrivileges` or `Protect*` lines. |
| 10-18 D MEM-1 | Credential socket re-reads after newline | Open | `apps/runner/src/credentials/cred-server.ts:56-70`: `answered` is set only when the reply resolves, so chunks arriving during the wait call `request()` again. |

---

### 3. New findings

Numbering continues after the 11-01 Area D IDs (SEC-13, BUG-8, STYLE-1, ENH-1, OPS-1).

##### SEC-14 [LOW, downgraded] RUN token file is read and deleted by nax at startup
- **Location:** `apps/runner/src/executor/host-executor.ts:296-307` writes the token file for GitHub RUN; `apps/api/src/fleet/jobs/dispatch-input.ts:76` defaults RUN to raw bash.
- **Assessment:** nax reads and deletes the token file at startup (`captureForgeIdentity`, nax >= 0.91.7), before the raw RUN agent can access it. The original same-user-file exposure scenario therefore does not hold. The login-only identity is implemented by the follow-up change; it removes the file and avoids waiting for token life.
- **Residual:** the separate fresh-wait and token-expiry defects remain D/BUG-9; this downgrade does not close those reliability issues.

##### BUG-9 [LOW] RUN forge identity waits 50 minutes of token life that the API will not mint for RUN
- **Location:** `apps/api/src/fleet/sync/sync.service.ts:179` passes `fresh` only for FIX and REVIEW. `apps/runner/src/executor/host-executor.ts:44` requires 3,000,000 ms of remaining life for RUN too (`:296-298`). The broker waits `tokenWaitMs` (`apps/runner/src/daemon/tuning.ts:89`, 120 s) in `broker.ts:166-186`.
- **Scenario:** if the job's cached token was minted more than about 10 minutes before the identity step (a readopted or retried RUN), the runner sends `fresh`, the API ignores it for RUN and returns the cached token. The runner keeps polling until the 120 s timeout, then starts the RUN without a forge identity ("RUN starts without a forge identity", `host-executor.ts` warn path). The RUN is delayed 2 minutes and loses its login.
- **Fix:** add `FleetJobKind.RUN` to the `fresh` condition at `sync.service.ts:179`, or lower the RUN minimum to the cache margin. Add a spec for a RUN with `fresh: true`.

##### SEC-15 [LOW] Release passes `TURBO_TOKEN` as a Docker build-arg that the Dockerfiles never declare
- **Location:** `.github/workflows/release.yml:192-193` (api job); the web job is the same. The Dockerfiles read the secret from `/run/secrets/TURBO_TOKEN` (`apps/api/Dockerfile:62-63`, `apps/web/Dockerfile:62-63`) and declare only `TURBO_TEAM` and `TURBO_API` as ARGs (`apps/api/Dockerfile:51-52`).
- **Scenario and impact:** the value is inert today, so the remote cache is never used (E OPS-1). If someone later adds `ARG TURBO_TOKEN` to the Dockerfile, the token is recorded in the image history of public Docker Hub images.
- **Fix:** replace the build-arg with the action's secrets input, `secrets: |` `TURBO_TOKEN=${{ secrets.TURBO_TOKEN }}`, which matches `--mount=type=secret,id=TURBO_TOKEN` in the Dockerfile. Remove the build-arg line.

##### BUG-10 [LOW] `DATABASE_URL` is built by raw interpolation of the password
- **Location:** `docker-compose.yml:21` and `:56`; `deployments/example/docker-compose.yml:12`:
  ```yaml
  DATABASE_URL: postgresql://${POSTGRES_USER:-koda}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-koda}
  ```
- **Scenario:** a generated password containing `@`, `:`, `/`, `?`, `#` or `%` breaks the URL. The API fails at startup or connects with a truncated password. The migrate service fails the same way, so the stack does not come up. This matters for prod, where the plan has a generated Postgres password.
- **Fix:** require URL-safe passwords in `deploy.sh` (validate with a regex), or percent-encode in the compose by providing a pre-built `DATABASE_URL` secret.

##### SEC-16 [LOW] A tracked `apps/api/.env.test` carries secret-named keys and is outside `.dockerignore`
- **Location:** `apps/api/.env.test` (tracked; keys include `JWT_SECRET`, `JWT_REFRESH_SECRET`, `API_KEY_SECRET`, `DATABASE_URL`). `.dockerignore` only matches `.env` and `.env.*` at the root. The API builder stage copies the turbo-pruned tree (`apps/api/Dockerfile:59-62`). The runtime stage copies only `dist`, `node_modules` and `prisma`, so it does not reach the final image.
- **Note:** I did not print the values. Confirm they are throwaway test strings, not reused anywhere.
- **Fix:** add `**/.env*` with `!**/.env.example` to `.dockerignore`, or move the test env to a generated file.

---

### 4. Gap analysis

**4a. Prod deployment gaps (against the 11-14 plan)**

| Gap | Design source | Current state | Evidence | Suggested priority |
|:--|:--|:--|:--|:--|
| No Kubernetes manifests, kustomize or Helm in the repo | Plan "Option 3" and trap 9 (manifests in git) | Only `deployments/example` (compose). `git ls-files` finds no k8s, helm or kustomize files | `deployments/example/` | P1, blocked by k3s decision |
| TLS and `Secure` cookies | Plan trap 3 (TLS, not `--insecure-http`) | No TLS config in the repo. `secure: true` hard-coded, so plain HTTP cannot carry the auth cookies. Example compose publishes web on `0.0.0.0:3101` over HTTP | `apps/web/server/utils/api.ts:47,56`; `deployments/example/docker-compose.yml:53-54` | P1 |
| Backups off the VM | Plan trap 5 | `deployments/example/backup-db.sh` writes to `./backups` next to the compose file. No schedule, no off-host copy, no restore script or restore test | `backup-db.sh` (`BACKUP_DIR`) | P1 |
| Migrations on Postgres in k3s | Plan Option 3 (migrate Job) | Compose `migrate` service runs `prisma migrate deploy` before api (`docker-compose.yml:49-62`), but no Job and no rollback guidance. The api never migrates on boot (good) | `docker-compose.yml:49-62` | P1 |
| Health checks | Plan (Recreate, readiness) | `/api/health` returns ok without a DB ping (`apps/api/src/health/health.controller.ts:17-19`). Web checks `/` (SSR). No separate liveness and readiness | `health.controller.ts` | P2 |
| Observability | Plan (none stated) | No metrics or tracing endpoints. Logs go to stdout (api, web). Runner logs to a rotated file | `git grep prometheus/otel` finds only unrelated ingest code | P2 |
| Ollama for prod | Plan trap 4 | Compose profile `rag` only; no in-cluster or LAN LLM box in the repo | `docker-compose.yml:105-111` | P2 |
| Email (SMTP) | Plan trap 10 | Not checked in this review | n/a | P2 |
| `NODE_ENV=production` in images | Hardening | Not set in either Dockerfile | `apps/api/Dockerfile`, `apps/web/Dockerfile` | P2 |
| Postgres image tag and TLS to DB | Plan trap 6 | `postgres:16` (floating minor); no TLS to the DB in compose | `docker-compose.yml:65` | P3 |

**4b. Runner, protocol and web designs not fully built**

| Gap | Design source | Current state | Evidence | Suggested priority |
|:--|:--|:--|:--|:--|
| Sandbox for raw job kinds (REVIEW, FIX, THREAD, RUN) | 11-01 SEC-2 ruling 4 | Not forced. `job-profile.ts` has no `sandbox` key | `apps/runner/src/executor/job-profile.ts:25-60` | P1 (ruling) |
| FIX push refspec allowlist | 11-01 SEC-3 option (b) | Default-branch gate built (#393). Non-default branches still writable | `git-token.broker.ts:110-116` | P2 |
| Cancel path identity check | 10-18 D BUG-4 | Not built | `job-run.ts:199-203`, `:382-388` | P2 |
| Systemd unit hardening | 10-18 D ENH-1 | Restart prevention only | `units.ts:78-81` | P3 |
| Credential socket single-reply guard | 10-18 D MEM-1 | Not built | `cred-server.ts:56-70` | P3 |
| Thread `ask` approval decisions | `docs/superpowers/specs/2026-11-04-thread-agents-and-modes-design.md` §4 | Built: `ThreadAnswerPayload` has `decision: allow | deny` | `packages/fleet-protocol/src/threads.ts:132` | Done |
| `thread.mode.ask` and `thread.mode.full` keys | Same design §5 | Built and enforced on create and mode change | `apps/api/src/fleet/threads/thread-route.commands.ts:41`, `threads.controller.ts:121` | Done |
| ACP `cursor` agent | Same design §2 | Built (`ThreadAgent` includes `cursor`) | `packages/fleet-protocol/src/threads.ts:16`; `acp-agent-probe.ts:13` | Done |
| Thread publish commit wording | Same design §3 | Built (`docs(...)` only for doc-only paths) | `apps/runner/src/thread/thread-publish.ts:94-96` | Done |

**4c. Web and CI coverage**
- Web Playwright e2e: 17 fleet e2e specs plus auth, a11y, agents and command palette (`apps/web/tests/e2e/`). Gaps: no e2e for the refresh path (SSR middleware), the outage path, or a deep-link after login. Suggested P1: one e2e that expires the access cookie and reloads.
- Deploy smoke: none. `deploy.sh` relies on `--wait`. Suggested P1: a CI job that brings up the compose (or a k3s kind cluster), runs migrate, checks `/api/health`, and logs in through web.
- Runner: 180 spec files and `apps/runner/test/integration/` (approval relay, capabilities, credentials). No test drives launchd install or a real ACP session. P2.
- CLI: no e2e (`apps/cli` has unit specs only). P3.

**4d. OpenAPI consumers (heuristic)**

Method: each path in `openapi.json` (215 operations) was matched against literal and template URLs in `apps/web` and `apps/cli` (non-test source). Result: 148 of 215 match a literal consumer. The 67 unmatched are a heuristic list, not proof. Template-literal paths built from variables may be missed, and `apps/runner` was not scanned, so the runner routes under `/fleet/runner/*` are consumed by the runner and are not counted as gaps.

| Module | Operations | No literal web or CLI match | Examples to check |
|:--|:--|:--|:--|
| projects (all) | 115 | 43 | `kb/import/graphify`, `memory/export`, `ci-webhook-token`, `codeintel/impact`, `tickets/{ref}/verify`, `tickets/{ref}/start`, `tickets/{ref}/fix`, `tickets/{ref}/verify-fix` |
| fleet (non-project, non-runner) | ~26 | ~9 | `fleet/activity`, `fleet/budgets/{id}/resume`, `fleet/repos/{id}/check`, `fleet/repos/{id}/auto-review`, `fleet/repos/{id}/fix-checks`, `fleet/repos/{id}/fix-unprotected` |
| threads | 8 | 5 | `threads/{id}/messages`, `archive`, `stop`, `end-session`, `answer`. Web likely uses template paths; verify |
| agents | 6 | 2 | `agents/me`, `agents/{slug}/pickup` |
| memory | 5 | 2 | `memory/extract`, `memory/decisions` |
| code-intel | 5 | 1 | `code-intel/index` |
| context, webhooks, approvals, approval-policies | 2, 1, 5, 3 | 1, 1, 1, 1 | `context/{slug}/query`, `webhooks/{id}`, `approvals/{id}/cancel`, `approval-policies/keys` |
| auth, me, admin, comments, health, audit, home, invites, permissions, roles, role-bindings | - | 0 | all matched |

Summary by module: the largest unconsumed area is project-scoped ticket workflow (`tickets/{ref}/start|fix|verify|verify-fix`) and the KB and memory export or import routes. These look like agent-only or CLI-only surfaces, and the CLI has no command for them. The fleet budget resume and repo auto-review or fix-check toggles are reachable through the UI only if the web composable uses a template path. Verify those before treating them as gaps.

---

### 5. Rulings needed

1. **RUN forge token (SEC-14, downgraded to LOW).** nax reads and deletes the token file at startup, so the raw RUN agent cannot read it. The login-only identity is implemented; separate fresh-wait/expiry defects remain D/BUG-9.
2. **ACP `read` mode is unsandboxed with `inheritEnv: true` (`apps/runner/src/thread/session-factory.ts:107-113`, `:145`).** The design accepts unsandboxed ACP in every mode. Confirm that the `read` guarantee relies on nax-agent-acp's profile mapping (design §3), and that koda should add a test that asserts it.
3. **FIX push scope beyond the default branch (SEC-3 residual).** Accept the non-default-branch write, or add a runner refspec allowlist (PR head branch only).
4. **Sandbox for raw kinds (SEC-2 ruling 4).** Force `sandbox` on for REVIEW, FIX, THREAD and RUN in `job-profile.ts`, or accept the global nax config.
5. **Page-load outage behaviour (BUG-6 residual).** Should a 5xx from `/api/auth/me` keep the session (as the streams now do), or still send the user to login? Recommendation: keep the session on 5xx and retry.
6. **TLS path for prod (before the k3s plan).** `secure: true` cookies need HTTPS on every hop the browser sees. Decide the TLS terminator (Traefik with cert-manager, or a local CA). Without it the LAN-only HTTP deploy cannot log in.
7. **Release TURBO cache.** Wire it with `secrets:` (SEC-15) or drop the cache step. Either way, remove the build-arg.
8. **Prod backup target and restore test.** Choose the off-host destination and require a restore drill before the first prod deploy.
9. **Readiness semantics.** Should `/api/health` include a DB ping (used by the k3s readiness probe), or stay a liveness check?
