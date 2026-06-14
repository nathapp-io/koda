# Koda API + Web Regression Test Plan

Date: 2026-06-14
Scope: Current implemented features only
Goal: Regression safety for completed features that have not yet been fully tested
Excluded: CLI (deferred)

---

## 1. Repo state at time of review

Repository reviewed:
- `projects/koda/repos/koda`

Branch status at review time:
- Current local branch: `main`
- Current `HEAD`: `094c7774b57c2e10d95be689a691e33efee9edfc`
- Latest fetched `origin/main`: `094c7774b57c2e10d95be689a691e33efee9edfc`

Conclusion:
- The checked-out repo **is on latest fetched main**.
- This test plan has been reviewed against the latest available `main` branch state.
- Any unreleased feature branches should be regression-tested separately if they are part of the intended release scope.

---

## 2. Objectives

This plan is designed to:
- protect completed API and Web features from regression
- prioritize critical user-facing and domain-critical workflows
- identify coverage gaps in current automated tests
- validate that Web behavior matches actual backend routes and contracts

This is **not** a roadmap for future features. It is focused on what is already implemented.

---

## 3. Reviewed implementation areas

## 3.1 API

Reviewed controllers and test surface for:
- auth
- projects
- tickets
- ticket lifecycle transitions
- comments
- agents
- labels
- ticket links
- knowledge base / RAG
- VCS integration and manual sync
- code intel / impact analysis
- memory and timeline
- monitoring
- outbox
- webhook / CI webhook

## 3.2 Web

Reviewed pages, components, composables, and existing tests for:
- auth pages
- project board
- ticket detail
- agents page
- labels page
- KB page
- project settings + VCS settings
- dialogs for create/edit/delete flows
- i18n coverage
- Playwright E2E coverage

---

## 4. Current test baseline

The repo already contains substantial automated test coverage.

### 4.1 API current coverage
- controller/service/unit specs across major modules
- integration tests for some route and repository behavior
- E2E tests for core endpoints and selected cross-module workflows

### 4.2 Web current coverage
- Jest tests for pages, components, composables, and i18n
- Playwright tests for auth, projects, KB, labels, VCS, ticket lifecycle, and ticket detail operations

### 4.3 Interpretation
This is not a low-coverage repo. The main need is:
- better regression prioritization
- gap-filling on critical workflows
- contract validation between Web and API
- branch-aware regression execution

---

## 5. Test strategy

## 5.1 API layers

### Unit tests
Use for:
- domain rules
- permission logic
- validation edge cases
- state-machine transitions
- error mapping

### Integration tests
Use for:
- Prisma repository behavior
- DB constraints
- soft-delete semantics
- transactions
- encryption/decryption wiring
- provider adapter integration with stubs/mocks

### API E2E tests
Use for:
- real HTTP contract validation
- auth and permission enforcement
- response shape verification
- multi-step workflow regression
- project-scoped route behavior

## 5.2 Web layers

### Component and page tests
Use for:
- rendering states
- form validation
- payload shaping
- action button behavior
- toasts and UI state changes

### Browser E2E tests
Use for:
- critical human workflows
- auth and redirects
- board and detail page behavior
- VCS and KB interactions
- regression of integrated page flows

---

## 6. API regression test plan

## 6.1 P0, critical regression coverage

### A. Authentication
Protect:
- user registration
- user login
- JWT-protected access
- agent API key access
- invalid/expired auth rejection
- principal type separation, user vs agent

Required tests:
- successful register and login
- invalid credentials rejected
- protected route without auth rejected
- agent-auth route accepts valid API key
- invalid API key rejected
- mixed-guard routes enforce correct actor type and permission

### B. Projects
Protect:
- project CRUD
- duplicate constraint handling
- project visibility and soft delete
- project membership enforcement

Required tests:
- create, list, get, update, delete
- duplicate slug/key rejected
- deleted project hidden from normal reads
- member vs non-member access on project-scoped endpoints
- admin bypass works correctly

### C. Tickets core CRUD
Protect:
- ticket creation
- filter behavior
- ticket retrieval
- ticket editing
- soft deletion

Required tests:
- create valid ticket
- invalid input rejected
- filter by status/type/priority/assignedTo/unassigned
- pagination behavior
- get by ref
- update editable fields
- soft-deleted ticket handling

### D. Ticket lifecycle state machine
This is the highest-value domain area.

Protect transitions:
- `CREATED -> VERIFIED`
- `VERIFIED -> IN_PROGRESS`
- `IN_PROGRESS -> VERIFY_FIX`
- `VERIFY_FIX -> CLOSED`
- `VERIFY_FIX -> IN_PROGRESS`
- rejection paths

Required tests:
- each valid transition succeeds
- invalid transitions fail with clear errors
- transition comments handled correctly
- role-based transition permissions enforced
- transition side effects visible in subsequent reads

### E. Assignment
Protect:
- assign
- unassign
- invalid assignment payloads
- reassignment behavior

Required tests:
- assign to valid user
- unassign successfully
- assigning both user and agent rejected if contract disallows it
- assigning nonexistent actor fails
- assignment reflected in list filters and detail reads

### F. Comments
Protect:
- add/list behavior
- ordering
- comment types
- transition-generated comment interactions

Required tests:
- add comment successfully
- invalid comment rejected
- list comments in correct order
- comment visibility after transitions

---

## 6.2 P1, important workflow coverage

### G. Labels
Protect:
- label CRUD
- color and name validation
- label assignment to tickets

Required tests:
- create/update/delete label
- invalid color rejected or normalized according to contract
- duplicate handling
- assign to ticket
- remove from ticket
- duplicate assignment behavior

### H. Ticket links
Protect:
- PR/branch/commit/url link creation
- deletion
- provider metadata behavior

Required tests:
- add each supported link type
- invalid URL rejected
- duplicate link behavior
- delete link
- PR metadata fields only where applicable

### I. Agents
Protect:
- agent creation and API key generation
- profile lookup
- role/capability updates
- key rotation
- pickup suggestion behavior

Required tests:
- create agent
- get current agent via API key
- update roles
- update capabilities
- rotate key invalidates previous key
- delete/soft delete behavior
- pickup endpoint success and missing project param failure

### J. Knowledge Base / RAG
Protect:
- document indexing
- document listing and deletion
- search behavior
- project membership enforcement
- optimize and graphify controls

Required tests:
- add document
- list documents
- delete by sourceId
- hybrid search returns expected structure
- unauthorized or non-member access rejected
- optimize admin-only behavior
- graphify import disabled path
- graphify import success path

### K. VCS integration
Protect:
- create/update/get/delete connection
- connection testing
- manual issue sync
- full sync
- PR sync
- encryption key config dependency

Required tests:
- create VCS connection
- update connection
- get connection without leaking token
- delete connection
- test connection success/failure
- sync single issue
- sync duplicate issue conflict path
- sync all issues summary behavior
- sync PR status summary behavior
- missing encryption key fails clearly

### L. Code intel / impact analysis
Protect:
- required param validation
- membership enforcement
- changedFiles parsing
- response contract

Required tests:
- missing query params rejected
- valid request succeeds
- non-member rejected
- invalid repo/commit failure path

---

## 6.3 P2, platform and resiliency

### M. Webhook / CI webhook / outbox
Protect:
- webhook validation
- event handling idempotency
- domain event fan-out
- CI update flows

### N. Monitoring
Protect:
- dashboard route health
- empty-state behavior
- response structure

### O. Memory and governance internals
Protect:
- project memory retrieval filters
- timeline ordering
- canonical-state consistency
- governance processor actions

---

## 7. Web regression test plan

## 7.1 P0, critical user-facing flows

### A. Authentication
Protect:
- login
- register
- auth redirects
- logout behavior

Required tests:
- login success
- login failure
- register success
- unauthenticated redirect for protected pages
- logout clears session state

### B. Project board
Protect:
- board load
- empty/loading/error states
- create ticket flow
- open ticket flow
- import issue entry point

Required tests:
- board fetch success
- loading and retry state
- create ticket dialog submit and refresh
- clicking ticket opens detail page

### C. Ticket detail page
This is the most important Web page.

Protect:
- render of title/status/priority/type/description
- edit ticket flow
- markdown display
- transition actions
- comments
- assignment
- labels
- links
- ticket deletion
- PR/VCS link rendering

Required tests:
- detail page renders complete ticket state
- edit and save
- comment add flow
- lifecycle actions update UI
- assign/unassign
- add/remove label
- add/remove link
- delete flow
- grouped PR/branch/commit sections render correctly

### D. Project settings + VCS settings
Protect:
- project metadata edit
- no-change submit behavior
- project delete flow
- VCS connection create/update/disconnect/test/sync

Required tests:
- edit and save project metadata
- delete project flow
- create VCS connection
- update VCS connection
- test connection
- sync now
- sync PR status
- disconnect connection
- token required on first create only

### E. KB page
Protect:
- search
- documents listing
- add/delete/optimize actions
- admin-only UX behavior

Required tests:
- search success
- search no results
- search failure toast
- documents list renders
- add document refreshes list
- delete document removes row
- optimize success and forbidden flows

---

## 7.2 P1, important supporting coverage

### F. Agents page
Protect:
- list rendering
- status update flow
- empty/loading/error states

Required tests:
- fetch and render agents
- status badge render
- status update success
- status update failure toast

### G. Labels page
Protect:
- label CRUD
- color picker behavior
- localized validation messages

Required tests:
- create label
- edit label
- delete label
- invalid color handling
- normalized color behavior where expected

### H. Navigation and layout
Protect:
- projects/home route behavior
- page layout consistency
- breadcrumb/sidebar stability

### I. I18n
Protect:
- locale switching
- parity between supported locales on critical screens
- localized validation and toast output

---

## 7.3 P2, hardening

### J. Accessibility smoke
Suggested checks:
- dialog focus handling
- keyboard navigation on main forms
- visible labels and buttons on critical pages

### K. SSR and hydration safety
Suggested checks:
- no auth redirect loops
- async pages hydrate correctly
- browser-only logic guarded

### L. Layout stability
Suggested checks:
- main pages do not visibly break under common states
- dialogs and badges remain usable

---

## 8. Contract validation findings

A specific goal of this review was to validate Web-to-API route assumptions.

## 8.1 Confirmed matching route areas
The following project-scoped areas are present in API and used by Web:
- labels
- ticket links
- KB
- VCS

These appear structurally aligned from source inspection.

## 8.2 Suspected mismatch, agents routes
A likely contract mismatch exists around **project-scoped agent routes**.

### Web usage observed
Web page source uses:
- `GET /projects/:slug/agents`
- `PATCH /projects/:slug/agents/:agentId`

### API controller reviewed
The API controller reviewed exposes top-level routes like:
- `/agents`
- `/agents/:slug`
- `/agents/:slug/update-roles`
- `/agents/:slug/update-capabilities`
- `/agents/:slug/rotate-key`
- `/agents/:slug/pickup?project=...`

### Validation result
From direct source inspection during this review, I did **not** find a matching `projects/:slug/agents` controller in `apps/api/src`.

This should be treated as a **regression-risk / contract-risk item** and validated during test execution.

### Important note
This document records the mismatch suspicion only. It does **not** propose fixing it yet, per request.

---

## 9. Recommended gap-focused additions

These are the highest-value tests to add next for regression safety.

## 9.1 API additions
1. Ticket lifecycle permission matrix E2E
2. Assignment conflict and reassignment E2E
3. Missing VCS encryption key failure-path test
4. Issue sync idempotency / duplicate-import conflict test
5. Membership enforcement tests for KB and code-intel endpoints
6. Soft-delete visibility cross-checks for project/ticket/agent/label

## 9.2 Web additions
1. Full ticket-detail workflow E2E
2. Project settings metadata save/delete E2E
3. KB admin vs non-admin action coverage
4. Agents page contract validation test against real backend
5. Web/API route parity test for project-scoped pages
6. Auth redirect and hydration smoke tests

---

## 10. Suggested execution order

## Phase 1, baseline confidence
Run and stabilize current suites:
- API unit tests
- API integration tests
- API E2E tests
- Web Jest tests
- Web Playwright smoke tests

## Phase 2, critical gap fill
Add:
- ticket lifecycle permission matrix
- full ticket detail regression flow
- project settings save/delete/VCS flow
- real route parity checks for Web-called endpoints

## Phase 3, workflow hardening
Add:
- KB permission coverage
- VCS duplicate sync/idempotency checks
- assignment edge cases
- labels edge cases
- agents route/behavior validation

## Phase 4, resilience and polish
Add:
- config-failure path coverage
- webhook and outbox hardening checks
- accessibility smoke
- hydration and layout stability checks

---

## 11. Regression matrix summary

| Area | API Unit | API E2E | Web Unit | Web E2E | Priority |
|:-----|:---------|:--------|:---------|:--------|:---------|
| Auth | Yes | Yes | Yes | Yes | P0 |
| Projects | Yes | Yes | Yes | Yes | P0 |
| Tickets CRUD | Yes | Yes | Yes | Yes | P0 |
| Ticket lifecycle | Yes | Yes | Yes | Yes | P0 |
| Comments | Yes | Yes | Yes | Yes | P0 |
| Assignment | Yes | Yes | Yes | Yes | P0 |
| Labels | Yes | Yes | Yes | Yes | P1 |
| Ticket links | Yes | Yes | Yes | Yes | P1 |
| Agents | Yes | Yes | Yes | Yes | P1 |
| KB / RAG | Yes | Yes | Yes | Yes | P1 |
| VCS | Yes | Yes | Yes | Yes | P1 |
| Code intel | Yes | Yes | Light | Light | P1 |
| Webhook / outbox | Yes | Yes | No | No | P2 |
| Monitoring | Yes | Light | No | No | P2 |
| Memory / governance | Yes | Light | No | No | P2 |

---

## 12. Final recommendation

Before running the formal regression campaign on `main`:
1. treat agent route parity as an explicit validation item
2. execute current automated suites first to establish the real baseline
3. prioritize ticket lifecycle, ticket detail, settings/VCS, and route parity gaps before expanding broader coverage
4. if unreleased feature branches are candidates for release, run a separate regression pass for those branches
