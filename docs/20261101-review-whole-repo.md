# Whole-Repo Code Review: koda

**Date:** 2026-11-01
**Reviewer:** Subrina (AI)
**Version:** 0.4.2, main `61052931`
**Scope:** `apps/api` (~84k LOC, excluding `src/generated`), `apps/web` (~35k), `apps/runner` (~13k), `apps/cli` (~7k), `packages/fleet-protocol`, CI and release workflows, Dockerfiles, compose files and `deployments/`.
**Prior review:** `docs/20261018-review-whole-repo.md` (base `44269581`). There have been 55 commits since then: permission and approval redesign P1-P3, S6 K1 (PR auto-review), K2 (review memory) and K3 (PR fix).
**Baseline:** Tests were not run. This is a static review.

**Method:**
- Four read-only reviewers, one per area:
  - **A:** API platform, the ticket domain, and the permission and approval gate.
  - **B:** API fleet control plane, the MCP endpoint, and K1-K3 job and token plumbing.
  - **C:** fleet operations (reviews, knowledge, budgets, schedules, analytics, dashboard), VCS, webhooks, RAG, memory and code-intel.
  - **D:** runner, `fleet-protocol`, CLI, web, CI and deployment.
- Each finding was traced through its callers, guards and transactions.
- During consolidation, eight findings were checked by hand against the source, and all eight held:
  - A/SEC-1: `project-invites.service.ts:62-74,214` returns the raw `invitePath`. `role-admin.service.ts:265-268` skips the binding keys and leaves `member.add`/`invite.create` as the only gate.
  - A/SEC-2: `projects.controller.ts:261-264`. On the self path, `agentsService.update(agentSlug, updateDto)` runs before `parseBody` and the gate, so the unparsed DTO is applied.
  - B/SEC-2: `sync.service.ts:132-136`. Only `WORKSPACE` threads are refused; a PROJECT thread falls through to `findRepo(job.repoId)` and gets a write token.
  - B/MEM-1: `bundle-reader.ts:85-98` checks size per entry only and appends array slots without a count cap.
  - B/BUG-1: `fleet-sweeper.ts:59-75`. The per-id loop has no try/catch, so one throwing transaction ends the sweep.
  - C/SEC-1: `knowledge-chunk-store.ts:82,90,97` filters on `source_id` only.
  - C/SEC-2: `review-event.minter.ts:47-84` takes `disagreedBy` logins from the uploaded artifact and only checks repo role, not thread authorship.
  - D/SEC-1: `cred-server.ts:32-36` answers a bare `get` (no nonce). `assign-parser.ts:196` forces REVIEW to `bashMode: raw`.
  - D/BUG-1: `me.get.ts:10-13` returns `{ user: null }` when the access cookie is missing and never tries the refresh cookie.

Finding IDs are prefixed with their area letter. For example, **D/SEC-1** is finding SEC-1 in area D. The full write-up for each finding (code excerpt, scenario, fix) is in that area's section further down.

---

## Overall Grade: C+ (74/100)

| Area | Security | Reliability | API Design | Code Quality | Best Practices | Total |
|:--|--:|--:|--:|--:|--:|--:|
| A: API platform + tickets + permission gate | 14 | 15 | 15 | 15 | 15 | 74 |
| B: Fleet control plane + MCP | 16 | 15 | 17 | 17 | 17 | 82 |
| C: Fleet ops + intel | 15 | 12 | 16 | 14 | 15 | 72 |
| D1: Runner + protocol + CLI | 13 | 14 | 16 | 15 | 15 | 73 |
| D2: Web + CI + deploy | 13 | 12 | 15 | 16 | 12 | 68 |
| **Mean** | **14.2** | **13.6** | **15.8** | **15.4** | **14.8** | **73.8** |

The score drops slightly from 10-18 (B, 75). That is not because the new code is weak. The permission and approval redesign is solid:
- Every route in scope declares a key.
- The guard fails closed.
- Audit records actor, approval mode and approver in the same transaction.
- Double approve, approve after expiry, self-approve and redeem replay are all race-safe.

The K1-K3 code is also well fenced: one review claim per PR head, at most one follow-up REVIEW per FIX, no automatic fix loop, and untrusted PRs never write memory. The drop comes from two things:

1. **Work that was accepted or ruled but never built.** Ruling 5 (per-job nonce on the credential socket, no raw job alongside another project's job) was accepted on 10-18 and is not implemented (D/SEC-1). It now matters more, because K1 and K3 force every REVIEW and FIX job to raw bash with a repo write token.
2. **Backlog that did not move.** None of the 42 prior D and E findings is fixed (2 partial). The 10-18 HIGH web session bug is still open (D/BUG-1). Area C still has 5 prior MEDIUM reliability bugs open.

There are four HIGH findings:
- **A/SEC-1:** an agent holding Project Admin can create a human Project Admin through an invite link it receives in the response. That human can then approve the agent's own requests.
- **A/SEC-2:** the agent self-update path skips parsing and the gate, so a PAUSED agent can un-pause itself.
- **D/SEC-1:** Ruling 5 is not built. A raw REVIEW or FIX agent can fetch other jobs' push tokens from their credential sockets.
- **D/BUG-1:** carried from 10-18; the SSR probe never refreshes, so users are forced to log in again.

The MEDIUM findings fall into five groups:

1. **The K-series widened the token and trust surface.** REVIEW and FIX get repo-wide `contents: write` (B/SEC-1, D/SEC-3). A PROJECT-thread anchor token is still minted (B/SEC-2). Runner git still honours hooks that a raw agent can plant (D/SEC-2). The forge token handed to nax is a snapshot that can expire before the push (D/BUG-2).
2. **Ways around the gate rather than holes in it.** MCP decide skips the REST policy check (A/SEC-4). A status PATCH is gated as `ticket.update` (A/SEC-5). Credential writes are tiered below the design (A/SEC-6). The self-fix/verify rule is missing (A/SEC-3).
3. **Review-memory provenance.** A forge approver is credited without proof that they replied in the thread (C/SEC-2). Knowledge-store source confusion lets KB writes impersonate repo files (C/SEC-1). The active-decision set is unbounded (C/PERF-1).
4. **Reliability carry-over.** Bundle ingest decompression bomb (B/MEM-1), sweeper with no per-item isolation (B/BUG-1), external side effects inside the approval transaction (A/BUG-1), and the prior C MEDIUMs (soft-delete leakage, placement starvation, import duplicates, entity-graph keys, optimize race).
5. **Deployment and session defaults (prior E, all open).** `change-me` secrets, a root API image, published API and Ollama ports, 7-day access tokens, broad release permissions, logout without revocation, and an API outage treated as logout.

---

## Findings index

### HIGH (4)

| ID | Title | Location |
|:--|:--|:--|
| A/SEC-1 | An agent with Project Admin can create a human Project Admin, or grant any role, with no human approval, through the invite link returned to it or through `member.add`. | `projects/invites/project-invites.service.ts:53-74,214`; `projects/members/project-members.service.ts:62-93`; `permissions/role-admin.service.ts:265-268`; `permissions/catalog.ts:452` |
| A/SEC-2 | Agent self-update on the roster route skips DTO parsing, the gate and approval. A PAUSED agent can set itself ACTIVE, raise its ticket limit and rename itself. | `apps/api/src/projects/projects.controller.ts:261-264` |
| D/SEC-1 | Ruling 5 is not implemented: no per-job nonce on the credential socket and no placement trust-domain rule. Raw REVIEW and FIX agents can fetch other jobs' push tokens, including other projects'. | `apps/runner/src/credentials/cred-server.ts:32-36`; `apps/api/src/fleet/jobs/placement-rules.ts:99-125,180-186`; `apps/runner/src/supervisor/assign-parser.ts:196` |
| D/BUG-1 | Carried from 10-18 (E/BUG-1). A full page load more than 15 minutes after the last refresh sends the user to /login, although the 7-day refresh cookie is valid. | `apps/web/server/api/auth/me.get.ts:9-13`; `apps/web/middleware/auth.global.ts:15-22` |

### MEDIUM (31 new or re-raised, plus 5 carried C items)

| ID | Title |
|:--|:--|
| A/SEC-3 | The design's verify-fix self-approval rule is not implemented: one agent can `/fix` and then `/verify-fix?approve=true` its own ticket (prior A/SEC-5). |
| A/SEC-4 | The MCP `koda_decide_approval` tool skips the policy check the REST decide route applies (`approval-mcp-tools.ts:67-73` vs `approval-requests.controller.ts:108-117`). |
| A/SEC-5 | `PATCH /tickets/:ref {status}` is gated under `ticket.update`, so a policy on the transition key can be bypassed. |
| A/SEC-6 | Key and credential writes (`agent.key.rotate`, `agent.create`, `user.create`, `invite.*`, CI token rotation) are tiered medium, below the design. An agent with Admin can rotate another agent's key or disable the human Owner. |
| A/BUG-1 | Deferred approval execution runs external side effects (GitHub PR, invite email) inside the DB transaction. If the transaction fails, the 5-minute retry opens a duplicate PR. |
| A/BUG-2 | `DELETE /agents/:slug` is still a hard delete that nulls authorship and assignments (prior A/BUG-1). |
| A/ENH-1 | Workflow comments (FIX_REPORT, REVIEW) can be edited or hard-deleted after the transition, with no history, and posted outside a transition. |
| B/SEC-1 | REVIEW and FIX jobs get the same repo-wide `contents: write` token as RUN, while an LLM reads untrusted PR text (`sync.service.ts:134-136`, `github-app-client.ts:70-71`). |
| B/SEC-2 | A PROJECT-thread job with no repoId still gets a write token for the anchor repo (prior B/SEC-3). |
| B/MEM-1 | Bundle ingest has no file-count or total-bytes cap, and K2 added an unbounded array slot (prior B/MEM-1, now wider). |
| B/BUG-1 | The sweeper and the sync placement step do not isolate failures per item: one bad job ends the sweep, and blocks token and command delivery (prior B/BUG-2). |
| C/SEC-1 | The knowledge store reads, replaces and deletes by `source_id` only. A KB writer can make content appear as a repo file or outcome in `koda_get_doc`, and the indexer deletes user rows that share an id. |
| C/SEC-2 | A review-minted DECISION credits any repo writer named in the runner-uploaded `disagreedBy`. Nothing checks that the login replied in the thread. |
| C/PERF-1 | `findActiveDecisions` has no limit or ordering. K2 adds up to 50 decisions per review job, and `/context` returns them all on every call. |
| D/BUG-2 | The forge token handed to nax is a one-shot snapshot that can have about 5 minutes left (the broker reuses tokens until 300 s before expiry). A long FIX push or reply fails. |
| D/SEC-2 | Runner git calls in the shared clone still honour hooks and config that a raw REVIEW or FIX agent can write (prior D/SEC-1, more exposed). |
| D/SEC-3 | A FIX job's raw agent holds a token that can push to any branch, including the default branch (accepted as a fact in the K3 design, never decided). |
| D/BUG-3 | A persistent 400 makes the sync loop retry hot (prior D/BUG-1). |
| D/BUG-4 | Watch liveness uses `kill(pid, 0)`, so pid reuse keeps a job RUNNING (prior D/BUG-2). |
| D/OPS-1 | launchd `KeepAlive` is unconditional, and there is no log rotation (prior D/OPS-1). |
| D/SEC-4..SEC-11, BUG-5..BUG-7 | Web, CI and deploy items carried from prior E, all open: logout without revocation, lost deep links, outage treated as logout, raw invite token in paths, `change-me` secrets, root API image, published API port, Ollama on 0.0.0.0, 7d/30d token TTLs, broad release permissions, re-publish of the default branch instead of the tag. |
| C (carried) | Prior C/BUG-1 (soft-deleted projects keep jobs, polling and budget state), C/BUG-2 (placement scans only the 50 oldest queued jobs), C/BUG-3 (VCS import duplicates), C/BUG-4 (entity graph reads keys no producer sends), C/BUG-5 (LanceDB optimize races index writes). All still open. |

### LOW (26)

| Area | IDs |
|:--|:--|
| A (10) | SEC-7 (RFC1918 proxy trust), SEC-8 (refresh tokens not one-time), SEC-9 (no secret minimum length), SEC-10 (GCM tag length), SEC-11 (GET pickup writes, ungated), BUG-3 (API-key DB error becomes 401), BUG-4 (P2002 becomes 500 on links and project slug), PERF-1 (PR creation on the request path), MEM-1 (`WebhookDelivery` never purged), ENH-2 (no shutdown hooks) |
| B (6) | SEC-3 (runner-chosen labels), SEC-4 (runner not revocable while holding jobs; disabled runner still gets tokens), BUG-2 (thread SSE rejects agents, contrary to its comment), SEC-5 (thread SSE does not re-check `thread.read`), BUG-3 (tool relay fence checked without a row lock), PERF-1 (map copies) |
| C (5) | BUG-1 (failed `markDispatched` leads to a duplicate paid review), BUG-2 (deferred `vcs.sync.all` in one transaction), SEC-3 (CI webhook replay through unsigned headers), ENH-1 (merged-PR rows have no actor), STYLE-1 (duplicated dispatch-error code) |
| D (5) | SEC-12 (approval panel shows bidi and zero-width characters invisibly), SEC-13 (FIX `stateReason` not redacted), ENH-1 (FIX output not streamed), BUG-8 (`assertCloneUrl` accepts `http`), STYLE-1 (file sizes) |

---

## Prior review (2026-10-18) status

| Area | Fixed / superseded | Partial | Open |
|:--|--:|--:|--:|
| A | 8 | 6 | 13 |
| B | 3 (SEC-2 fixed; SEC-1, BUG-1 superseded) | 1 | 6 |
| C | 2 | 5 | 16 |
| D | 0 | 1 | 17 |
| E | 0 | 1 | 23 |

The permission redesign closed most of the authorization findings from 10-18 (A/SEC-3, A/SEC-4, B/SEC-1, B/SEC-2, C/SEC-2). Almost none of the reliability, runner, web or deploy findings moved. The per-area tables below have file:line evidence for each.

---

## Rulings needed (decisions for you, not defects)

**Token and trust scope (K-series):**
1. **Ruling 5 timing (D/SEC-1).** Build the accepted short-term pair (socket nonce plus a placement trust-domain rule) now? Or, as an interim step, cap capacity at 1 on runners that advertise `botReview`/`botFix`?
2. **REVIEW and FIX token scope (B/SEC-1, D/SEC-3).** Should REVIEW get a review-only token (`contents: read`, `pull_requests: write`)? For FIX, choose one: accept a repo-wide write token, require default-branch protection before placing a FIX, or allow only the PR head branch in the runner git shim.
3. **PROJECT anchor token (B/SEC-2).** Refuse it, or record that Ruling 5 covers it and close it.
4. **Forge-token lifetime (D/BUG-2).** Skip token reuse for FIX and REVIEW mints (an API change), or ask for a generic nax token-refresh command (filed in nax as a generic feature).
5. **Force nax's OS sandbox for raw kinds (D/SEC-2)?**
6. **Follow-up REVIEW budget (B).** The follow-up REVIEW gets the FIX's full `maxCostUsd`, so one dispatch can spend up to twice its cap. This matches K3 D4; confirm it is intended.

**Permission model:**
7. **May agents hold `project-admin` or any role with `member.add` or `invite.create` (A/SEC-1)?** If no, restrict those keys to user principals. If yes, gate them with a human floor.
8. **May a project policy be weaker than a global policy for the same key?** The resolver ranks project policies first.
9. **May a global Admin disable the Owner (A/SEC-6)?**
10. **PAUSED semantics.** Should PAUSED agents be blocked at the guard? Today only gated writes refuse them.
11. **Retention** for `AuditEntry`, `ApprovalRequest`/`ApprovalDecision` and `WebhookDelivery`.
12. **Single-replica API.** `PermissionCache` and `ApprovalExecutionService.serialised` are per-process only. Confirm the API stays single-replica.

**Review memory (K2):**
13. **May a PR author approve "not a defect" on their own PR (C/SEC-2)?** Should approvals made by agents feed every review?
14. **Verify the approver's thread authorship with one GitHub call per event, or record it as `unverified-human`?**

**Carried:**
15. **Project soft-delete semantics (prior C/BUG-1).** This is still undecided after two reviews.
16. **CI webhook signature v2 (C/SEC-3)**, with a deprecation window.
17. **Prior E session and deploy backlog.** Has it been deferred by choice, or should it be bundled now?

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:--|:--|:--|:--|
| P0 | A/SEC-2 | S | Self path: parse the DTO and allow only a status-to-PAUSED (shutdown) field set; everything else goes through the gate. |
| P0 | A/SEC-1 | S-M | After ruling 7: `principals: ['user']` on `member.add` and `invite.create` for admin-grade roles, or a human floor on the grant. Stop returning the raw `invitePath` to agent callers. |
| P0 | D/SEC-1 | M | Ruling 5: a per-job nonce on the credential socket, plus a placement misfit for raw jobs alongside another project's job (or the capacity-1 interim). |
| P0 | D/BUG-1 | S | The SSR auth probe tries `/auth/refresh` when the access cookie is missing or expired, then retries. |
| P0 | B/SEC-1 + D/SEC-3 | M | After ruling 2: a review-only token for REVIEW and a push-scope limit for FIX. |
| P1 | D/SEC-2 | S | Harden runner git calls (`core.hooksPath=/dev/null`, ignore repo config) in the shared clone. |
| P1 | B/SEC-2 | S | Refuse a repo-less token request for PROJECT threads. |
| P1 | B/MEM-1 | S | Cap the file count and total decompressed bytes in bundle ingest; mark a failed ingest terminal. |
| P1 | B/BUG-1 | S | Wrap each sweeper item and the sync placement step in try/catch, log and continue. |
| P1 | A/SEC-4, A/SEC-5 | S | Send MCP decide through the same policy check; gate a status PATCH under the transition key. |
| P1 | C/SEC-1 | S | Filter knowledge-store reads and deletes on (source, source_id); reject the `repo:` and `outcome:` prefixes in `AddDocumentDto`. |
| P1 | C/SEC-2 | M | After ruling 14: verify that the approver replied in the thread, or downgrade `satisfiedBy`. |
| P1 | D/BUG-2 | S-M | After ruling 4: a fresh token for FIX and REVIEW. |
| P1 | A/BUG-1 | M | Move PR creation and email out of the approval transaction (`afterCommit` or outbox) and make them idempotent. |
| P1 | A/SEC-3, A/SEC-6 | M | Self-fix/verify agent-mode rule; re-tier credential write keys to the design (high or critical). |
| P2 | C/PERF-1 | S | Limit and order `findActiveDecisions`; budget decisions in `/context`. |
| P2 | C carried BUG-1..BUG-5 | M | Soft-delete cascade (after ruling 15), placement starvation, import upsert with a unique index, entity-graph keys plus a contract test, optimize under the write lock. |
| P2 | D/BUG-3, D/BUG-4, D/OPS-1 | S | Sync backoff; pid identity check; launchd `KeepAlive` on failure only, plus log rotation. |
| P2 | D web session bundle | M | E/SEC-1, BUG-2, BUG-3, SEC-2: revoke on logout, a return-to path after login, outage treated as reconnect, encode the invite token. |
| P2 | D deploy bundle | M | `change-me` secrets, non-root API image, unpublished API and Ollama ports, token TTLs, release permissions, tag checkout. |
| P2 | A/BUG-2, A/ENH-1 | M | Soft agent delete; immutable or versioned workflow comments. |
| P3 | LOW items | - | Fold them into the fix PRs they touch. |

---

# Area reports

---


## Review A: API platform, permissions/approvals, ticket domain (koda main @ 61052931, v0.4.2)

Scope: `apps/api/src/{permissions, approvals, policy, action-context, audit, auth, koda-domain-writer, tickets, projects (members, invites, assignees), agents, users, comments, labels, ticket-links, notifications, email, outbox, events, live, home, common, config, monitoring, health, webhook-security, prisma}`, `main.ts`, `app.module.ts`, `prisma/schema.prisma` and the migrations added since `44269581`.
Method: static, read-only. Every finding traced route decorator -> `CombinedAuthGuard` -> `ProjectMembershipGuard` -> `RequiresGuard` -> `ApprovalRouteGate` -> `ApprovalGate`/policy resolver -> route command -> service -> repository. Checklists: `universal.md`, `nestjs-app.md`. Design reference: `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (sections 1-7).

### 1. Summary

The P1-P3 redesign is a large improvement and is mostly well built. There is one permission catalog. Every controller route in this area declares a key, and `RequiresGuard` is wired on each `@Requires` that is guard-enforced. Every write runs inside an `ActionContext`, and an `AuditEntry` carrying actor, onBehalfOf, requiredMode, satisfiedBy and approver is written in the same transaction. The approval engine handles races correctly: decide takes a row lock, checks `pending` and expiry under it, and moves state by CAS. Execute is serialised, re-reads `approved` under the lock and re-checks the key. Redeem requires the same owner and the same input hash. The sweeper approves on timeout only when the floor is `none`.

The serious problems are **paths around the gate rather than holes in it**:
- An agent holding Project Admin can create a human account with Project Admin through `invite.create`, and the raw token comes back to the agent. `member.add` gives the same role to any existing user. Both keys are medium risk with floor `none`, while the equivalent `/role-bindings` grant needs a human (SEC-1).
- The project-roster PATCH lets an agent change its own status with no restriction, so a PAUSED agent can un-pause itself with no approval (SEC-2).
- The design's verify-fix self-approval rule (`agent` mode when the approver also wrote the fix) is not implemented (SEC-3).
- The MCP decide tool skips the policy gate that the REST decide route applies (SEC-4).
- PATCH with a status change is gated under `ticket.update`, not the edge key (SEC-5).
- Several credential-type writes are classed medium risk, against the design's tiering (SEC-6).

Reliability issues:
- Deferred approval execution runs external side effects (a GitHub PR, email) inside the execution DB transaction (BUG-1).
- Agent delete is still a hard delete (BUG-2).

Many prior LOW findings are unchanged.

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 7 |
| LOW | 10 |

---

### 2. Findings

#### HIGH

##### SEC-1 [HIGH] An agent can create a human Project Admin, or grant any role, without the human floor that binding grants carry
- **Where:**
  - `projects/invites/project-invites.service.ts:53-74` (create -> `assertMayGrant`), `:214` (raw token returned)
  - `projects/members/project-members.service.ts:62-93`
  - `permissions/role-admin.service.ts:265-268` (`assertMayGrant` "checks no `role.binding.manage` / `role.binding.global`: the calling route's own key (`member.add`, `invite.create`) is the gate")
  - `permissions/catalog.ts:406-453` (`member.add` and `invite.create` are `medium`, floor `none`, default `none`)
```ts
// project-invites.service.ts
const role = await this.assertMayGrant(principal, roleKey, projectId, null);
return this.inviteNewAddress(projectId, email, role, principal, locale);
...
return { outcome: 'INVITED', invite: ..., invitePath: `/invite/${raw}`, emailed };
```
- **Trace:**
  - `POST /projects/:slug/invites` uses `@Requires('invite.create')`, then `ApprovalRouteGate.run('invite.create')`.
  - For an AGENT subject the resolver returns the catalog default `none` for a medium key, so `ApprovalGate.gate` executes at once.
  - The handler returns `outcome.result`, which is the raw command result. It still contains `invitePath`, because `toResult` strips the token only from the stored request.
  - `assertMayGrant` checks escalation only against the caller's own keys in that project. A Project Admin agent holds `*`, so it may hand out `project-admin`.
  - `POST /invite/:token/accept` is public. It creates a USER and binds the invited `roleId` (`invite-acceptance.service.ts:93-100`).
- **Failure scenario:** an agent bound to `project-admin` in project P (for example a prompt-injected agent) does the following:
  1. Calls `POST /projects/P/invites {email:"x@attacker", roleKey:"project-admin"}`. It gets back `invitePath` at once.
  2. Accepts the invite through the public route and now holds a USER session with Project Admin in P.
  3. That user is human tier. `contributedMode` returns `human` for any USER decider who is not the actor (`approval-eligibility.ts:51-57`). The user holds `approval.decide` and `approval.policy.manage` in P, so it can approve every pending request the agent opened in P, including `human`-floor ones.
  4. It can also edit P's approval policies down to the floors. A human acting directly satisfies the `human` floor (`approval-gate.service.ts:98-100`).
  
  `member.add` does the same for any existing account, with an immediate binding. By contrast, `POST /role-bindings` with `role.binding.manage` (critical, floor `human`) would have parked the agent's grant for a human. This breaks design section 4 ("Role, binding and policy keys: floor `human`") and section 7 ("Agents may never change roles, bindings or policies"). `invite.resend` (`:123`) likewise hands the caller a fresh raw token for *another admin's* pending invite.
- **Fix:**
  - Treat any write that creates a binding as a binding write for approval purposes. Gate `member.add` and `invite.create` under `role.binding.manage` (or give them `risk: 'critical'`, floor `human`), or open the gate with `bindingGateKey(...)` as `/role-bindings` does.
  - Do not return `invitePath` to AGENT callers. Email only, or return it only after a human approval.
  - Re-check at accept time that the inviter still holds the role's keys.
  - Add a contract test: every code path reaching `MembershipService.createBinding*` must run under a critical, human-floor key.

##### SEC-2 [HIGH] Agent self-update on the roster route bypasses approval and the "no agent.update over yourself" rule; a PAUSED agent can un-pause itself
- **Where:** `projects/projects.controller.ts:261-264`; `agents/agents.service.ts:260-275`; `agents/dto/update-agent.dto.ts:4-19`; `auth/guards/combined-auth.guard.ts:94-96`
```ts
// Self shutdown is unconditional after roster validation and must never wait on approval.
if (isAgentPrincipal(principal) && principal.slug === agentSlug) {
  return JsonResponse.Ok(await this.agentsService.update(agentSlug, updateDto));
}
```
- **Trace:**
  - `CombinedAuthGuard` still authenticates PAUSED agents (`if (agent.status === 'OFFLINE') return false;` only).
  - `ProjectMembershipGuard` passes a rostered agent. `@Requires('agent.update', { enforcedBy: 'service' })` delegates the check to the handler.
  - The handler's self branch applies the whole `UpdateAgentDto` (`name`, `status` in ACTIVE|PAUSED|OFFLINE, `maxConcurrentTickets`). It never touches the route gate or the `ActorPrincipalLoader`, which refuses PAUSED actors elsewhere (`actor-principal.loader.ts:45`).
- **Failure scenario:**
  1. An admin PAUSEs a misbehaving agent.
  2. The agent sends `PATCH /api/projects/p/agents/<self> {"status":"ACTIVE","maxConcurrentTickets":1000,"name":"Owner"}`. It is ACTIVE again and every gated write works for it, with no approval request.
  
  `maxConcurrentTickets` is still `@IsNumber()` only, so `1.5` reaches an `Int` column (500) and negatives are accepted. This is the prior SEC-2, partly fixed (the project-admin side is fixed).
- **Fix:** In the self branch accept only `{ status: 'OFFLINE' }` (reject any other field with 400), and refuse a PAUSED caller. Change `maxConcurrentTickets` to `@IsInt() @Min(1) @Max(<cap>)`.

#### MEDIUM

##### SEC-3 [MEDIUM] The verify-fix self-approval rule from design section 4 is not implemented; one agent can fix and approve its own ticket
- **Where:** `tickets/tickets.controller.ts:374-403`; `tickets/ticket-route.commands.ts:91-102`; `permissions/system-roles.ts` (Developer holds `ticket.transition.*`); no code matches "latest fix" or the fix actor anywhere in `src`.
```ts
const outcome = await this.routeGate.run<TicketResponseDto>({
  key: isApproved ? 'ticket.transition.verify-fix.approve' : 'ticket.transition.verify-fix.return', ...
```
- **Scenario:** a Developer agent calls `/fix`, then `/verify-fix?approve=true` on the same ticket. `verify-fix.approve` is medium with default `none`, so the gate executes at once. The ticket is CLOSED on a self-written REVIEW. The audit shows `requiredMode: none`, which hides the self-approval. This is the prior SEC-5, still open, and it contradicts the design's shipped default ("when the caller is also the actor of the ticket's latest `fix`, the mode is `agent`").
- **Fix:** In the verify-fix route, or in a resolver hook keyed on `ticket.transition.verify-fix.approve`, look up the actor of the ticket's last IN_PROGRESS->VERIFY_FIX activity. If it equals the caller, clamp the resolved mode to at least `agent` before `gate()`. Add an allow/deny test.

##### SEC-4 [MEDIUM] The MCP `koda_decide_approval` tool bypasses the approval gate on `approval.decide`
- **Where:** `approvals/mcp/approval-mcp-tools.ts:67-73` against `approvals/approval-requests.controller.ts:108-117`
```ts
// MCP
await this.queries.get(ref, args.id);
const request = await this.decisions.decide(args.id, args.decision, comment, ...);
// REST
await this.decisions.assertMayDecide(id);
const outcome = await this.routeGate.run({ key: 'approval.decide', variant: APPROVAL_ROUTE_VARIANTS.decide, ... });
```
- **Scenario:** an admin sets a policy `approval.decide` -> mode `human` for agents ("agent decisions must be confirmed by a human"). `approval.decide` is medium, so it is approvable. Over REST an agent's decision becomes a pending request. Over MCP the same agent's decision is recorded and executed at once. The same principal gets two different answers on two surfaces, which breaks design principle 1.
- **Fix:** Route the MCP tool through `ApprovalGate.gate('approval.decide', ..., { variant: APPROVAL_ROUTE_VARIANTS.decide })` exactly as the REST handler does, and return `pending:<id>` when it parks.

##### SEC-5 [MEDIUM] `PATCH /tickets/:ref {status}` is gated under `ticket.update`, so an edge-key policy can be bypassed
- **Where:** `tickets/tickets.controller.ts:244-247`; `tickets/tickets.service.ts:276-300`
- **Trace:** The edge permission is checked (`assertTransitionAllowed`), but the approval policy is resolved for `ticket.update` only. Through PATCH, only the `NONE`-comment edges (CREATED/VERIFIED -> IN_PROGRESS) are reachable (`ticket-transitions.ts:15-23`).
- **Scenario:** a project sets `ticket.transition.start` -> `agent` for agents. An agent sends `PATCH {status:"IN_PROGRESS"}` and starts the ticket immediately. The audit records the edge key with `satisfiedBy: none`.
- **Fix:** When `status` is present, open the gate with the edge key from `transitionKeyFor(current, status)`. Use the stricter of the two resolved modes, or gate twice.

##### SEC-6 [MEDIUM] Risk tiers for key and credential writes do not follow design section 1, so agents rotate keys and mint credentials with no approval
- **Where:** `permissions/catalog.ts:136-147` (`HIGH_RISK_PREFIXES`), `:406-414`, `:452`
- **Trace:** The design makes "credential, key, webhook, VCS connection, repo, runner and budget writes: `high`". In code the following end up `medium` and so default to `none` for agents:
  - `agent.key.rotate` and `agent.create`: both return a raw API key.
  - `user.create`: sets a password.
  - `project.update`: rotates `ciWebhookToken`.
  - `invite.create` and `invite.resend`: return a raw token.
  - `user.update`: disables accounts.
- **Scenario:** an agent bound to global Admin (one human-approved binding) rotates another agent's key (`POST /agents/other/rotate-key`). It gets the new raw key in the response, fully impersonates that agent, and the audit shows `satisfiedBy: none`. With `user.update` it can also disable the human Owner, provided another admin stays active. `countActiveAdmins` (`users/prisma-users.repository.ts:52-64`) counts owner and admin together, and `users-admin.service.ts:95-116` has no Owner protection.
- **Fix:**
  - Add `agent.key.`, `agent.create`, `user.create`, `invite.` and `project.ci-token` to the high tier, or add a `CREDENTIAL_KEYS` set.
  - Treat `project.update` carrying `ciWebhookToken` as high, via a separate variant key.
  - Refuse disabling an Owner unless the caller holds `role.binding.owner`.

##### BUG-1 [MEDIUM] Deferred approval execution runs external side effects inside the execution DB transaction
- **Where:** `approvals/approval-execution.service.ts:281-305`; `tickets/state-machine/ticket-transitions.service.ts:735-739` (awaited `createPrForTicket`, documented as "fire-and-forget"), `:192-220` (`autoIndexTicket`, not awaited); `projects/invites/project-invites.service.ts:213` (email send)
```ts
const transaction = () => ... this.txManager.run(async () => {
  const locked = await this.requests.lockById(request.id);
  ...
  await this.requests.lockProjectSlug(locked.projectId, parsed.slug);
  const result = await (prepared ? prepared() : command.execute(parsed, decision));
```
- **Trace:** On the immediate path `gate()` calls `command.execute` with no surrounding transaction, so the transition's own transaction commits before the GitHub calls. On the deferred path, decide/sweeper -> `execute` -> `executeOnce`, and the whole `transitions.verify` call, including `getDefaultBranch` and `createPullRequest` (network), runs while the `ApprovalRequest` row lock and the `Project` row lock are held.
- **Scenarios:**
  1. Slow GitHub calls hold the project lock, which blocks other approved executions for that project.
  2. The PR is created and its `TicketLink` written. If the settle CAS or the commit then fails, the transition and the link roll back but the draft PR exists. `retryStale` (`approval-request-expiry.sweeper.ts:85-103`) re-executes after 5 minutes and opens a second draft PR.
  3. If `createTicketLink` raises P2002 inside the transaction, the inner `catch` swallows it. Postgres has already aborted the transaction, so the settle fails and the request goes `failed` with an error that does not name the real cause.
  
  Invite emails sent from a deferred `invite.create` redeem have the same ordering problem. The `autoIndexTicket` promise is started under the transaction's ALS context and may run after commit. That second-order effect is **unverified**: it depends on how `RagService` resolves its client.
- **Fix:** Move external effects to the `afterCommit` hook the route-command contract already provides (`route-command.ts:29-30`), or to an outbox event. Do not await network I/O inside `executeTransitionInternal`'s callers.

##### BUG-2 [MEDIUM] `DELETE /agents/:slug` is still a hard delete that nulls authorship and assignments
- **Where:** `agents/prisma-agent.repository.ts:84-96`; `agents/agents.service.ts:309-339`; `prisma/schema.prisma:218-220,248` (optional relations, so the default is `SET NULL`)
- **Scenario:** an admin deletes a retired agent. Its comments become authorless, its tickets lose `createdByAgentId`, and its assignments disappear silently. `AuditEntry.actorId` keeps the id, but domain rows no longer show who did what. The API docs still say "soft-delete" (`agents.controller.ts:204`). This is the prior BUG-1, partly fixed: bindings are now removed in the same transaction and the audit keeps the actor.
- **Fix:** Soft delete. Add `deletedAt` (or `status: OFFLINE` plus a random `apiKeyHash`), filter it out of auth and listings, and keep the FKs.

##### ENH-1 [MEDIUM] Workflow comments are mutable and deletable after the transition they justify, with no history
- **Where:** `comments/comments.service.ts:202-246`; `comments/dto/create-comment.dto.ts:24-28`; `permissions/system-roles.ts:70,109,126` (`comment.update.own` and `comment.delete.own` for Developer, Reviewer, Verifier, Triager and Viewer)
- **Scenario:**
  1. An agent writes the FIX_REPORT that a reviewer approves.
  2. Afterwards the agent edits the report or hard-deletes it. The audit says only `edited`/`deleted`; the previous body is gone.
  3. Any Viewer can still post `REVIEW`/`VERIFICATION`/`FIX_REPORT`-typed comments outside a transition (prior SEC-8). Those are indexed into RAG as workflow records.
- **Fix:**
  - Accept only `GENERAL` on the comment route; workflow types come only from transitions.
  - Make non-GENERAL comments immutable, or store revisions.
  - Make delete a soft delete.

#### LOW

| ID | Where | Defect -> failure | Fix |
|---|---|---|---|
| SEC-7 | `main.ts:27-30` | Prior SEC-1 unchanged: every RFC1918 peer is a trusted proxy, so vendor client-IP headers (`x-client-ip`, `cf-connecting-ip`, ...) are taken unfiltered. A LAN or sidecar caller rotates the header and escapes the 5/min login and invite-accept throttle. | Trust only the configured proxy address(es). |
| SEC-8 | `auth/auth.service.ts:145-159` | Prior SEC-7: refresh tokens are not one-time; a stolen refresh token mints sessions for 7 days. | jti/family rotation with reuse detection. |
| SEC-9 | `config/env.validation.ts:12-16` | Prior SEC-10: no minimum length on `JWT_SECRET`, `JWT_REFRESH_SECRET`, `API_KEY_SECRET` (the HMAC key for every agent and runner key). | `.min(32)`. |
| SEC-10 | `common/utils/encryption.util.ts:57-60` | Prior SEC-11: GCM `setAuthTag` without `authTagLength`, so truncated tags are accepted. | `createDecipheriv(..., { authTagLength: 16 })`. |
| SEC-11 | `agents/agents.controller.ts:147-165`; `agents.service.ts:367-436` | `GET /agents/:slug/pickup` writes an AgentEvent, an outbox row and an AuditEntry (unsafe GET). `agent.pickup` is approvable (medium), but the route is ungated, and the contract only checks non-GET writes, so a pickup policy is silently ignored. The AgentEvent still records `actorId: agentId` when an admin calls (`agents.service.ts:61-68`). | Make it POST plus `@ApprovalGated`, or mark `agent.pickup` non-approvable; pass the real actor. |
| BUG-3 | `auth/guards/combined-auth.guard.ts:55-58` | Prior BUG-7: an API-key DB error is swallowed and falls through to JWT, so during a DB outage every agent gets 401 (looks like revoked credentials). | Re-throw non-lookup errors as 503. |
| BUG-4 | `ticket-links/ticket-links.service.ts:99-121`; `projects/projects.service.ts:47-69` | Prior BUG-6 residual (labels fixed): check-then-insert on `TicketLink(ticketId,url)` and `Project.slug/key` with no P2002 mapping, so concurrent requests get 500. | Catch `isUniqueViolation` -> 200/409. |
| PERF-1 | `tickets/state-machine/ticket-transitions.service.ts:737-739` | Prior PERF-1: `createPrForTicket` (two GitHub calls plus link extraction) is awaited on the `/verify` request path. See BUG-1 for the deferred case. | `afterCommit` or outbox job. |
| MEM-1 | `webhook-security/webhook-replay.guard.ts` | Prior MEM-1: `WebhookDelivery` rows are never purged (only `forget` deletes one). Grows without bound. | Retention processor. |
| ENH-2 | `main.ts` (no `enableShutdownHooks`; `AppFactory.start` does not call it, `nestjs-app/dist/app/nathapp.js:185-197`) | Prior ENH-2: `onModuleDestroy` timers (expiry sweeper, email dispatcher) never run on SIGTERM. In-flight approval executions are cut mid-transaction (recoverable through `retryStale`). | `app.enableShutdownHooks()` before `start`. |

Lower-value notes (not separately scored):
- The `AgentAuthProvider` principal cache invalidates by tag, which is a no-op under MEMORY, so capability changes are stale up to 60 s (`agent-auth.provider.ts:15-39`). Status and roles are not affected.
- `agents.controller.ts:33` class-level `@Throttle(10/min)` still covers reads (prior PERF-2).
- No `@MaxLength` on ticket title/description or comment body; `linkType` is a free string (prior ENH-3).
- `raw-body.hook.ts:30-60` double-buffers every JSON body (prior MEM-2).
- `writeTicketEvent`/`writeDecisionEvent` have no callers. `agents.service.ts:26` duplicates `UpdateCapabilitiesDto`. `update`/`updateById` in `agents.service.ts:260-293` are copy-paste (prior STYLE-1).
- `ticket-transitions.service.ts` (749 lines), `role-admin.service.ts` (522), `membership.service.ts` (500) and `policy-gate.service.ts` (597, CI-only, prior STYLE-2) exceed the 400-line guideline.
- `role-bindings.controller.ts:124-125` returns 404 before the key check (existence oracle on cuid ids; negligible).
- `ApprovalGate.openRequest` is check-then-insert with no unique index, so duplicate pending requests can race (documented at `approval-gate.service.ts:115-120`).
- `ApprovalExecutionService.serialised` is per-process only. Across instances the row lock plus status re-check protect the DB write, but `prepare()` side effects could run twice.

---

### 3. Prior-finding status (docs/20261018-review-whole-repo.md, Review A)

| ID | Status @61052931 | Evidence |
|---|---|---|
| SEC-1 proxy-header spoofing | OPEN | `main.ts:27-30` unchanged. |
| SEC-2 project route mutates global agent / self-unpause | PARTIAL | Project-admin path now needs the global `agent.update` plus the gate (`projects.controller.ts:266-280`). The self path is still unrestricted: new SEC-2 (HIGH). |
| SEC-3 role-less agents delete tickets/labels | FIXED (superseded by redesign) | `ticket.delete` and `label.delete` are held only by `project-admin` (`*`) (`system-roles.ts`). `ticket.delete` is high, so agents default to `agent` mode (`catalog.ts:452`). |
| SEC-4 ticket links: any member, no audit | FIXED | `@Requires('ticket.link.add')`, `ticket.link.remove` with a row-level `.own` check (`ticket-links.service.ts:170-176`), audited (`:107-121,179-188`). Residual: free-form `linkType` (LOW note). |
| BUG-1 agent hard delete nulls authorship | PARTIAL | Bindings removed in the same transaction, AuditEntry keeps the actor (`agents.service.ts:309-339`). Still `agent.delete` + SET NULL: BUG-2. |
| BUG-2 PATCH fields+status non-atomic | FIXED | Edge pre-check, then fields applied inside the transition transaction (`tickets.service.ts:276-300`). New SEC-5 (gate key). |
| BUG-3 VERIFIER pickup 403 / misattribution | PARTIAL | Role gate replaced by a project-access check (`koda-domain-writer.service.ts:58-61`), so the VERIFIER 403 is fixed. Still a GET with side effects, and the AgentEvent `actorId` is still the agent (`agents.service.ts:65`): SEC-11. |
| BUG-4 CI tickets bypass the pipeline | PARTIAL (owned by the ci-webhook reviewer) | Now `@SystemWriter('system.ci.ticket-create')` plus `runAsSystemWriter` plus audit (`ci-webhook.service.ts:12,41,106`). TicketEvent/outbox not re-verified here. |
| ENH-1 no approvalMode/approver; unaudited writes | FIXED (superseded) | `AuditEntry` with actor, onBehalfOf, requiredMode, satisfiedBy, approver and requestId (`schema.prisma:858-887`), written in-tx by `AuditRecorder` (`audit-recorder.service.ts:44-72`). Context-less write guard (`contextless-write.ts`), audit-coverage scope per route, outbox envelope carries `approval` (`events/outbox-envelope.util.ts:19-21`). Residual: ENH-1 (comment history). |
| SEC-5 no separation of duties on verify-fix | OPEN | Design rule not implemented: SEC-3. |
| BUG-5 replaceRoles/Capabilities non-atomic | FIXED | `AgentRoleEntry` dropped; capabilities replaced inside `audit.audited` (one tx) (`agents.service.ts:295-300`). |
| SEC-6 agent principal cache stale roles | FIXED (superseded) | Roles moved to `PermissionCache` with a generation counter (`permission-cache.ts`), invalidated after commit. Capabilities-only residual (LOW note). |
| SEC-7 refresh not rotated | OPEN | `auth.service.ts:145-159`: SEC-8. |
| SEC-8 any member posts workflow-typed comments | OPEN | `create-comment.dto.ts:24-28`: folded into ENH-1. |
| SEC-9 `GET /agents` lists everything | SUPERSEDED (by design) | `agent.read` is in the seeded Member and Agent baselines (design "agent directory"). |
| SEC-10 secret min length | OPEN | `env.validation.ts:12-16`: SEC-9. |
| SEC-11 GCM tag length | OPEN | `encryption.util.ts:57-60`: SEC-10. |
| BUG-6 P2002 races | PARTIAL | Labels mapped (`labels/prisma-label.repository.ts`); links and projects not: BUG-4. |
| BUG-7 API-key DB error -> 401 | OPEN | `combined-auth.guard.ts:55-58`: BUG-3. |
| PERF-1 PR creation on request path | OPEN (worse in deferred path) | `ticket-transitions.service.ts:737-739`: PERF-1, BUG-1. |
| PERF-2 class-level agents throttle | OPEN | `agents.controller.ts:33`. |
| MEM-1 WebhookDelivery never purged | OPEN | Only `forget` deletes (`webhook-replay.guard.ts:105`). |
| MEM-2 double-buffered JSON bodies | OPEN | `common/hooks/raw-body.hook.ts:30-60`. |
| ENH-2 no shutdown hooks | OPEN | No `enableShutdownHooks` in `src`. |
| ENH-3 free `linkType` / no MaxLength | OPEN | `create-ticket-link.dto.ts:9-12`; no `MaxLength` in ticket/comment DTOs. |
| STYLE-1 dead KodaDomainWriter paths / dup DTOs | PARTIAL | `indexDocument`/`importGraphify` now used; `writeTicketEvent`/`writeDecisionEvent` have 0 callers; `UpdateCapabilitiesDto` duplicated (`agents.service.ts:26`). |
| STYLE-2 PolicyGateService CI-only, 597 lines | OPEN (by design) | Only `scripts/policy-gates-runner.ts`. |

Approval-engine race checklist (asked for explicitly):
- **Double approve:** safe. `lockById` plus a `pending` check plus CAS `transition(id,'pending',...)` (`approval-decision.service.ts:87-120`).
- **Approve after expiry:** refused under lock (`:90`). The sweeper's `settleOne` re-checks under lock (`approval-request-expiry.sweeper.ts:140-145`).
- **Approve own request:** allowed only as `self` for an agent actor; refused when `requireDistinctApprover`. A human acting directly satisfies every mode, per design decision 8 (`approval-eligibility.ts:51-57,96-120`).
- **Double execute:** in-process serialisation plus `approved` re-read under lock plus CAS settle (`approval-execution.service.ts:237-316`).
- **Redeem replay:** same owner, same key/variant/project, input-hash match, status `approved`, unexpired, settled once (`:116-141`).
- **Gaps:** SEC-1 and SEC-2 (paths around the gate), SEC-4 (MCP decide), SEC-5 (PATCH key).

Route coverage: every controller route in this area declares `@Requires`, and every guard-enforced `@Requires` has `RequiresGuard` in its `@UseGuards` (static tally of 22 controllers). `enforcedBy: 'service'` routes were each traced to a service check: roles, role-bindings, comments, ticket-links remove, pickup, project list, live SSE, approvals list/get/decide. The one exception is the self branch in SEC-2.

---

### 4. Rulings needed

1. **May an agent hold `project-admin` (or any role with `member.add`/`invite.create`)?** If yes, SEC-1 must be fixed by gating. If no, add `principals: ['user']` to those keys or refuse binding such roles to agents.
2. **Should a project policy be allowed to be *weaker* than a global policy for the same key and subject?** The resolver ranks every project policy above every global one (`approval-policy.resolver.ts:44-53`), so a Project Admin can relax a global admin's stricter rule down to the floor. Option: treat global policies as a per-key floor for project policies.
3. **Owner protection from Admins:** may a global Admin disable the Owner user (`user.update`)? Today yes, if another admin stays active (SEC-6).
4. **PAUSED semantics:** PAUSED agents authenticate and may read and run ungated routes, but every gated write gets 401 (`actor-principal.loader.ts:45`). Decide whether PAUSED should block at the guard.
5. **Retention for `AuditEntry`, `ApprovalRequest`/`ApprovalDecision` and `WebhookDelivery`:** none exists. Decide whether audit is kept forever.
6. **Single-instance assumption:** `PermissionCache` generation and `ApprovalExecutionService.serialised` are per process. Confirm the API is single-replica, or plan Redis invalidation.
7. **Design decision 2 ("no data migration"):** migrations `20261102090100` and `20261105090100`/`20261107090100` drop `ProjectMember`, `AgentProject`, `AgentRoleEntry`, `PendingAction` and `FleetApproval` without copying data. These were ruled acceptable while there was no production use, but koda-wk is now deployed live. Confirm nothing further relies on that ruling.

---

### 5. Rubric scores (0-20)

| Dimension | Score | Rationale |
|---|---|---|
| Security | 14 | Strong core: one catalog, fail-closed guard, escalation checks, owner lock, race-safe approvals, redacted secret inputs, in-tx audit. Deductions: agent -> human-tier laundering through invite/member.add (HIGH), self-unpause bypass (HIGH), missing self-fix rule, MCP decide policy bypass, risk tiers below design for credential writes, old proxy-trust and refresh issues. |
| Reliability | 15 | Transactional audit and outbox, CAS everywhere, stale-approved retry, after-commit cache invalidation. Deductions: external I/O inside the approval transaction (duplicate PRs on retry), hard agent delete, unmapped P2002, no shutdown hooks, swallowed API-key DB errors. |
| API Design | 15 | Consistent `@Requires` + `@ApprovalGated` + 202 pending contract; redeem flow for secrets is well designed. Deductions: GET with side effects, PATCH gated under the wrong key, two decide surfaces that disagree, project route still able to edit a global agent row. |
| Code Quality | 15 | Thorough rationale comments, small pure helpers (eligibility, validation, resolver). Deductions: several 500-750 line files, duplicated `update`/`updateById`, dead writer methods, heavy `as unknown as` casts in transitions. |
| Best Practices | 15 | Context-less write guard and audit-coverage scope are excellent agent-first enforcement. Deductions: design rules not carried into code (self-fix mode, credential tiering, binding floor via member/invite), refresh rotation, secret length, no retention. |
| **Total** | **74/100** | |

---

## Review B: fleet control plane + koda MCP endpoint (koda main @ 61052931, v0.4.2)

Scope: `apps/api/src/fleet/{assistant (incl. mcp/), threads, jobs, approvals, sync, git-broker, runners, ingest, artifacts, logs, common, repos, repo-config}`, `fleet.module.ts`, `config/mcp.config.ts`, `memory/mcp/`. Read-only static review, no tests run. Checklists: universal.md, nestjs-app.md.

### 1. Summary

The control plane is in good shape after the P3 permission redesign and S6 K1-K3. Runner/user/agent route separation still fails closed in both directions (`@RunnerRoute` + `RequiresGuard` with `runner.*` keys on every runner controller). Every runner write I traced (reports, acks, token requests, tool relay, bundle/log upload, config-edit fetch) is fenced on `(runnerId, leaseEpoch)`, and the write paths take the job row lock. Thread routes now use ownable `thread.*.own` keys, which closes the prior demoted-creator hole. MCP lists tools with `can()` and re-checks keys per project in the executor. The PR-fix loop is bounded: a FIX queues at most one follow-up REVIEW, a REVIEW never queues a FIX, auto-fix does not exist, `FIX` is in `BUDGET_STOP_COMMANDS`, and the follow-up re-checks the requester's dispatch rights. The approval relay keeps nax's options and closes asks when the job ends.

No CRITICAL or HIGH findings. What is left is git token scope (REVIEW/FIX get a full `contents: write` repo token, and the prior PROJECT-thread anchor write mint is still open), four LOW/MEDIUM prior findings with no change (ingest decompression limits, runner-chosen enrollment labels, sweeper/sync isolation, runner revocation), and some LOW consistency gaps on the SSE routes.

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 4 |
| LOW | 6 |

### 2. Findings

#### MEDIUM

##### SEC-1 [MEDIUM] REVIEW and FIX jobs get an unrestricted `contents: write` repo token while an LLM reads untrusted PR text
- `apps/api/src/fleet/sync/sync.service.ts:134-136` (the non-THREAD branch always mints a write token)
- `apps/api/src/fleet/git-broker/github-app-client.ts:70-71` (`contents: 'write', pull_requests: 'write', ...`)

```ts
} else {
  const repo = await this.repo.findRepo(job.repoId);
  if (repo) granted.push({ jobId: job.id, leaseEpoch: job.leaseEpoch, repo });   // write mint, any command
}
```
A REVIEW job only needs to read the code and post review comments (`pull_requests: write`, `contents: read`). A FIX job needs to push only to the PR head branch. Both get the same token as RUN: write access to every branch of the repo, with no branch restriction. The token sits in `<jobDir>/forge-token` and in nax's memory while an LLM reads PR bodies, diffs and review-thread replies. K1-B auto-review dispatches REVIEW unattended for every non-draft same-repo PR (`reviews/review-head-dispatcher.ts:146-150`). Manual dispatch (`fleet-jobs.service.ts:82`, MCP `koda_dispatch_job`) does not refuse fork PRs, so for those, refusing untrusted input is left to nax. K3 states this as a fact (design line 75) but never decides it.
Scenario: a contributor with push rights, or a PR comment from an outsider on a same-repo PR, contains prompt-injected instructions. If the review agent can run git or shell, it can push to `main` (when it is unprotected) or delete branches with the brokered token. The only remaining control is the repo's branch protection.
Fix: add a `review` mint profile, `{ contents: 'read', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read' }`, and use it for `command === 'REVIEW'`. For FIX, keep write but write down that the deploy needs branch protection on the default branch, or add a server-side check of the pushed ref. Needs a ruling (section 4).

##### SEC-2 [MEDIUM] A PROJECT-thread job can still mint a write token for the anchor repo (prior B SEC-3, OPEN)
- `apps/api/src/fleet/sync/sync.service.ts:132-136`

```ts
} else if (job.command === 'THREAD' && (await this.repo.findThreadTokenScope(job.id))?.kind === 'WORKSPACE') {
  gitTokenErrors.push({ jobId: job.id, reason: 'repo_not_assigned' });
} else {
  const repo = await this.repo.findRepo(job.repoId);           // PROJECT thread: anchor repo, write
```
No change since 44269581. A PROJECT thread job stores the anchor repo (`threads/prisma-chat-thread.repository.ts:539-549`) and the honest runner never asks for it. A token request without `repoId` still gets `contents: write` on the anchor repo. Ruling 5 makes the runner one trust domain, but this is the server minting a credential no PROJECT path uses. It is least privilege, not runner isolation.
Fix: `const scope = ...; if (scope?.kind === 'WORKSPACE' || scope?.kind === 'PROJECT') refuse`. Add the test "PROJECT refuses the anchor token without repoId" to `sync-token-fence.spec.ts`.

##### MEM-1 [MEDIUM] Bundle ingest decompression bomb: no file-count or total-bytes cap (prior B MEM-1, OPEN, now wider)
- `apps/api/src/fleet/ingest/bundle-reader.ts:85-98`, `apps/api/src/fleet/ingest/domain/bundle-ingest.domain.ts:17-26`

```ts
if ((header.size ?? 0) > INGEST_LIMITS.fileBytes) { ... }       // 32 MiB per file only
...
else acc[slot] = [...acc[slot], file];                            // unbounded, O(n^2) copy
```
No change. K2 added two more slots, `botReview` (an array, so also unbounded) and `naxStdout` (up to 32 MiB held as a string). Thousands of 32 MiB allowlisted entries that compress well fit in one upload under the compressed-size cap. The reader buffers all of them before `parseBundle` runs, so the single API instance runs out of memory, and then retries the same claim after restart until `INGEST_MAX_ATTEMPTS`.
Fix: add `INGEST_LIMITS.totalBytes` (for example 64 MiB) and `maxFilesPerSlot`. Count decompressed bytes in `readEntry`, then `resume()` and mark the bundle `oversized`/partial past the cap. Use `push` on a local array.

##### BUG-1 [MEDIUM] Sweeper and sync still do not isolate per-item failures (prior B BUG-2, OPEN)
- `apps/api/src/fleet/sync/fleet-sweeper.ts:59-75` (no try/catch around each job's transaction)
- `apps/api/src/fleet/sync/sync.service.ts:89-91` (`fillRunner`, `fillRunnerThreads`, `afterTerminal` not wrapped)

```ts
if (req.freeSlots > 0) await this.placement.fillRunner(runnerId, req.freeSlots, now);
if (req.protocolVersion >= 4) await this.placement.fillRunnerThreads(runnerId, now);
await this.afterTerminal(...);
const tokens = await this.grantTokens(...);      // never reached if placement throws
```
If one job throws deterministically in the sweep (for example a transition hook that fails), every later silent job is never crashed, on every tick. If placement throws, the runner gets a 500 after the reports have committed. It then gets no CANCEL, ABANDON or APPROVAL_ANSWER commands and no git tokens, so a FIX or RUN that is waiting for its forge token stalls. This breaks the project rule "One failing job or ack in a sync is logged and skipped".
Fix: wrap each sweep iteration in try/catch with `logger.warn` (as `ApprovalExpirySweeper` does). Wrap the two placement calls in try/catch and log `error.name`.

#### LOW

##### SEC-3 [LOW] Runner-chosen labels are merged into the admin's enrollment labels (prior B SEC-4, OPEN)
- `apps/api/src/fleet/runners/enrollment.service.ts:64`, `apps/api/src/fleet/runners/dto/enroll.dto.ts:13`

```ts
labels: uniqueSorted([...enrollment.labels, ...body.labels]),
```
Whoever holds an enrollment token can give itself any selector label. Labels decide which jobs, and so which repos' write tokens, a runner receives. The merged list can hold 40 labels against the DTO's `ArrayMaxSize(20)`.
Fix: store only `enrollment.labels`. Admins edit labels through `PATCH /fleet/runners/:id`.

##### SEC-4 [LOW] A runner cannot be revoked while it holds jobs, and a disabled runner still gets tokens (prior B SEC-5, OPEN)
- `apps/api/src/auth/guards/combined-auth.guard.ts:110-119` (no `enabled`/`revoked` check), `apps/api/src/fleet/runners/runners.service.ts:68-77` (delete refused while jobs are unfinished), `sync/sync.service.ts:109-148` (no `enabled` check)

Fix: add a `revokedAt` column. Make `authenticateRunner` refuse revoked runners. Let `DELETE` (or a new `revoke` action) crash held jobs through `JobTransitionsService` with `bumpEpoch` and evict their broker tokens.

##### BUG-2 [LOW] The project thread SSE guard says agents pass, but it requires a JWT, so agents always get 403
- `apps/api/src/fleet/threads/thread-events.controller.ts:41-44, 56-57`

```ts
// ... no principal-type refusal is left on this route — the key decides, so an agent passes this guard.
const jwtPayload = decodeJwtPayload(kodaTokenExtractor(req));
if (!jwtPayload) throw new ForbiddenAppException({}, 'live');
```
An agent with `thread.read` passes the key check and then gets `403 live`. The comment and the P1 US-002 intent ("the key decides") do not match the behaviour. This is fail-closed, so it is not a leak.
Fix: either support API-key principals (expiry = none, re-check the key in `stillAllowed`), or change the comment and the OpenAPI note to "users only".

##### SEC-5 [LOW] The project thread SSE `stillAllowed` re-checks membership but not `thread.read`
- `apps/api/src/fleet/threads/thread-events.controller.ts:96-104`

A principal moved to a custom project role without `thread.read` keeps an open stream until the token expires. The guard checks `thread.read` only at connect time.
Fix: in `stillAllowed`, also run `permissions.can(fresh, 'thread.read', { projectId })`.

##### BUG-3 [LOW] Tool relay fence is checked without the job row lock
- `apps/api/src/fleet/assistant/runner-tool.service.ts:47-56`

`findById` and `fence.holds` run outside a transaction, then `executor.execute` runs the write. A cancel, requeue or crash that commits in between still lets a write from the old lease land (ticket, comment, dispatch) under the requester's authority. The window is short and the runner is trusted (ruling 5), so this is LOW.
Fix: re-check `fence.holds` and `state === 'RUNNING'` inside the gate transaction for write tools, or accept it and add a note.

##### PERF-1 [LOW] GitTokenBroker and RunnerNotifier copy whole maps on every operation (prior B PERF-1, OPEN, accepted pattern)
- `apps/api/src/fleet/git-broker/git-token.broker.ts:43,56`, `apps/api/src/fleet/jobs/runner-notifier.ts:41,46`

No change. Fine at the current fleet size.

#### Verified OK (traced, no finding)
- Route isolation: `runner-api.controller.ts:16-26` (enroll is `@Public`, throttled 10/min, `ke_` prefix, single-use CAS, rollback on 409). Runner job routes (`runner-tool`, `bundle-upload`, `log-upload`, `runner-config-edit`) are all `@RunnerRoute` plus `runner.*` keys.
- Fencing: `job-report.processor.ts:76-81`, `sync.service.ts:117-121` under `lockById`, `fleet-shell-escalate.command.ts:73-77` re-checks state, epoch and runner under the lock before answering nax.
- Thread authz: `thread-route.commands.ts` plus the ownable `thread.*.own` keys (`permissions/system-roles.ts:86-87`). `canOperate` is true only for any-row holders, and the repository checks `createdById` under the row lock (`prisma-chat-thread.repository.ts:181,200,265,322,361`). Plan and run also need `fleet.job.dispatch`.
- Executor: membership and key check per project for thread, workspace and MCP callers (`assistant-tool.executor.ts:170-228`). The only no-key tool is `koda_my_projects`, which is principal-scoped (`tools/workspace-tools.ts:53`). Tool output is masked and fenced. Assistant default approval mode is `human` (`approvals/approval-policy.resolver.ts:19,56`).
- MCP: agent-only, `MCP_ENABLED` gate, `mcp.access` key, per-request visible tool set (`mcp-server.factory.ts:49-82`), throttle 120/min. The executor validates arguments (B1).
- PR fix: GitHub-only check at dispatch (`fleet-jobs.service.ts:82`). `review-pr-<n>` is shared with REVIEW, so the active-feature index blocks a REVIEW and a FIX of one PR running at once. Placement needs `botReview` and `botFix` (`placement-rules.ts:94-95`). The follow-up is outbox-driven, at most once per `(job, epoch)` (`job-outcome.recorder.ts:31-38`), claims the head before dispatch, and re-checks the requester's dispatch rights (`reviews/fix-follow-up.subscriber.ts:74-97`). Requeue resets `fixOutcome` and `resultSha` (`fleet-jobs.service.ts:303-305`).
- Logs and artifacts: `fleet.job.logs.read` and `fleet.job.bundle.read` behind `ProjectMembershipGuard`. The runner bundle never includes `forge-token` (`apps/runner/src/bundle/build-bundle.ts:41-44`).
- Approval relay: `openBash` dedups on `(job, epoch, naxAskId)`, the deadline is capped by nax's, and a `not-needed` ask answers `allow` only when `checkBashDecision` accepts it (`approval-closer.ts:228-266`).

### 3. Prior-finding status (docs/20261018-review-whole-repo.md, Review B)

| Prior ID | Title | Status | Evidence |
|---|---|---|---|
| SEC-1 | MCP read tools reach agents that REST refused (R10) | SUPERSEDED | R10 retired by P1d: `logs/fleet-job-logs.controller.ts:16-21,33` and `jobs/fleet-jobs.controller.ts:100` use `@Requires` keys. MCP lists by `can()` (`mcp-server.factory.ts:49-82`) and the executor checks the key (`assistant-tool.executor.ts:219`). REST and MCP now apply the same key. |
| SEC-2 | Demoted thread creator keeps write control | FIXED | Route keys `threads.controller.ts:93-245`. Ownable `thread.*.own` only for developer (`permissions/system-roles.ts:86-87`), VIEWER has none. Plan and run also need `fleet.job.dispatch` (`thread-route.commands.ts:100,118`). |
| SEC-3 | PROJECT-thread job mints an anchor write token | OPEN | `sync/sync.service.ts:132-136` unchanged. This review's SEC-2. |
| MEM-1 | Bundle ingest unbounded files/total bytes | OPEN | `ingest/bundle-reader.ts:85-98`. K2 added `botReview`/`naxStdout` slots. This review's MEM-1. |
| BUG-1 | Approved assistant action stuck APPROVED | SUPERSEDED | Assistant actions moved onto the P3 approval engine. `approvals/approval-request-expiry.sweeper.ts:15,89` sweeps stale `approved` rows after 5 min, and `approval-execution.service.ts:238-242,285` re-checks status under the lock. |
| SEC-4 | Runner adds its own labels at enrollment | OPEN | `runners/enrollment.service.ts:64`. This review's SEC-3. |
| BUG-2 | Sweeper/sync lack per-item isolation | OPEN | `sync/fleet-sweeper.ts:59-75`, `sync/sync.service.ts:89-91`. This review's BUG-1 (raised to MEDIUM because FIX/REVIEW jobs now depend on token delivery in the same sync). |
| SEC-5 | Disabled runner keeps tokens, cannot be revoked while busy | OPEN | `auth/guards/combined-auth.guard.ts:110-119`, `runners/runners.service.ts:68-77`. This review's SEC-4. |
| ENH-1 | Approved writes not linked to their approval in audit | PARTIAL | `AuditRecorder` now stamps `context.approval` on every row (`audit/audit-recorder.service.ts:58`), and the gate runs execution inside the approval context. `FleetActivity`/`TicketActivity` payloads and `ToolContext` (`assistant-tool.executor.ts:233-242`) still carry no request id. |
| PERF-1 | Broker/notifier whole-map copies | OPEN (accepted) | `git-broker/git-token.broker.ts:43,56`, `jobs/runner-notifier.ts:41,46`. |

### 4. Rulings needed

1. Token scope per job kind (SEC-1). Should REVIEW jobs get a review-only token (`contents: read`, `pull_requests: write`)? For FIX, is "branch protection on the default branch is a deployment prerequisite" an acceptable control, or should koda restrict the push target? K3 lists the full-write token only as a fact (design line 75), not as a decision.
2. PROJECT anchor token (SEC-2). Confirm it should be refused, or record that ruling 5 covers it and close it.
3. Follow-up REVIEW budget. The follow-up REVIEW gets the FIX's full `maxCostUsd` (`reviews/fix-follow-up.subscriber.ts:109`), so one FIX dispatch can spend up to 2x its cap. This matches K3 D4. Confirm that is intended, or pass the remaining budget instead.
4. Thread SSE for agents (BUG-2): users only, or key-driven as the comment says?

### 5. Rubric (0-20)

| Dimension | Score | Notes |
|---|---|---|
| Security | 16 | Fencing, route isolation and ownable keys are solid. Deductions: over-scoped REVIEW/FIX token, PROJECT anchor write mint still open, runner revocation/labels. |
| Reliability | 15 | Good per-report and per-ack isolation, outbox-driven follow-up with idempotent claim. Sweeper/sync placement isolation and ingest memory bound still open. |
| API Design | 17 | Consistent `@Requires` / route-command pattern across REST, MCP and approval replay. SSE agent behaviour does not match its own comment. |
| Code Quality | 17 | Small, cohesive files with design references. `prisma-chat-thread.repository.ts` (640 lines) and `koda-tool-descriptors.ts` (727) are the largest. Lock/re-read blocks are repeated across thread write methods. |
| Best Practices | 17 | Immutability, no transaction across HTTP or long-poll, secrets never logged, agent-first audit via action context. Activity rows still lack the approval link. |
| Total | 82/100 | |

---

## Review C: fleet ops, review memory, VCS/webhooks, RAG/memory/code-intel (koda main @ 61052931, v0.4.2)

Scope: `apps/api/src/fleet/{reviews,tickets,knowledge,analytics,dashboard,budgets,schedules,activity}` and `apps/api/src/{vcs,rag,memory,code-intel,entity-graph,retrieval,context,skills,webhook,ci-webhook}`. Static, read-only. No tests run. Every finding was traced through guards, decorators, callers and transactions.

### 1. Summary

The permission/approval redesign closed most of the prior C integrity findings. KB writes are now scoped to `(source, source_id)` and checked against row ownership. Memory writes now need a catalog key and a supersede check that runs inside the transaction (VIEWER can no longer write). `/memory/extract` validates `ticketId`. The retrieval harness is admin-only. Every entry point is held to audit coverage, and `AuditEntry` carries `requiredMode`, `satisfiedBy` and the approver. The new K1-K3 code is careful work. Auto-review claims each head once through a unique index. Dispatch is capped per pass, revalidates the enabler, and skips soft-deleted projects, forks and drafts. K3 has no auto-fix, so review and fix cannot loop. Untrusted PRs never mint memory. Webhook signatures are timing-safe, and outbound webhooks are DNS-pinned and refuse redirects.

The remaining risk is mainly the boundary between caller-written content and agent-facing reads:
- The fleet knowledge store still reads and deletes by `source_id` alone, so a KB writer can inject text into `koda_get_doc` (SEC-1).
- A review-minted decision names as approver any repo writer listed in an unverified `disagreedBy`. Nobody checks that this person took part in the thread (SEC-2).
- K2 now grows the active-DECISION set automatically, and `/context` still returns all of it with no limit (PERF-1).

Five prior MEDIUM reliability findings remain open:
- BUG-1: soft-deleted projects keep running background work.
- BUG-2: placement starvation.
- BUG-3: the issue import race.
- BUG-4: the entity-graph `assigned` key mismatch.
- BUG-5: the LanceDB optimize race.

| Severity | New | Prior still OPEN/PARTIAL |
|:--|:--|:--|
| CRITICAL | 0 | 0 |
| HIGH | 0 | 0 |
| MEDIUM | 3 | 6 (BUG-1..6, BUG-6 partial) |
| LOW | 5 | 11 |

### 2. Findings

#### MEDIUM

##### SEC-1 [MEDIUM] A KB writer can inject content into `koda_get_doc` repository and outcome reads, and the knowledge indexer deletes their rows without ownership checks
Where:
- `fleet/knowledge/knowledge-chunk-store.ts:64-67` (`parseRow`), `:82` (`replaceFile`), `:90` (`deleteFile`), `:97` (`readFile`)
- `fleet/knowledge/knowledge-search.service.ts:245-261` (`readDoc`, `readOutcome`)
- `fleet/assistant/tools/kb-tools.ts:353,394` (the callers)
- `rag/dto/add-document.dto.ts:22-35` (`sourceId` is `MinLength(1)` only; `metadata` is any object)
- `rag/vector-store.service.ts:237` (caller metadata is spread into the stored row)

```ts
// knowledge-chunk-store.ts:97
const records = await table.query().where(`source_id = '${sourceId}'`).limit(MAX_FILE_ROWS).toArray();
// :64  the chunk text comes from row metadata
return { ...metadata, id: record.id, sourceId: record.source_id, provider: record.provider };
```

The prior SEC-1 fix scoped the KB write path to `source AND source_id`. The other direction was not fixed. The repository-knowledge store shares the `project_<id>` table, and it reads and deletes by `source_id` alone. The text it returns is `metadata.text`, which the caller controls on a `doc` row.

Failure scenario:
1. A rostered agent or DEVELOPER holds `kb.document.add`. It takes `repoId` and `path` from a `/knowledge/search` hit.
2. It posts `POST /projects/x/kb/documents` with:
   - `source: 'doc'`
   - `sourceId: 'repo:<repoId>:docs/SECURITY.md'`
   - `metadata: { text: '<instructions>', chunkIndex: 0, path: 'docs/SECURITY.md', repoId, ... }`
3. The ownership check passes, because no `doc` row exists for that id.
4. Every later `koda_get_doc` of that file returns the injected chunk, interleaved with the real ones and presented as repository content.
5. The same works for `outcome:<repoId>:<jobId>:summary`, which `readOutcome` serves.
6. In the other direction, the next index pass that touches the file runs `deleteFile`/`replaceFile`, which silently deletes any user `doc` row with that id. That deletion skips `kb.document.delete` ownership and is not audited.

Search is not affected, because both search legs filter on `source = 'repo'|'outcome'`.

Fix:
- Add the source to all three store filters, using the existing helper:

```ts
await table.delete(sourceRowFilter(REPO_SOURCE, sourceId));            // or OUTCOME_SOURCE, by prefix
const records = await table.query().where(sourceRowFilter(sourceOf(sourceId), sourceId)).limit(MAX_FILE_ROWS).toArray();
```

- Also reject reserved prefixes (`repo:`, `outcome:`) in `AddDocumentDto.sourceId` with a 400.

##### SEC-2 [MEDIUM] A review-minted DECISION credits as approver any repo writer named in `disagreedBy`; nothing checks that this login replied in the thread
Where:
- `fleet/reviews/review-event.minter.ts:47,66-84`
- `fleet/ingest/parsers/bot-review.parser.ts:28-30` (logins are only format-checked)
- `memory/review-decision.writer.ts:59-63`

```ts
for (const login of logins) {
  const role = await this.github.getRepoRole(token, repo.owner, repo.name, login);
  if (role === 'admin' || role === 'maintain' || role === 'write') { approver = login; break; }
}
... runWithApproval({ requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: `github:${approver}` }, ...)
```

How it works today:
- `disagreedBy` comes from `bot-review.json`, an artifact the runner uploads from the job workspace.
- The K2 spec (line 57) says these logins are "unverified forge logins; consumers must check artifact trust and commenter permissions".
- The minter checks the role of each login. It never checks that the login wrote a comment in `threadId`.
- On a trusted PR, nax runs the PR's code in that workspace. Any compromise of the runner or the job (a hostile PR author who is a writer, a prompt-injected agent with shell) can therefore write the artifact.

Failure scenario:
1. A writer's PR (or a compromised job) emits `finding-withdrawn` for a real security finding, with `disagreedBy: ['lead-maintainer']`.
2. The minter confirms that `lead-maintainer` has `admin` and mints an active DECISION, "Not a defect: ...".
3. The audit records `satisfiedBy: human`, `approverId: github:lead-maintainer`, but that person never took part.
4. Every later REVIEW of the repo receives the decision (`review-decisions.ts`, D3), so the finding is suppressed.

This also breaks the agent-first audit rule: the recorded approver is not proven.

Fix:
- Before minting, have the minter read the thread with the read-only token (GraphQL `node(id: threadId) { ... on PullRequestReviewThread { comments { author { login } } } }`).
- Keep only logins that authored a comment in that thread, excluding the bot's own login.
- When none remain, skip with reason `approver-unverified`.

##### PERF-1 [MEDIUM] K2 makes the active-DECISION set grow on its own, and `/context` returns all of it with no limit on every call
Where:
- `memory/prisma-canonical-state.repository.ts:134-148` (`findActiveDecisions`: no `take`, no `orderBy`)
- `memory/canonical-state.service.ts:69-78`
- `context/context-builder.service.ts:144`
- `fleet/reviews/review-event.minter.ts` (mints up to 50 events per review job; `bot-review.parser.ts:74`)

```ts
const rows = await this.db.memoryItem.findMany({ where: { projectId, kind: 'DECISION', status: 'active', deletedAt: null }, select: {...} });
```

The prior review rated this LOW (PERF-3), when only members could add decisions by hand. Since K2, every withdrawn finding on every trusted PR mints an active DECISION. The K2 spec D3 notes that a reworded finding gets a new key, so these rows accumulate faster than recorded ones. `findReviewDecisionRows` caps what goes to a review at 100. `/context` (agent and assistant context) has no cap.

Failure scenario: after a few months of auto-review on an active repo, each `/context` call returns thousands of "Not a defect: ..." rows. The cost is DB time and a large payload, and agents spend context on review noise unrelated to their ticket.

Fix: add `take` and `orderBy: { updatedAt: 'desc' }` to `findActiveDecisions`. Exclude `sourceType: 'review_event'` from `/context`, or cap it separately, because those decisions already reach the reviews that need them.

#### LOW

##### BUG-1 [LOW] A failed `markDispatched` (or a crash right after dispatch) leaves a `pending` claim that a later pass reopens, so the same head is reviewed twice
- **Where:**
  - `fleet/reviews/review-head-dispatcher.ts:86-91` (stale `pending` is removed after one poll interval)
  - `fleet/reviews/review-head-dispatcher.ts:134` (`markDispatched` runs after the job is committed, in a separate write)
  - `fleet/reviews/fix-follow-up.subscriber.ts:139-142` (same pattern)
- **Scenario:**
  1. `jobs.dispatch` commits the REVIEW job. Then `markDispatched` hits a transient DB error, or the process restarts.
  2. The claim stays `pending`.
  3. After `prReviewPollMs`, `reopenStaleClaim` deletes it and dispatches again.
  4. If the first review is still active, the 409 path drops the claim and retries on every pass. Once the first review ends, a second paid review of the same head runs.
- **Fix:** Before reopening a stale `pending` row, look for a `REVIEW` job with `feature = review-pr-<n>` on that repo created after `row.createdAt`. If one exists, mark the claim `dispatched` with its id. Alternatively, have `dispatch` write the claim's `jobId` in the job's own transaction.

##### BUG-2 [LOW] An approved (deferred) `vcs.sync.all` imports every issue in one approval transaction, with no ticket-number retry and the default interactive timeout
- **Where:**
  - `vcs/vcs-manual-sync.service.ts:82-91` (`isolate: false`)
  - `vcs/vcs-sync.service.ts:122-145`
  - `common/utils/ticket-number-retry.ts:41` (no retry inside a transaction)
  - `approvals/approval-execution.service.ts:281` (`txManager.run` with no timeout option)
- **Scenario:**
  1. A project gates `vcs.sync.all` behind an approval policy.
  2. The approver approves a sync of a repo with a few hundred open issues.
  3. Execution creates the tickets one by one inside a single interactive transaction. It exceeds the default timeout, or one ticket-number conflict with a concurrent creator aborts it.
  4. The approved action fails and rolls back, and it does the same on every retry.
- **Fix:** Cap the deferred import, for example at 50 issues, and report `capped`. Alternatively, pass an explicit `timeout` for this variant, or run the import after commit as its own isolated pass.

##### SEC-3 [LOW] CI webhook replay protection depends on headers the HMAC does not cover
- **Where:**
  - `ci-webhook/ci-webhook.controller.ts:39-60`
  - `webhook-security/webhook-replay.guard.ts:46-49,119-121` (no `Date` header means the time window is skipped)
- **Scenario:** Anyone who once sees a signed CI body (CI logs, a proxy, a debugging dump) can resend it with a fresh `X-CI-Delivery` and no `Date` header. Each resend creates another HIGH-priority BUG ticket.
- **Why this is a defect here:** GitHub's scheme cannot be changed. The CI scheme is koda's own.
- **Fix:** Sign `${deliveryId}.${timestamp}.${body}`, require the timestamp, and reject requests more than 5 minutes old.

##### ENH-1 [LOW] Residual agent-first audit gap: merged-PR comment and activity rows carry no actor
- **Where:** `vcs/prisma-vcs.repository.ts:365-385`. The `FIX_REPORT` comment has `authorUserId: null, authorAgentId: null`; the `TicketActivity` has `actorUserId: null, actorAgentId: null`.
- **Problem:** The `AuditEntry` is correct (`SYSTEM/vcs`). The ticket's own history, which is the only thing the ticket UI and agents read, shows an anonymous transition. The transition also still emits no TicketEvent/outbox, webhook or live event (prior BUG-6 item 3).
- **Fix:** Route it through a `TicketTransitionsService` system-actor method so the event triplet is emitted, and record a SYSTEM marker on the activity.

##### STYLE-1 [LOW] Dispatch-error classification is duplicated between the two K-series dispatchers
- **Where:**
  - `fleet/reviews/review-head-dispatcher.ts:113-143`
  - `fleet/reviews/fix-follow-up.subscriber.ts:113-137,169-173`
- **Problem:** Both files carry the same Budget/Conflict/Validation/NotFound/FleetDispatch branching and the same `getExceptionResponse` helper. Both copies must also stay in step with `schedule-ticker.ts:190-214`.
- **Fix:** Extract one `classifyDispatchError(error): 'budget' | 'active' | { failed: reason } | 'retry'` into `fleet/jobs/`.

### 3. Prior-finding status (docs/20261018-review-whole-repo.md, Review C)

| ID | Status | Evidence |
|:--|:--|:--|
| SEC-1 KB overwrite by `source_id` | PARTIAL | KB side fixed: `lance-table-manager.ts:54-56,541`, `vector-store.service.ts:261` use `sourceRowFilter`. `add-document.dto.ts:12-20` allows only `doc`/`manual`. `kb-document-addition.service.ts:37-41` checks ownership. `kb-creator.ts` / `vector-store.service.ts:241-243` drop caller-supplied `kodaCreatedBy`. Reverse direction open: new SEC-1. |
| SEC-2 memory writes / supersede / `/extract` ticketId | FIXED | `memory-write.service.ts:52-60` (membership + catalog key; VIEWER has no `memory.*` write, `system-roles.ts:160-172`). `memory-write.guard.ts:50-65` runs the supersede check inside the serializable upsert (`prisma-memory-item.repository.ts:237`). `/extract` ticket check at `memory-write.service.ts:111-113`. Audit via `memoryAuditHook`. |
| BUG-1 soft-deleted project background work | OPEN | `prisma-budget.repository.ts:97` unchanged. `placement.service.ts:122,160` / `prisma-fleet-job.repository.ts:170` have no project filter. `prisma-vcs.repository.ts:108-130` (`findVcsConnectionById`, `findPollingConnections`) has no `deletedAt`. `projects.service.ts:235-237` only sets `deletedAt`. New auto-review does filter (`prisma-fleet-repo.repository.ts:55`). |
| BUG-2 `fillRunner` head-of-line starvation | OPEN | `placement-rules.ts:166` `QUEUED_SCAN_LIMIT = 50`; `placement.service.ts:122,160`. |
| BUG-3 issue import check-then-insert | OPEN | `vcs-sync.service.ts:47-59`. `schema.prisma:232` still `@@index([externalVcsId])`, not unique. `vcs-polling.service.ts:82-84` has no in-flight guard. |
| BUG-4 entity-graph `assigned` keys | OPEN | Consumer `entity-graph.service.ts:241-242` reads `assignedToUserId`/`assignedToAgentId`. Producer `tickets.service.ts:516-518` sends `assignedTo` + `assigneeType`. |
| BUG-5 optimize outside write mutex | OPEN | `strategies/counter-optimize.strategy.ts:28`, `cron-optimize.strategy.ts:47`, `optimize-in-background.ts:13` call `table.optimize()` directly. The `vector-store.service.ts:267-268` call site is unchanged. `knowledge-chunk-store.ts:81-84` still writes the same table under `exclusive`. |
| BUG-6 merged-PR transition bypasses state machine | PARTIAL | Fixed: conditional `updateMany` on `status: IN_PROGRESS, deletedAt: null` (`prisma-vcs.repository.ts:355-358`); `AuditEntry` recorded (`vcs-pr-sync.service.ts:256-269`). Open: no TicketEvent/outbox/webhook/live; null actor on comment/activity (`:365-385`); `prState` committed separately and the transition failure only logged (`vcs-pr-sync.service.ts:204-219,270-283`). |
| ENH-1 agent-first audit | PARTIAL (mostly fixed) | `AuditEntry` has `actorType/onBehalfOf/requiredMode/satisfiedBy/approverType/approverId` (`schema.prisma:858-887`). Coverage enforced per entry point (`action-context/audit-coverage.ts`, allowlist `audit-coverage.allowlist.ts`). Schedules record SYSTEM + `onBehalfOf` (`schedule-ticker.ts:164-168,234-239`). Residual: new ENH-1 (merged PR), new SEC-2 (unverified approver). |
| BUG-7 out-of-order `code_commit` rollback | OPEN | `prisma-code-intel.repository.ts:94-102` overwrites `commitHash` unconditionally. |
| BUG-8 crash between `claimFire` and dispatch | OPEN (undocumented) | `schedule-ticker.ts:117-118`. |
| BUG-9 requeue keeps `scheduleCountedAt` | OPEN | `fleet-jobs.service.ts:296-305`: the requeue patch has no `scheduleCountedAt: null`; `schedule-progress.service.ts:24`. |
| PERF-1 PR refresher starvation >500 | OPEN | `prisma-fleet-tickets.repository.ts:204` orders by `prUpdatedAt`; `fleet-pr-state.refresher.ts:141` returns early without bumping it. |
| PERF-2 AST index O(S^2) + one tx | OPEN | `ast-index.service.ts:111-118` (`.find` per caller/callee) inside `txManager.run` (`:94`); `dto/index-commit.dto.ts` has no `ArrayMaxSize`/`MaxLength`. |
| PERF-3 unbounded reads | OPEN, escalated | `timeline.service.ts:131` `getTicketHistory` still present. `findActiveDecisions` is unbounded and now grows automatically: new PERF-1. |
| PERF-4 `vectorRows.find` in loop | OPEN | `hybrid-retriever.service.ts:274`. |
| MEM-1 EntityStore unbounded, deleted tickets | OPEN | `prisma-rag.repository.ts:198-203` `findTicketById` has no `deletedAt` filter. |
| MEM-2 embedding timeout does not cancel | OPEN | `knowledge-repo-indexer.ts:292-305` still uses `Promise.race` without `AbortSignal`. |
| SEC-3 webhook HMAC secret plaintext | OPEN | `vcs-connection.service.ts:99,111`; `vcs-webhook.controller.ts:48` uses the stored value directly as the key. |
| SEC-4 `allowedAuthors` fails open | OPEN | `vcs-sync.service.ts:91-94`. |
| ENH-2 retrieval harness open to members | FIXED | `retrieval.controller.ts:36` `@Requires('retrieval.evaluate')`. The key is not in `developer` (`system-roles.ts:56-99`), and `*.read` does not match it (`entry-matcher.ts`: last segment `read` only). Only `project-admin` (`*`) holds it. |
| STYLE-1 files >400 lines | OPEN (grown) | `vcs-webhook.service.ts` 750 (was 702), `vector-store.service.ts` 684 (was 555), `lance-table-manager.ts` 582 (was 490), `entity-graph.service.ts` 514, `markdown-chunker.ts` 480. New: `prisma-vcs.repository.ts` 460, `vcs-connection.service.ts` 456, `hybrid-retriever.service.ts` 442, `prisma-memory-item.repository.ts` 415. |
| Deferred: uppercase `TICKET_*` / dead `incident_linked` | OPEN | `extraction.service.ts:87,109,131`; no producer emits `incident_linked`; `entity-graph.service.ts:282` is still dead. |
| Deferred: `source_id`-only replace scope | PARTIAL | See SEC-1 rows above. |

Verified OK this pass (no finding):
- **VCS webhook:**
  - Timing-safe signature check, with the same 401 for every failure (`vcs-webhook.controller.ts:45-51`).
  - Replay is recorded before handling and forgotten on failure (`:66-83`).
  - A non-unique DB error surfaces as 5xx (`webhook-replay.guard.ts:83-87`).
- **Outbound webhooks:**
  - DNS-pinned lookup and no redirects (`outbound-http-client.ts:84-104`).
  - The generated secret is redacted from approval requests (`webhook-route.commands.ts:43-50`).
- **Auto-review:**
  - A unique `(repoId, prNumber, headSha)` claim (`schema.prisma:812`); single-flight poller.
  - A pass-wide dispatch cap counted per attempt.
  - The enabler is revalidated on every pass (`enabler-gate.ts`).
  - Forks, drafts and soft-deleted projects are skipped.
  - REVIEW and FIX share the feature `review-pr-<n>`, so they cannot run at once (`dispatch-input.ts:30-38`).
- **No review/fix loop:** K3 has no automatic FIX (spec line 43), and a follow-up REVIEW fires only after a FIX that pushed.
- **K2 ingest:**
  - Only REVIEW/FIX bundles of the current lease are parsed (`bundle-ingest.service.ts:103-108`).
  - Untrusted PRs are recorded as skipped.
  - Events are deduped by `(jobId, leaseEpoch, threadId)`.
  - The mint is guarded against duplicate and retired decisions inside the serializable upsert.
- **Read scoping:**
  - Activity feed filtered by `projectIdsWithKey`.
  - Dashboard unplaceable items filtered to scope (`attention-rules.ts:50-51`).
  - Code-intel lookups keyed by `projectId` (`prisma-code-intel.repository.ts:121-160`).
  - Knowledge search filters to the project's repos.
- **Schedules:** CAS `claimFire`, `ticking` flag, dispatch outside a transaction, and owner access revalidated at fire.

### 4. Rulings needed

1. **K2 self-approval.** On a trusted PR, the PR author is a writer and can be the first `disagreedBy` login. They can then approve the "Not a defect" decision that suppresses a finding on their own code in all future reviews. Should the approver be required to differ from the PR author (and the FIX requester)?
2. **Agent-recorded decisions reach every review.** Agents with the `developer` role hold `memory.decision.record`. Under D3, recorded decisions go project-wide into every REVIEW and are never pushed out by review-minted ones. This lets an agent shape the reviewer's prompt. Options: exclude `ownerType: 'AGENT'` decisions from review input, or require a human approval policy on `memory.decision.record` for agents.
3. **SEC-2 fix cost.** Verifying thread authorship adds one GitHub call per event. Accept that cost, or keep relying on runner/job integrity and record `satisfiedBy: 'unverified-human'` instead?
4. **CI webhook signature change (SEC-3).** Signing the timestamp and delivery id breaks existing CI senders. A versioned header (`X-CI-Signature-V2`) with a deprecation window?
5. **Soft-delete semantics (prior BUG-1), still open after two reviews.** Decide whether a soft-delete must cancel queued jobs, disable polling and schedules, and keep budget pauses in force.

### 5. Rubric (0-20)

| Dimension | Score | Rationale |
|:--|:--|:--|
| Security | 15 | Key-based authz is consistent and fails closed, prior memory/KB overwrite classes are closed, inbound and outbound webhook handling is solid. Lost points: knowledge-store source confusion (SEC-1), unverified forge approver (SEC-2), plaintext VCS HMAC secret, CI replay via unsigned headers. |
| Reliability | 12 | Strong CAS/claim discipline in the new K1-K3 code. Lost points: five prior MEDIUM reliability defects still open (soft-delete leakage, starvation, import race, optimize race, entity-graph contract), the merged-PR transition still outside the state machine, the duplicate-review window. |
| API Design | 16 | Approval-gated routes are uniform, secrets are redacted from requests, DTOs are tight. Weak spots: `AddDocumentDto.sourceId` accepts reserved namespaces; `IndexCommitDto` unbounded; `/context` decision list unbounded. |
| Code Quality | 14 | Clear design references and small focused K-series files. Lost points: nine files over 400 lines (several grew), duplicated dispatch-error classification, dead `incident_linked`/`getTicketHistory` paths. |
| Best Practices | 15 | Audit coverage is now enforced per entry point with approval mode and approver. Lost points: an approver recorded without proof (SEC-2), anonymous merged-PR ticket history, and still no producer/consumer contract test for outbox events (BUG-4 survives a second review). |
| **Total** | **72 / 100** | |

---

## Review D: runner, fleet-protocol, CLI, web, CI/deploy (koda main @ 61052931, v0.4.2)

Read-only static review. The test suite was not run. Checklists: universal.md, node-general.md, vuejs.md, nuxtjs.md.
apps/api was read only to trace calls (placement rules, git-token broker). The nax repo was read to confirm two
contracts K3 depends on: the default `bashApproval` mode and how `NAX_FORGE_TOKEN_FILE` is consumed.

### 1. Summary

Since 44269581, the work in this area has been the permission redesign web UI (P1-P3) and the S6 bot jobs: K1 REVIEW,
K2 ingest and K3 FIX. The new runner code for K3 is careful:
- argv is rebuilt and re-validated (`buildFixArgv`).
- The forge token reaches nax through a 0600 file that nax consumes, never through env or argv.
- `readFixOutcome` reads the pushed sha through a realpath jail with `O_NOFOLLOW`.
- The two-step chain is cancel-, halt- and readopt-aware, and a FIX never reports COMPLETED without a fix line (D6).
- On the web side, the new approval UI renders agent-authored bash and reasons as text only, and every new PR link goes
  through `safePrUrl`/`safeHttpUrl`.

Two areas have not moved:
- **Ruling 5 (accepted 10-18) is not implemented.** The credential socket still answers a bare `get` with no per-job
  nonce. Placement has no rule that keeps a raw job off a runner that is running another project's job. The
  "one runner = one trust domain" rule is not documented anywhere. K1/K3 make this worse: REVIEW and FIX are forced to
  `bashMode: raw` and carry a repo-wide write token.
- **Almost every prior D and E finding is still open.** Of 18 D items and 24 E items, none is fixed at HEAD. Two D items
  are partial: logout now prints a clarifying message, and the TURBO secret is mounted in the Dockerfiles but never
  passed by CI. This includes the HIGH web session issue (E BUG-1), the compose and release hardening, and the sync-loop
  hot loop.

Counts (new + carried, de-duplicated): CRITICAL 0, HIGH 2, MEDIUM 17, LOW 5 new (carried LOWs are tracked in the
status table, section 3).

### 2. Findings

#### CRITICAL
None.

#### HIGH

##### SEC-1 [HIGH] (new; Ruling 5 not implemented) Raw REVIEW/FIX jobs can mint any concurrent job's push token; nothing keeps them apart
- **Files:**
  - `apps/runner/src/credentials/cred-server.ts:32-36` (accepts a bare `get`).
  - `apps/runner/src/credentials/socket-dir.ts:20-23` (deterministic socket name).
  - `apps/runner/src/supervisor/assign-parser.ts:196` (REVIEW/FIX must be raw).
  - `apps/api/src/fleet/jobs/placement-rules.ts:99-125` and `:180-186` (`toPlacementJob` carries no projectId; no rule
    about raw jobs or other projects).
```ts
if (buffered.slice(0, newline).trim() !== 'get') { answer({ ok: false, reason: 'bad request' }); return; }
reply().then(answer, ...)                                     // cred-server.ts: no nonce, no peer check
... ((isPlan || isConfig || isThread || isReview) && p['bashMode'] !== 'raw')) return bad('bashMode');  // assign-parser.ts:196
```
- **Scenario:**
  1. Project A dispatches a FIX on PR 12. Project B's RUN is already running on the same runner (capacity > 1).
  2. The FIX agent session runs with raw bash. nax's default is `raw` (`nax-agent/src/config/bash-approval.ts:22`), and
     koda forces it for REVIEW and FIX. It works on PR content and thread text.
  3. A prompt injection in the PR runs `for s in /tmp/koda-runner-$UID/*.sock; do printf 'get\n' | nc -U $s; done`.
  4. It receives B's installation token: `contents: write`, `pull_requests: write` on B's repo, with no branch
     restriction (K3 design, "Facts").
- **Ruling 5 status:** accepted 10-18 as "per-job nonce on the credential socket, and no unsandboxed or raw job
  concurrent with another project's job". Neither half exists, and no doc states the trust-domain rule (grep for
  "trust domain" outside the 10-18 review finds nothing).
- **Fix:**
  1. Generate `randomBytes(32)` per (job, epoch) in the broker. Embed it in the helper and shim argv
     (`job-files.ts:11-18`) and require `get <nonce>\n`, compared with `timingSafeEqual`.
  2. In placement, add a `trust_domain` misfit: refuse a job when the runner has an active job of another project and
     either job is raw (or unsandboxed). This needs the runner's active-job project ids in `RunnerLoad`.
  3. Add a sentence to `.nax/mono/apps/runner/context.md` and the deployment README.

##### BUG-1 [HIGH] (carry, prior E BUG-1, OPEN) Full page loads more than 15 min after the last refresh force a re-login
- **Files:** `apps/web/server/api/auth/me.get.ts:9-13`, `apps/web/middleware/auth.global.ts:15-22`,
  `apps/web/server/utils/api.ts:43-50`.
- **Code:** unchanged since the prior review: `if (!accessToken) return { user: null }`. No SSR refresh path exists.
- **Scenario and fix:** as in the 10-18 review. Refresh from `koda_refresh` inside the probe, or in a Nitro page
  middleware, and propagate the `Set-Cookie`.

#### MEDIUM

##### BUG-2 [MEDIUM] (new, K3/K1) The forge token handed to nax is a one-shot snapshot that may have only about 5 minutes left; a long fix fails to push or reply
- **Files:**
  - `apps/runner/src/executor/host-executor.ts:209-217` (`spawnFixStep`) and `:247-253` (`reviewEnv`).
  - `apps/runner/src/credentials/broker.ts:133-136`.
  - `apps/api/src/fleet/git-broker/git-token.broker.ts:39-40`.
  - nax `packages/nax/src/forge/identity.ts:1-16` ("captured once at CLI start ... US-004 (`botGit`) consume it").
```ts
const token = this.deps.credentials.currentToken?.(job) ?? null;   // any unexpired token, however close to expiry
const tokenPath = await writeReviewToken(jobDir, token);
```
- **Scenario:**
  1. The API reuses a cached installation token until `gitTokenReuseMarginSec` (300 s) before expiry. The runner
     refreshes its cache shortly before that. So when step 1 (the `--full` review) ends, `currentToken` can have
     anywhere from about 5 to 60 minutes left.
  2. nax reads the file once and uses that token for forge calls and for `botGit`, the push.
  3. A fix session usually runs longer than 5 minutes: install, agent, repo gates. The push or the thread replies then
     fail with 401, and the job ends FAILED (`push-rejected` or the stderr line) although the fix was good.
  4. REVIEW jobs have the same exposure when a review outlives the token.
- **Fix:**
  - Before writing `forge-token`, require at least N minutes of remaining life, where N exceeds the expected step
    length (for example 50). When the remaining life is shorter, force a fresh mint: a `tokenRequests` entry with a
    "fresh" flag, which the API can honour by skipping reuse.
  - Better: ask nax for a generic "token command" (`NAX_FORGE_TOKEN_COMMAND` that runs the shim) so nax can re-read the
    token. File it as a generic nax feature.

##### SEC-2 [MEDIUM] (carry, prior D SEC-1, OPEN; exposure increased by K1/K3) Runner git in the shared clone still honours repo-local hooks and config
- **File:** `apps/runner/src/executor/git.ts:83-87`. Only the `credential.helper` `-c` args are added.
```ts
const proc = Bun.spawn(['git', ...helperArgs(options.credentialHelper), ...args], { ... });
```
- **What changed:** REVIEW and FIX are now always raw, and `nax bot` creates PR worktrees from the shared clone
  (`repoDir`). Worktrees share the main gitdir's `config` and `hooks`.
- **Scenario:**
  1. A raw agent in any REVIEW or FIX job writes `core.hooksPath` or `core.fsmonitor`.
  2. The next job's `ensureClone`/`cleanWorkspace`/`checkout` runs that payload inside the daemon, which holds every
     job's sockets.
  - Unless the runner's global nax config enables the OS sandbox, nothing blocks the write: koda's job profile does not
    force `sandbox` on (`job-profile.ts:31-45`).
- **Fix:** as before. Add a fixed prefix to every call:
  `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false -c protocol.file.allow=never`
  (or `GIT_CONFIG_COUNT`). Consider forcing `sandbox.enabled` in the job profile for raw kinds.

##### SEC-3 [MEDIUM] (new, design-accepted; ruling needed) A FIX job's raw agent holds a token that can push to any branch of the repo, including the default branch
- **Files:** `apps/runner/src/executor/host-executor.ts:200-226`, `docs/superpowers/specs/2026-11-01-fleet-s6-k3-pr-fix-design.md`
  ("Facts": `contents: write` with no branch restriction; Constraints: "No change to the git broker or token scopes").
- **Scenario:**
  1. nax refuses untrusted PRs (R11), but thread text from any commenter and the PR diff still reach the fix agent.
  2. With raw bash, `git push origin HEAD:main` through the shim succeeds unless the default branch is protected.
  3. The push is attributed to the App, not to a person.
- **Fix options:**
  - (a) Require branch protection on the default branch before FIX placement (repo check).
  - (b) Mint FIX tokens through a broker path that the runner-side shim filters by refspec. The runner already
    proxies git through `git-cred` and the shims, so a pre-push refspec allowlist (PR head branch only) is feasible
    in `shim`.
  - (c) Accept and document.

##### BUG-3 [MEDIUM] (carry, prior D BUG-1, OPEN) A persistent 400 makes the sync loop hot-loop and overwrite events
- **File:** `apps/runner/src/sync/sync-loop.ts:104-106` (`again` never sleeps) and `:196-205` (replace `events[0]`,
  reset scale, `again`). Unchanged. The fix from 10-18 still applies.

##### BUG-4 [MEDIUM] (carry, prior D BUG-2, OPEN) Watch liveness is `kill(pid,0)` only, and EPERM counts as alive
- **Files:** `apps/runner/src/supervisor/job-run.ts:445`, `apps/runner/src/executor/nax-process.ts:66-74`.
- **K3 impact:** a FIX now has two watched pids in sequence, so a readopted FIX has the same recycled-pid hang. The
  hang holds the repo mutex and the `review-pr-<n>` active-feature slot, which blocks every REVIEW of that PR.

##### OPS-1 [MEDIUM] (carry, prior D OPS-1, OPEN) The launchd plist sets `KeepAlive` true unconditionally, and `runner.log` has no rotation
- **File:** `apps/runner/src/service/units.ts:111-120`.

##### Web/CI/deploy MEDIUMs carried from prior E, all OPEN (evidence in section 3)
| ID | Prior ID | Title |
|:--|:--|:--|
| SEC-4 | E SEC-1 | Logout skips revocation with no access cookie (`logout.post.ts:9-17`) |
| BUG-5 | E BUG-2 | `SameSite=Strict` plus no return-to sends deep links to `/` (`api.ts:46,55`; `auth.global.ts:21`; `login.vue:89`) |
| BUG-6 | E BUG-3 | An API outage is treated as logout, and streams stop permanently (`useAuth.ts:106-113`; `project-event-stream.ts:204-212`; `thread-event-stream.ts:84-92`) |
| SEC-5 | E SEC-2 | Raw invite token in client paths (`pages/invite/[token].vue:21,34`; `useAuth.ts:56`); the guard root list still omits `invites` (`tests/lib/api-path-guard.spec.ts:10`). The new Nitro route `server/api/invites/[token]/accept.post.ts:7-10` also interpolates the router param raw. |
| SEC-6 | E SEC-3 | Example compose falls back to `change-me` JWT and API-key secrets (`deployments/example/docker-compose.yml:10-14`) |
| SEC-7 | E SEC-4 | API image runs as root (`apps/api/Dockerfile`: no `USER`; only the web image has `USER nuxt`) |
| SEC-8 | E SEC-5 | API port published in both compose files (`docker-compose.yml:15-16`, `deployments/example/docker-compose.yml:6-7`) |
| SEC-9 | E SEC-6 | Ollama published on 0.0.0.0, `:latest` (`docker-compose.yml:102-109`) |
| SEC-10 | E SEC-7 | Compose access-token TTL is 7d and refresh 30d (`docker-compose.yml:20,22`; example `:11,13`; dev `:13,15`) |
| SEC-11 | E SEC-8 | Release grants `contents/packages: write` and `id-token: write` workflow-wide; actions are tag-pinned (`release.yml:15-18`); no dependabot |
| BUG-7 | E BUG-4 | `workflow_dispatch` re-publish checks out the default branch, not the tag (`release.yml` every `actions/checkout@v7` has no `ref:`) |

#### LOW (new)

##### SEC-12 [LOW] The bash approval panel renders bidi and zero-width characters invisibly (Trojan-Source class)
- **Files:** `apps/web/components/approvals/ApprovalRequestBashPanel.vue:16-19,26`, `apps/web/lib/fleet-approvals.ts:78-96`,
  `apps/runner/src/approvals/detail-parser.ts`. Nothing on either side filters or flags them.
- **Scenario:** a prompt-injected agent asks to run `cat notes.txt #<U+202E>...` or embeds U+200B. The `<pre>` shows a
  benign-looking command, and the approver clicks Allow (or Allow for job).
- **Fix:** in `bashPayload`, detect `[‪-‮⁦-⁩​-‏﻿]` and other C0/C1 controls. Render
  them as visible escapes (`‮`), and make such asks deny-only, the same as `commandTruncated`.

##### SEC-13 [LOW] The FIX `stateReason` is nax's raw first stderr line, not passed through `sanitizeDiagnostic`
- **File:** `apps/runner/src/executor/host-executor.ts:300-306`. The line reaches `transition(to, reason)`, which only
  truncates (`supervisor/job-events.ts:28`), and is shown on the job page.
- **Scenario:** git and forge errors can echo remote URLs or headers. Every other diagnostic path (`git.ts:34`,
  config-job steps, nax-cli) redacts.
- **Fix:** `sanitizeDiagnostic(line).slice(0, 200)`.

##### ENH-1 [LOW] FIX step-2 output is never streamed live
- **File:** `apps/runner/src/executor/host-executor.ts:255-261`. `logSources` names only `nax.stdout`/`nax.stderr`.
- **Effect:** `fix.stdout`/`fix.stderr` arrive only in the bundle (`bundle/build-bundle.ts:43`), so the log viewer
  shows nothing during the longest part of a FIX.
- **Fix:** switch the sources when `hasFixStep` is true, or register both pairs.

##### BUG-8 [LOW] (carry, prior D SEC-3, widened) `assertCloneUrl` accepts `http:` and `file:`
- **File:** `apps/runner/src/executor/workspace.ts:7`.
- The API only builds https URLs, and `cleanProjectRepos` insists on https (`assign-parser.ts:112`). The ASSIGN path
  does not. Credentials are protected by the protocol and host match in `git-credential.ts:80`, but a compromised
  server can still make the runner clone any local repo.

##### STYLE-1 [LOW] (carry, prior D STYLE-3) File size
- `thread/thread-job-run.ts` is 1045 lines. `supervisor/job-run.ts` has grown from 642 to 727 lines with the K3 chain;
  `judge()` (lines 448-505) is now about 60 lines with a 5-level FIX branch. Extract `judgeFix()`.

### 3. Prior-finding status

#### Review D (runner, protocol, CLI)
| ID | Status | Evidence at 61052931 |
|:--|:--|:--|
| BUG-1 sync 400 hot loop | OPEN | `sync-loop.ts:104-106,196-205` unchanged |
| SEC-1 runner git not hardened | OPEN | `git.ts:83-87` only adds `credential.helper` |
| SEC-2 per-job sockets uid-only (Ruling 5 nonce) | OPEN | `cred-server.ts:32-36` bare `get`; `socket-dir.ts:20-23`; no nonce in `job-files.ts:11-18` |
| BUG-2 watch liveness `kill(pid,0)` | OPEN | `job-run.ts:445`; `nax-process.ts:66-74` (EPERM = alive) |
| OPS-1 launchd KeepAlive and log growth | OPEN | `units.ts:111-120` |
| BUG-3 `pruneJobs` throws outside try | OPEN | `daemon.ts:79` `assertInside` outside try; `:259` `void pruneJobs(...)` |
| MEM-1 cred socket rereads after newline | OPEN | `cred-server.ts:24-37`: `answered` is set only when the reply resolves, so each chunk during `serveWaitMs` calls `reply()` again |
| BUG-4 cancel signals pgid without identity check | OPEN | `job-run.ts:198-202` (`sendTerm`), `:396-402` (`escalateKill`) |
| SEC-3 `file:` clone URLs | OPEN | `workspace.ts:7` (`http:` too) |
| SEC-4 journal mode skipped as root | OPEN | `journal.ts:9,53` |
| SEC-5 enroll token on argv | OPEN | `runner/src/main.ts:35`; `cli/src/commands/fleet-runner.ts:96` prints the argv form |
| BUG-5 logout clears the global key, not the used one | PARTIAL | `cli/src/commands/auth.ts:84-92`: behaviour unchanged, but the message now says profile, project and env keys are not affected |
| SEC-8 secrets on argv | OPEN | `auth.ts:49`, `user.ts:63`, `webhook.ts:21` |
| SEC-9 repo config selects profile | OPEN | `cli/src/config.ts:154-155` |
| STYLE-2 `??` for apiKey; hint uses argv form | OPEN | `config.ts:165-170`; `utils/error.ts:135` |
| PROTO-1 dead `nextPollAfterMs`, stale comment | OPEN | `fleet-protocol/src/index.ts:295`; `api/src/fleet/common/protocol.ts:54` |
| STYLE-3 file size | OPEN | `thread-job-run.ts` 1045 lines; `job-run.ts` 727 lines (grew) |
| ENH-1 systemd hardening and restart loop | OPEN | `units.ts:62-75` (`Restart=always`, no `NoNewPrivileges`/`Protect*`) |

#### Review E (web, CI, deploy)
| ID | Status | Evidence at 61052931 |
|:--|:--|:--|
| BUG-1 [HIGH] SSR never refreshes | OPEN | `me.get.ts:9-13`; `auth.global.ts:15-22` |
| SEC-1 logout skips revocation | OPEN | `logout.post.ts:9-17` |
| BUG-2 Strict cookie and no return-to | OPEN | `api.ts:46,55`; `auth.global.ts:21`; `login.vue:89` |
| BUG-3 outage = logout, streams stop | OPEN | `useAuth.ts:106-113`; `project-event-stream.ts:204-212`; `thread-event-stream.ts:84-92` |
| SEC-2 raw invite token in paths | OPEN | `pages/invite/[token].vue:34`; `useAuth.ts:56`; guard `api-path-guard.spec.ts:10`; plus new `server/api/invites/[token]/accept.post.ts:10` |
| SEC-3 example compose default secrets | OPEN | `deployments/example/docker-compose.yml:10,12,14` |
| SEC-4 API image runs as root | OPEN | `apps/api/Dockerfile` has no `USER` |
| SEC-5 API port published | OPEN | `docker-compose.yml:15-16`; example `:6-7` |
| SEC-6 Ollama exposed, `latest` | OPEN | `docker-compose.yml:102-109` |
| SEC-7 7d/30d JWT TTL in compose | OPEN | `docker-compose.yml:20,22`; example `:11,13`; dev `:13,15` |
| SEC-8 release permissions and pins | OPEN | `release.yml:15-18`; actions on major tags (v2-v7); no `.github/dependabot.yml`. Note: `environment: release` was added on the cli and docker jobs, which helps but does not reduce token scope |
| BUG-4 re-publish without tag checkout | OPEN | `release.yml`: no `ref:` on any checkout; docker jobs do not depend on `cli` |
| SEC-9 `${{ }}` in `run:` | OPEN | `release.yml:39,56,64-65` and the notify step |
| SEC-10 refresh cookie path `/` | OPEN | `api.ts:52-59` |
| SEC-11 no security headers or CSP | OPEN | `nuxt.config.ts`: no `routeRules` headers or nitro header middleware |
| PERF-1 no refresh single-flight | OPEN | `useAuth.ts:106-113`; `useApi.ts:219` |
| BUG-5 `secure: true` hard-coded | OPEN | `api.ts:47,56` |
| BUG-6 `deploy.sh` health race | OPEN | `deploy.sh:70-77` (`up -d` with no `--wait`) |
| ENH-1 API image lacks `NODE_ENV=production` | OPEN | `apps/api/Dockerfile:99` sets only `ENV_NAME` |
| SEC-12 `.dockerignore` root-only `.env` | OPEN | `.dockerignore` (`.env`, `.env.*` only; no `**/.env`, `**/.output`) |
| SEC-13 CI `TURBO_TOKEN` to every job, no `permissions:` | OPEN | `ci.yml:31-33`; no `permissions` key |
| ENH-2 SSE proxies send no `x-client-ip` | OPEN | `live-proxy.ts:92` headers are only accept and cookie |
| STYLE-1 duplicated stream recovery | OPEN | `thread-event-stream.ts` vs `project-event-stream.ts` (same recover/stopped logic) |
| OPS-1 release gaps | PARTIAL | Dockerfiles mount `/run/secrets/TURBO_TOKEN` (`apps/web/Dockerfile:62`, `apps/api/Dockerfile:63`), but `release.yml` still passes it as a build-arg with no `secrets:`, so the cache is still unused. No CI gate. `rollback.sh:69` still uses GNU `sed -i`. |

### 4. Rulings needed

1. **Ruling 5 implementation scope (SEC-1).** It was accepted but never built. Confirm that the short-term pair (socket
   nonce plus a placement trust-domain misfit) is wanted now. It interacts with K1/K3 forcing every REVIEW and FIX to
   raw. Alternative: cap `capacity` at 1 on runners that advertise `botReview`/`botFix`.
2. **FIX push scope (SEC-3).** Choose one: accept a repo-wide write token held by a raw agent; require default-branch
   protection before placing a FIX; or add a runner-side refspec allowlist in the git shim (PR head branch only).
3. **Forge-token lifetime (BUG-2).** Choose between a runner-side "fresh token" request (an API change: skip reuse for
   FIX/REVIEW mints) and a generic nax `NAX_FORGE_TOKEN_COMMAND`. Because nax is public, the second must be filed as a
   generic feature.
4. **Sandbox for raw kinds (SEC-2).** Should the job profile force nax's OS sandbox on for REVIEW, FIX and THREAD, so the
   hooks/config protection does not depend on each runner's global nax config?
5. **Prior E HIGH/MEDIUM backlog.** None of the session-lifecycle or deploy items moved in two weeks. Confirm whether
   they are deferred by choice or should be bundled now. Suggested bundle: E BUG-1 + SEC-1 + BUG-2 + BUG-3 (session),
   then SEC-3..SEC-8 + BUG-4 (deploy and release).

### 5. Rubric (0-20)

#### Runner + fleet-protocol + CLI
| Dimension | Score | Note |
|:--|:--|:--|
| Security | 13 | Strong per-field re-validation, no shell, token never in env or argv, realpath jails. Lost points: Ruling 5 unbuilt while REVIEW/FIX are forced raw with write tokens, unhardened runner git, and no push-scope limit on FIX. |
| Reliability | 14 | Journal and K3 chain are well fenced (cancel, halt, readopt, "never COMPLETED without fix line"). The sync hot loop, pid-reuse watch and prune rejection are still open; forge-token expiry is a new failure mode. |
| API Design | 16 | One protocol package; FIX reuses the REVIEW assign shape cleanly. Dead `nextPollAfterMs` and a stale comment remain. |
| Code Quality | 15 | Small modules overall. `job-run.ts` grew to 727 lines, `judge()` is deeply nested, `thread-job-run.ts` is 1045 lines. |
| Best Practices | 15 | Design-number traceability and redacting logger. Secrets remain on argv in the CLI and enroll; FIX stderr is not sanitized. |

#### Web + CI + deploy
| Dimension | Score | Note |
|:--|:--|:--|
| Security | 13 | Good BFF and cookie design, DOMPurify, safe-href everywhere, and the approval UI is text-only. Every prior deploy and release issue is still open (default secrets, root API image, published API and Ollama, 7d tokens, broad release permissions). |
| Reliability | 12 | The session lifecycle holes (SSR refresh, outage = logout, lost deep links) are unchanged. |
| API Design | 15 | Clear Nitro auth route and catch-all split. `forwardToApi` with `ignoreResponseError` is still misused by logout. |
| Code Quality | 16 | Pure, tested libs for approvals, fleet and safe URLs; typed props and emits. Stream recovery logic is still duplicated. |
| Best Practices | 12 | No CSP or security headers, no action SHA pinning, no CI `permissions:`, inline `${{ }}` in `run:`. |

---
