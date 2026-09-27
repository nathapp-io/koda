# Track 3 Slice 3 — Ticket Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user's write permissions inside a project come from their `ProjectMember.role` (#144). `close()` becomes an admin override that requires a reason. The API returns `allowedActions` and a resolved `assignee`. The web and CLI follow the API. Markdown render fallbacks and the sanitizer `class` hole are closed.

**Architecture:** `ProjectMembershipGuard` resolves the project and the caller's membership role once per request and attaches a `ProjectContext` to it. A new `@ProjectPermission` decorator is checked by that guard, using a CASL ability built from the principal plus its project role. It replaces `@RequiredPermission` on the ticket and label routes, because the global `PermissionAuthGuard` runs before any route guard and cannot see the project. `KodaCaslAbilityFactory` derives user permissions from `projectRole` when one is present. Controllers pass the role-enriched principal into services, so the service-level CASL checks (PATCH status delegation, comment update/delete) use the same rules.

**Tech Stack:** NestJS 10 + `@nathapp/nestjs-*` (auth/CASL, common, data), Prisma on Postgres, Jest (api, web, cli), Nuxt 3 + Vue 3 (web), Playwright (e2e), commander + `@hey-api/openapi-ts` generated client (cli).

**Spec:** `docs/superpowers/specs/2026-09-27-track-3-review-remediation-design.md`, section "Slice 3 — Ticket workflow" (amended for #144/#145 in PR #148, `26d2128f`).

**Branch:** `feat/track3-ticket-workflow` in the main checkout `repos/koda` (branched from `main` `26d2128f`). This does not depend on Slice 2a (`feat/track3-outbound-ssrf`), which is being developed at the same time in the worktree `repos/koda-slice2a`. The two slices touch different modules. Whichever merges second rebases; expect conflicts only in `openapi.json` / `apps/cli/src/generated/**` (regenerate them after the rebase, never hand-merge them).

---

## ⚠️ Shared test database — READ BEFORE ANY DB-BACKED COMMAND

The Slice 2a nax run (worktree `repos/koda-slice2a`, branch `feat/track3-outbound-ssrf`) may be running **at the same time as this plan** and uses the **same Postgres** as this checkout:

- Both checkouts' committed `apps/api/.env.test` point at `postgresql://koda:***@localhost:5433/koda_test` (the one `docker-compose.test.yml` container).
- `apps/api/test/global-setup.ts` runs `prisma db push --force-reset` against that database at the start of every DB-mode Jest run (`KODA_DB_TESTS=1`), and `test/helpers/reset-db.ts` truncates every table per file.
- In DB mode `.env.test` is loaded with `override: true`. **An exported `DATABASE_URL` does not redirect the run.** Do **not** edit `.env.test` to point elsewhere. It is a tracked file, and the change would ship in a commit.

If both runs hit the database at once, each wipes the other's data mid-test. Both then report false failures, and the nax run's gate verdicts become meaningless.

**Rules for every task in this plan:**

1. **Unit tests are always safe.** `cd apps/api && bun run test -- <path>` (the `test` script ignores `integration`/`e2e` paths and never sets `KODA_DB_TESTS`), web `bunx jest ...`, and cli `bunx jest ...` never touch a database.
2. **Before any DB-backed command**, check that Slice 2a is not running. DB-backed commands are `bun run test:integration`, `bun run test:scoped` on an `integration`/`e2e` path, and `bun run test:e2e`. Check with:
   ```bash
   pgrep -fl -f "koda-slice2a|track3-outbound-ssrf" || echo "slice 2a idle"
   ```
   If this prints any process, **do not run the DB-backed command**. Continue with unit-level work and tell the user that the DB step is waiting on the Slice 2a run. Never kill the other run.
3. **Never run `bun run test:db:down`**, and never restart the `5433` container, while Slice 2a may be active. `bun run test:db:up` is idempotent and safe.
4. **E2E** uses a different database (`koda_e2e`) and ports 3102/3103, which a concurrent 2a e2e run would also claim. Always run this plan's e2e with isolated overrides (the config and fixtures honour them):
   ```bash
   cd apps/web && E2E_DATABASE_URL=postgresql://koda:koda@localhost:5433/koda_slice3_e2e \
     E2E_API_PORT=3112 E2E_WEB_PORT=3113 E2E_API_URL=http://localhost:3112 \
     bunx playwright test <spec>
   ```
   (`prisma migrate reset` creates `koda_slice3_e2e` on first use.)
5. When reporting a DB-backed failure, first rule out a collision: re-run the Rule 2 check. If 2a became active during the run, the result is void. Re-run once 2a is idle.

---

## Global Constraints

- API stays single-instance. Postgres only. String-typed enum / JSON-as-String columns stay.
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok`, `AppException` subclasses (`ForbiddenAppException`, `NotFoundAppException`, `ValidationAppException`, `ConflictAppException` from `src/common/exceptions/conflict-app.exception`), repository → service → controller, outbox `record()` inside `txManager.run`.
- TDD for every task: failing test first, then implementation.
- DB-backed behaviour gets integration tests on real Postgres (`KODA_DB_TESTS=1`), subject to the shared-DB rules above.
- Contract changes regenerate `openapi.json` and the CLI client in the same PR (`bun run generate` at the repo root).
- All ten CI checks are required on `main` (`changes`, `lint`, `type-check`, `web build`, `policy-gates`, `test`, `integration`, `e2e`, `evaluate`, `smoke`).
- The role comes only from the `ProjectMember` row of the project being accessed. Never read it from the JWT, the request body, or a cached global value.
- Global ADMIN: everything, in every project. Agents: unchanged (global, agent-role derived; #61 / fleet S1). A user with no membership keeps no access (Slice 1 gate unchanged).
- The permission matrix (spec, verbatim):

| Capability | Project ADMIN | DEVELOPER | VIEWER |
|:--|:--|:--|:--|
| Read tickets, labels, comments | yes | yes | yes |
| Create ticket | yes | yes | no |
| Update ticket, assign | yes | yes | no |
| Transition (verify, start, fix, verify-fix, reject) | yes | yes | no |
| `close()` override (reason required) | yes | no | no |
| Delete ticket | yes | no | no |
| Create label | yes | yes | no |
| Update / delete label | yes | no | no |
| Assign / remove label on a ticket | yes | yes | no |
| Create comment; update/delete own | yes | yes | yes |
| Delete another user's comment | yes | no | no |
| KB writes (Slice 1 rule, unchanged) | yes | yes | no |
| Read CodeIntel | yes | yes | no |

- nax acceptance command (`.nax/mono/apps/api/config.json`) is `env KODA_DB_TESTS=1 npx jest --config jest.nax.config.js {{FILE}}`, cherry-picked from Slice 2a (`2079e9b8` -> `923f3c99` on this branch). nax shell-quotes each argv part, so a bare `KODA_DB_TESTS=1` prefix becomes a command name (sh exit 127). Never revert it to the bare prefix. In a plain shell (the commands in this plan) the bare prefix is fine.
- No emojis in code or comments. Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`). Keep files under 800 lines.

## Deviations from the spec (flag in the PR body)

1. **Services still take `slug`.** The spec says guarded services use `ProjectContext` "instead of re-resolving the slug". This plan resolves the **membership** once per request, which is what the spec's test asserts ("one membership query per request"). It does not change every ticket/label/comment service signature from `slug` to the project row, so the project row lookup by slug (a unique-index read) stays in the services. Doing that refactor as well would roughly double this slice's churn across ~100 KB of service specs. It is recorded as a #145 follow-up in the PR body.
2. **Read CodeIntel.** The ability factory implements the row (ADMIN/DEVELOPER yes, VIEWER no), with unit tests. The `code-intel/*` routes take the project from a `projectSlug` query parameter, not a `:slug` route parameter, so `ProjectMembershipGuard` never runs on them and they keep today's global-role check. `GET projects/:slug/codeintel/impact` is also left unchanged. Wiring the code-intel routes belongs with Slice 4 (VCS & code-intel) and goes in the PR body as a follow-up.
3. **Ticket-label assign/remove and agents.** Today these routes carry no permission, so any agent member can use them. The spec gives them `@ProjectPermission([UPDATE, 'Ticket'])` and says "agents are evaluated exactly as today". Taken literally, the decorator would newly refuse every agent without the TRIAGER role. This plan adds `{ exemptAgents: true }` on those two routes only, which keeps agent behaviour unchanged.
4. **Members page `viewerRole`.** The web needs the caller's project role to show assign/label controls to a DEVELOPER, and a list page can put the caller's own row on a later page. `GET projects/:slug/members` therefore returns `viewerRole` next to the existing `canManage`, computed server-side from the same single membership read.
5. **Integration role matrix in a new file.** `project-membership-gate.integration.spec.ts` is 609 lines, and its matrix mutates shared fixtures. The role replay goes into a new `project-role-permissions.integration.spec.ts`, and the old file's header drops its waiver-rationale paragraph (lines 15-23, the global-ADMIN `adminMember` workaround).

## Review Focus

1. **A `@ProjectPermission` route without `:slug` must fail closed.** The guard returns `true` early when `params.slug` is absent. A route decorated with `@ProjectPermission` but lacking a slug would skip the check entirely. Task 2 makes the guard throw 403 in that case and pins it with a test.
2. **Legacy or unrecognised membership roles.** `ProjectMember.role` is a free `String`. Rows with `AGENT`/`MEMBER` can exist from before `PROJECT_MEMBER_ROLES` narrowed the DTO. They must get VIEWER-level (least) rights, never DEVELOPER or ADMIN. Task 1 pins it.
3. **A user who is ADMIN in project A and VIEWER in project B.** Rights must follow the project in the URL. Rights never come from a JWT claim or a previous request. Task 13 pins both, including a forged `projectRole` claim.
4. **Close dialog with an empty or whitespace reason.** The web must not send `{}` and the API must answer 400, not close the ticket. Task 7 (API) and Task 11 (web Confirm disabled) pin it.
5. **A user-authored description containing `class="fixed inset-0"` (overlay/clickjacking).** It must render without the class, while fenced code keeps `language-*`. The real DOMPurify cannot load under the web Jest config (jsdom ESM), so Task 12 unit-tests the pure predicate and Task 14 asserts the real rendered DOM in e2e.

---

## File Structure

**API (`apps/api/src`)**

| File | Responsibility |
|:--|:--|
| `auth/casl/koda-casl-ability.factory.ts` (modify) | Derive user permissions from `projectRole` when present |
| `projects/project-context.ts` (create) | `ProjectContext`, `ProjectScopedRequest`, `withProjectRole()` |
| `projects/project-permission.decorator.ts` (create) | `@ProjectPermission(permission, { exemptAgents })` + metadata key |
| `projects/current-project.decorator.ts` (create) | `@CurrentProject()` param decorator reading `request.projectContext` |
| `projects/project-access.service.ts` (modify) | `resolveMembership()` returns the role; `assertProjectMembership` delegates |
| `projects/project-membership.guard.ts` (modify) | Resolve once, attach context, enforce `@ProjectRoles` + `@ProjectPermission` |
| `projects/project-access.module.ts` (modify) | Provide `KodaCaslAbilityFactory` to the guard |
| `projects/project-roles.decorator.ts` (modify) | Doc comment only (the old "tickets use no role" note is now wrong) |
| `projects/members/project-members.service.ts`, `.controller.ts` (modify) | `viewerRole` on the list page |
| `tickets/tickets.controller.ts` (modify) | `@ProjectPermission`, enriched principal, close reason, detail with actions |
| `tickets/tickets.service.ts` (modify) | `findByRefWithActions()` |
| `tickets/state-machine/ticket-transitions.ts` (modify) | Export `TRANSITION_RULES` |
| `tickets/state-machine/allowed-actions.ts` (create) | `TicketAction`, `allowedActions()`, `canOverrideClose()` |
| `tickets/state-machine/ticket-transitions.service.ts` (modify) | `close()` with reason comment + COMMENT_ADDED |
| `tickets/dto/ticket-response.dto.ts` (modify) | `assignee` |
| `tickets/dto/ticket-detail-response.dto.ts` (create) | `TicketDetailResponseDto` = response + `allowedActions` |
| `tickets/domain/ticket.domain.ts` (modify) | `TicketAssignee`, `TicketDomain.assignee` |
| `tickets/prisma-tickets.repository.ts` (modify) | Shared `TICKET_INCLUDE` with name-only assignee selects |
| `labels/labels.controller.ts` (modify) | `@ProjectPermission` per label capability |
| `comments/comments.service.ts` (modify) | Enrich principal with the comment's project role |

**API tests:** co-located `*.spec.ts` as listed per task. New integration spec: `apps/api/test/integration/projects/project-role-permissions.integration.spec.ts`.

**Web (`apps/web`)**

| File | Responsibility |
|:--|:--|
| `components/TicketActionPanel.vue` (modify) | Render only from `ticket.allowedActions`; every commented action opens the dialog |
| `pages/[project]/tickets/[ref].vue` (modify) | Assignee type; role-based visibility; escaped render fallback |
| `pages/[project]/labels.vue` (modify) | Hide edit/delete unless project ADMIN, hide create for VIEWER |
| `components/TicketCard.vue`, `components/TicketBoard.vue` (modify) | Assignee type |
| `composables/useProjectMembers.ts` (modify) | Expose `viewerRole` |
| `lib/markdown.ts` (modify) | `renderMarkdownOrEscape()`, `escapeHtml()`, `keepClassAttribute()` hook |
| `components/MarkdownEditor.vue` (modify) | Use the escaped fallback |
| `i18n/locales/en.json`, `zh.json` (modify) | `tickets.actions.closeReasonTitle` |

**CLI:** `apps/cli/src/commands/ticket.ts`, `apps/cli/src/commands/ticket.spec.ts`, regenerated `apps/cli/src/generated/**`. **Root:** `openapi.json`.

**E2E:** `apps/web/tests/e2e/ticket-project-roles.spec.ts` (create), `apps/web/tests/e2e/ticket-detail-operations.e2e.spec.ts` and `ticket-lifecycle.spec.ts` (modify).

---

### Task 1: Ability factory derives user permissions from the project role

**Files:**
- Modify: `apps/api/src/auth/casl/koda-casl-ability.factory.ts`
- Test: `apps/api/src/auth/casl/koda-casl-ability.factory.spec.ts`

**Interfaces:**
- Consumes: `UserPrincipal.projectRole?: string` (already declared in `auth/principal/koda-principal.types.ts:14`, never set today).
- Produces: `KodaCaslAbilityFactory.createForUser({ ...user, projectRole })` returns the matrix above. With `projectRole` undefined, a non-admin user keeps today's global set. Tasks 2, 5, 7 and 8 rely on this.

- [ ] **Step 1: Write the failing table test**

Append to `koda-casl-ability.factory.spec.ts` (reuse the file's `makeUser` / `makeAgent` helpers):

```ts
import { subject } from '@casl/ability';
import { KodaAction } from './koda-action.enum';

describe('project-role permissions (#144)', () => {
  const factory = new KodaCaslAbilityFactory();
  const A = CaslPermissionAction;
  const T = KodaAction.TRANSITION as CaslPermissionAction;
  const U = KodaAction.UPDATE as CaslPermissionAction;

  type Row = [label: string, action: CaslPermissionAction, subjectType: string, admin: boolean, dev: boolean, viewer: boolean];
  const rows: Row[] = [
    ['read ticket', A.READ, 'Ticket', true, true, true],
    ['read label', A.READ, 'Label', true, true, true],
    ['read comment', A.READ, 'Comment', true, true, true],
    ['create ticket', A.CREATE, 'Ticket', true, true, false],
    ['update ticket', U, 'Ticket', true, true, false],
    ['transition ticket', T, 'Ticket', true, true, false],
    ['delete ticket', A.DELETE, 'Ticket', true, false, false],
    ['create label', A.CREATE, 'Label', true, true, false],
    ['update label', A.UPDATE, 'Label', true, false, false],
    ['delete label', A.DELETE, 'Label', true, false, false],
    ['create comment', A.CREATE, 'Comment', true, true, true],
    ['read code-intel', A.READ, 'CodeIntel', true, true, false],
  ];

  it.each(rows)('%s: ADMIN=%s DEVELOPER=%s VIEWER=%s', async (_label, action, subjectType, admin, dev, viewer) => {
    for (const [projectRole, expected] of [['ADMIN', admin], ['DEVELOPER', dev], ['VIEWER', viewer]] as const) {
      const ability = await factory.createForUser(makeUser({ projectRole }));
      expect({ projectRole, can: ability.can(action, subjectType) }).toEqual({ projectRole, can: expected });
    }
  });

  it('own comments: every project role may update and delete its own comment', async () => {
    for (const projectRole of ['ADMIN', 'DEVELOPER', 'VIEWER']) {
      const ability = await factory.createForUser(makeUser({ id: 'u1', projectRole }));
      const own = subject('Comment', { authorUserId: 'u1' });
      expect(ability.can(A.UPDATE, own)).toBe(true);
      expect(ability.can(A.DELETE, own)).toBe(true);
    }
  });

  it("another user's comment: only project ADMIN may delete it, nobody may edit it", async () => {
    const other = subject('Comment', { authorUserId: 'someone-else' });
    const admin = await factory.createForUser(makeUser({ id: 'u1', projectRole: 'ADMIN' }));
    const dev = await factory.createForUser(makeUser({ id: 'u1', projectRole: 'DEVELOPER' }));
    const viewer = await factory.createForUser(makeUser({ id: 'u1', projectRole: 'VIEWER' }));
    expect(admin.can(A.DELETE, other)).toBe(true);
    expect(admin.can(A.UPDATE, other)).toBe(false);
    expect(dev.can(A.DELETE, other)).toBe(false);
    expect(viewer.can(A.DELETE, other)).toBe(false);
  });

  it('an unrecognised legacy project role (AGENT, MEMBER, garbage) gets VIEWER rights only', async () => {
    for (const projectRole of ['AGENT', 'MEMBER', 'owner', '']) {
      const ability = await factory.createForUser(makeUser({ projectRole }));
      expect(ability.can(A.READ, 'Ticket')).toBe(true);
      expect(ability.can(A.CREATE, 'Ticket')).toBe(false);
      expect(ability.can(T, 'Ticket')).toBe(false);
      expect(ability.can(A.CREATE, 'Label')).toBe(false);
    }
  });

  it('no project role (route outside a project): a global MEMBER keeps today\'s global set', async () => {
    const ability = await factory.createForUser(makeUser());
    expect(ability.can(A.CREATE, 'Ticket')).toBe(true);
    expect(ability.can(T, 'Ticket')).toBe(false);
    expect(ability.can(A.READ, 'CodeIntel')).toBe(false);
  });

  it('global ADMIN is unaffected by a lower project role', async () => {
    const ability = await factory.createForUser(makeUser({ role: 'ADMIN', projectRole: 'VIEWER' }));
    expect(ability.can(A.DELETE, 'Ticket')).toBe(true);
    expect(ability.can(A.DELETE, 'Label')).toBe(true);
  });

  it('agents ignore projectRole entirely', async () => {
    const agent = { ...makeAgent({ agentRoles: ['REVIEWER'] }), projectRole: 'ADMIN' } as unknown as AgentPrincipal;
    const ability = await factory.createForUser(agent);
    expect(ability.can(T, 'Ticket')).toBe(true);
    expect(ability.can(U, 'Ticket')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && bun run test -- src/auth/casl/koda-casl-ability.factory.spec.ts`
Expected: FAIL. `update ticket` / `transition ticket` / `create label` are false for DEVELOPER, `delete ticket` is false for ADMIN, and `create ticket` is true for VIEWER.

- [ ] **Step 3: Implement**

In `koda-casl-ability.factory.ts` (existing imports suffice), replace `userPermissions` and add `projectRolePermissions` + `ownCommentPermissions`:

```ts
  private userPermissions(principal: UserPrincipal): CaslPermission[] {
    if (principal.role === 'ADMIN') {
      return [
        ...KodaCaslAbilityFactory.ADMIN_MANAGEABLE_RESOURCES.map(
          (subject) => ({ action: CaslPermissionAction.MANAGE, subject }),
        ),
        { action: CaslPermissionAction.READ, subject: 'CodeIntel' },
        { action: KodaAction.IMPORT as CaslPermissionAction, subject: 'CodeIntel' },
        { action: CaslPermissionAction.MANAGE, subject: 'AstIndex' },
      ];
    }
    // #144: inside a project (ProjectMembershipGuard attached the role) the
    // ProjectMember.role decides; outside one the global MEMBER set applies.
    if (principal.projectRole !== undefined) {
      return this.projectRolePermissions(principal);
    }
    return [
      ...this.ownCommentPermissions(principal),
      { action: CaslPermissionAction.CREATE, subject: 'Ticket' },
    ];
  }

  /**
   * #144 permission matrix. VIEWER and any unrecognised legacy role (AGENT,
   * MEMBER rows written before PROJECT_MEMBER_ROLES narrowed) get the
   * least-privileged set.
   */
  private projectRolePermissions(principal: UserPrincipal): CaslPermission[] {
    const base = this.ownCommentPermissions(principal);
    switch (principal.projectRole) {
      case 'ADMIN':
        return [
          ...base,
          { action: CaslPermissionAction.MANAGE, subject: 'Ticket' },
          { action: CaslPermissionAction.MANAGE, subject: 'Label' },
          // Delete any comment in the project; editing stays author-only.
          { action: CaslPermissionAction.DELETE, subject: 'Comment' },
          { action: CaslPermissionAction.READ, subject: 'CodeIntel' },
        ];
      case 'DEVELOPER':
        return [
          ...base,
          { action: CaslPermissionAction.CREATE, subject: 'Ticket' },
          { action: KodaAction.UPDATE as CaslPermissionAction, subject: 'Ticket' },
          { action: KodaAction.TRANSITION as CaslPermissionAction, subject: 'Ticket' },
          { action: CaslPermissionAction.CREATE, subject: 'Label' },
          { action: CaslPermissionAction.READ, subject: 'CodeIntel' },
        ];
      default:
        return base;
    }
  }

  /** Read everything readable, comment, and edit/delete one's own comments. */
  private ownCommentPermissions(principal: UserPrincipal): CaslPermission[] {
    return [
      ...this.readPermissions(),
      { action: CaslPermissionAction.CREATE, subject: 'Comment' },
      { action: CaslPermissionAction.UPDATE, subject: 'Comment', conditions: { authorUserId: principal.id } },
      { action: CaslPermissionAction.DELETE, subject: 'Comment', conditions: { authorUserId: principal.id } },
      { action: KodaAction.IMPORT as CaslPermissionAction, subject: 'CodeIntel' },
    ];
  }
```

This deletes the old dead `projectRole === 'DEVELOPER'` push. Its replacement is the DEVELOPER case above.

- [ ] **Step 4: Run the whole factory spec and confirm it passes**

Run: `cd apps/api && bun run test -- src/auth/casl/koda-casl-ability.factory.spec.ts`
Expected: PASS, including every pre-existing test. If a pre-existing test asserted the old dead `projectRole: 'DEVELOPER'` → `READ CodeIntel` branch, it still passes, because DEVELOPER has READ CodeIntel.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/casl/koda-casl-ability.factory.ts apps/api/src/auth/casl/koda-casl-ability.factory.spec.ts
git commit -m "feat(auth): derive user permissions from the project role (#144)"
```

---

### Task 2: Resolve membership once; `ProjectContext`, `@ProjectPermission`, `@CurrentProject`

**Files:**
- Create: `apps/api/src/projects/project-context.ts`
- Create: `apps/api/src/projects/project-permission.decorator.ts`
- Create: `apps/api/src/projects/current-project.decorator.ts`
- Modify: `apps/api/src/projects/project-access.service.ts`
- Modify: `apps/api/src/projects/project-membership.guard.ts`
- Modify: `apps/api/src/projects/project-access.module.ts`
- Modify: `apps/api/src/projects/project-roles.decorator.ts` (doc comment)
- Test: `apps/api/src/projects/project-access.service.spec.ts`, `apps/api/src/projects/project-membership.guard.spec.ts`, new `apps/api/src/projects/project-context.spec.ts`

**Interfaces:**
- Consumes: Task 1's factory.
- Produces:
  ```ts
  // project-context.ts
  export interface ProjectContext { project: { id: string; slug: string }; role: string | null }
  export interface ProjectScopedRequest { params?: { slug?: string }; user?: KodaPrincipal; projectContext?: ProjectContext }
  export function withProjectRole(principal: KodaPrincipal, role: string | null): KodaPrincipal
  // project-permission.decorator.ts
  export const PROJECT_PERMISSION_KEY = 'koda:projectPermission';
  export type ProjectPermissionTuple = [CaslPermissionAction, string];
  export interface ProjectPermissionMetadata { permission: ProjectPermissionTuple; exemptAgents: boolean }
  export const ProjectPermission: (permission: ProjectPermissionTuple, opts?: { exemptAgents?: boolean }) => CustomDecorator
  // current-project.decorator.ts
  export const CurrentProject: () => ParameterDecorator   // yields ProjectContext
  // project-access.service.ts
  resolveMembership(projectId: string, principal: KodaPrincipal): Promise<string | null>
  ```
  `role` is `'ADMIN'` for a global ADMIN user, `null` for an agent, and otherwise the raw `ProjectMember.role` of a member. A non-member user gets a 403 `ForbiddenAppException('projects')`.

- [ ] **Step 1: Write failing tests for `withProjectRole` and `resolveMembership`**

Create `apps/api/src/projects/project-context.spec.ts`:

```ts
import { withProjectRole } from './project-context';
import type { AgentPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

const user: UserPrincipal = {
  actorType: 'user', id: 'u1', name: 'u1', email: 'u1@x', role: 'MEMBER',
  blacklisted: false, revoked: false, authorities: ['MEMBER'],
};
const agent: AgentPrincipal = {
  actorType: 'agent', id: 'a1', name: 'bot', slug: 'bot', status: 'ACTIVE',
  agentRoles: ['DEVELOPER'], capabilities: [], blacklisted: false, revoked: false, authorities: ['WORKER'],
};

describe('withProjectRole', () => {
  it('returns a new user principal carrying the project role, without mutating the input', () => {
    const enriched = withProjectRole(user, 'DEVELOPER');
    expect(enriched).toEqual({ ...user, projectRole: 'DEVELOPER' });
    expect(enriched).not.toBe(user);
    expect(user).not.toHaveProperty('projectRole');
  });

  it('overrides a projectRole already present on the input (never trusts a prior value)', () => {
    expect(withProjectRole({ ...user, projectRole: 'ADMIN' }, 'VIEWER')).toEqual({ ...user, projectRole: 'VIEWER' });
  });

  it('returns agents unchanged', () => {
    expect(withProjectRole(agent, 'ADMIN')).toBe(agent);
  });

  it('returns the user unchanged when there is no role (route outside a project)', () => {
    expect(withProjectRole(user, null)).toBe(user);
  });
});
```

Append to `project-access.service.spec.ts`. Reuse its existing `service`, repo stub, `memberUser`, `adminUser` and `agentPrincipal`. Check the stub's variable name at the top of the file and use it where this plan writes `repo`:

```ts
  describe('resolveMembership', () => {
    it('returns ADMIN for a global ADMIN without a membership lookup', async () => {
      await expect(service.resolveMembership('p1', adminUser)).resolves.toBe('ADMIN');
      expect(repo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('returns null for an agent without a membership lookup', async () => {
      await expect(service.resolveMembership('p1', agentPrincipal)).resolves.toBeNull();
      expect(repo.findMembershipRole).not.toHaveBeenCalled();
    });

    it('returns the member row role with exactly one lookup', async () => {
      repo.findMembershipRole.mockResolvedValue('VIEWER');
      await expect(service.resolveMembership('p1', memberUser)).resolves.toBe('VIEWER');
      expect(repo.findMembershipRole).toHaveBeenCalledTimes(1);
    });

    it('throws ForbiddenAppException for a non-member', async () => {
      repo.findMembershipRole.mockResolvedValue(null);
      await expect(service.resolveMembership('p1', memberUser)).rejects.toBeInstanceOf(ForbiddenAppException);
    });
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/api && bun run test -- src/projects/project-context.spec.ts src/projects/project-access.service.spec.ts`
Expected: FAIL. `Cannot find module './project-context'` and `service.resolveMembership is not a function`.

- [ ] **Step 3: Implement `project-context.ts` and `resolveMembership`**

Create `apps/api/src/projects/project-context.ts`:

```ts
import { KodaPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';

/**
 * Attached to the request by ProjectMembershipGuard after it resolved the
 * `:slug` project and the caller's membership once (#145, guard half).
 * `role` is 'ADMIN' for a global ADMIN, null for an agent (agents never use
 * project roles), otherwise the caller's raw ProjectMember.role.
 */
export interface ProjectContext {
  project: { id: string; slug: string };
  role: string | null;
}

export interface ProjectScopedRequest {
  params?: { slug?: string };
  user?: KodaPrincipal;
  projectContext?: ProjectContext;
}

/**
 * #144: the principal a project-scoped CASL check must use. Returns a new user
 * principal whose projectRole is the resolved membership role; agents and
 * role-less calls pass through unchanged.
 */
export function withProjectRole(principal: KodaPrincipal, role: string | null): KodaPrincipal {
  if (!isUserPrincipal(principal) || role === null) return principal;
  return { ...principal, projectRole: role };
}
```

In `project-access.service.ts`, add `resolveMembership` and make `assertProjectMembership` delegate to it. Keep the method: the RAG, retrieval, code-intel and members call sites use it.

```ts
  /**
   * Resolves the caller's role in a project with at most one query.
   * Global ADMIN -> 'ADMIN' (no query); agent -> null (no query); member ->
   * their ProjectMember.role; non-member user -> 403.
   */
  async resolveMembership(projectId: string, principal: KodaPrincipal): Promise<string | null> {
    if (!isUserPrincipal(principal)) return null;
    if (principal.role === 'ADMIN') return ActorRole.ADMIN;
    const role = await this.projectRepo.findMembershipRole(projectId, principal.id);
    const allowed = [ActorRole.ADMIN, ActorRole.DEVELOPER, ActorRole.AGENT, ActorRole.VIEWER] as const;
    if (!role || !allowed.includes(role as typeof allowed[number])) {
      throw new ForbiddenAppException({}, 'projects');
    }
    return role;
  }

  async assertProjectMembership(projectId: string, principal: KodaPrincipal): Promise<void> {
    await this.resolveMembership(projectId, principal);
  }
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd apps/api && bun run test -- src/projects/project-context.spec.ts src/projects/project-access.service.spec.ts`
Expected: PASS (the pre-existing `assertProjectMembership` tests still pass).

- [ ] **Step 5: Write failing guard tests**

Append to `project-membership.guard.spec.ts`. Reuse its helpers: `makeExecutionContext(request, handler, controller)`, the repo stub built in its `beforeEach` (with `findBySlug` / `findMembershipRole`), and `memberUser` / `adminUser` / `agentPrincipal`. Read the file's `beforeEach` first. Where this plan writes `repo`, `access`, `reflector` and `guard`, use the file's own variable names, and construct the guard with the factory as the third argument:

```ts
import { CaslPermissionAction } from '@nathapp/nestjs-auth';
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';
import { KodaAction } from '../auth/casl/koda-action.enum';
import { ProjectPermission } from './project-permission.decorator';

class TicketRoutesStub {
  @ProjectPermission([KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'])
  transition(): string { return 'ok'; }

  @ProjectPermission([CaslPermissionAction.DELETE, 'Ticket'])
  remove(): string { return 'ok'; }

  @ProjectPermission([KodaAction.UPDATE as CaslPermissionAction, 'Ticket'], { exemptAgents: true })
  assignLabel(): string { return 'ok'; }
}
const routes = new TicketRoutesStub();

describe('ProjectMembershipGuard - ProjectContext and @ProjectPermission (#144/#145)', () => {
  let guardWithCasl: ProjectMembershipGuard;

  beforeEach(() => {
    guardWithCasl = new ProjectMembershipGuard(access, new Reflector(), new KodaCaslAbilityFactory());
    repo.findBySlug.mockResolvedValue({ id: 'p1', slug: 'team', deletedAt: null });
  });

  it('attaches ProjectContext with the membership role, querying membership exactly once', async () => {
    repo.findMembershipRole.mockResolvedValue('DEVELOPER');
    const req: Record<string, unknown> = { params: { slug: 'team' }, user: memberUser };
    await expect(guardWithCasl.canActivate(makeExecutionContext(req, routes.transition, TicketRoutesStub))).resolves.toBe(true);
    expect(req.projectContext).toEqual({ project: { id: 'p1', slug: 'team' }, role: 'DEVELOPER' });
    expect(repo.findMembershipRole).toHaveBeenCalledTimes(1);
  });

  it('refuses a VIEWER on a TRANSITION route before the handler runs', async () => {
    repo.findMembershipRole.mockResolvedValue('VIEWER');
    const req = { params: { slug: 'team' }, user: memberUser };
    await expect(guardWithCasl.canActivate(makeExecutionContext(req, routes.transition, TicketRoutesStub)))
      .rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('refuses a DEVELOPER on DELETE Ticket and allows a project ADMIN', async () => {
    repo.findMembershipRole.mockResolvedValueOnce('DEVELOPER').mockResolvedValueOnce('ADMIN');
    const ctx = () => makeExecutionContext({ params: { slug: 'team' }, user: memberUser }, routes.remove, TicketRoutesStub);
    await expect(guardWithCasl.canActivate(ctx())).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(guardWithCasl.canActivate(ctx())).resolves.toBe(true);
  });

  it('evaluates agents with their agent-role ability, exactly as @RequiredPermission did', async () => {
    const reviewer = { ...agentPrincipal, agentRoles: ['REVIEWER'] as const };
    const noTransition = { ...agentPrincipal, agentRoles: ['TRIAGER'] as const };
    await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: reviewer }, routes.transition, TicketRoutesStub))).resolves.toBe(true);
    await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: noTransition }, routes.transition, TicketRoutesStub)))
      .rejects.toBeInstanceOf(ForbiddenAppException);
    expect(repo.findMembershipRole).not.toHaveBeenCalled();
  });

  it('exemptAgents skips the permission for agents but still enforces it for users', async () => {
    const triager = { ...agentPrincipal, agentRoles: [] as const };
    await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: triager }, routes.assignLabel, TicketRoutesStub))).resolves.toBe(true);
    repo.findMembershipRole.mockResolvedValue('VIEWER');
    await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: memberUser }, routes.assignLabel, TicketRoutesStub)))
      .rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('fails closed when a @ProjectPermission route has no :slug param', async () => {
    await expect(guardWithCasl.canActivate(makeExecutionContext({ params: {}, user: memberUser }, routes.transition, TicketRoutesStub)))
      .rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('fails closed on a @ProjectPermission route when no ability factory is wired', async () => {
    const bare = new ProjectMembershipGuard(access, new Reflector());
    repo.findMembershipRole.mockResolvedValue('ADMIN');
    await expect(bare.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: memberUser }, routes.transition, TicketRoutesStub)))
      .rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('ignores a projectRole already on the principal (e.g. a forged claim)', async () => {
    repo.findMembershipRole.mockResolvedValue('VIEWER');
    const forged = { ...memberUser, projectRole: 'ADMIN' };
    await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: forged }, routes.remove, TicketRoutesStub)))
      .rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('a @ProjectRoles route reads the resolved role without a second membership query', async () => {
    repo.findMembershipRole.mockResolvedValue('DEVELOPER');
    const kb = new KbWriteRouteStub();
    await expect(guardWithCasl.canActivate(makeExecutionContext({ params: { slug: 'team' }, user: memberUser }, kb.addDocument, KbWriteRouteStub))).resolves.toBe(true);
    expect(repo.findMembershipRole).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run and confirm failure**

Run: `cd apps/api && bun run test -- src/projects/project-membership.guard.spec.ts`
Expected: FAIL. `Cannot find module './project-permission.decorator'`.

- [ ] **Step 7: Implement the decorators, guard and module wiring**

Create `apps/api/src/projects/project-permission.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';
import type { CaslPermissionAction } from '@nathapp/nestjs-auth';

/**
 * #144: a project-scoped permission. Checked by ProjectMembershipGuard after it
 * resolved the caller's project role, with an ability built from
 * `{ ...principal, projectRole }`. Replaces @RequiredPermission on project
 * routes: the global PermissionAuthGuard runs before any route guard and has no
 * project context (nestjs-auth 3.3.0 permission.provider.js:70).
 *
 * `exemptAgents` keeps a route's pre-existing agent behaviour when the route
 * carried no permission before (ticket-label assign/remove).
 */
export const PROJECT_PERMISSION_KEY = 'koda:projectPermission';

export type ProjectPermissionTuple = [CaslPermissionAction, string];

export interface ProjectPermissionMetadata {
  permission: ProjectPermissionTuple;
  exemptAgents: boolean;
}

export const ProjectPermission = (
  permission: ProjectPermissionTuple,
  opts: { exemptAgents?: boolean } = {},
) =>
  SetMetadata<string, ProjectPermissionMetadata>(PROJECT_PERMISSION_KEY, {
    permission,
    exemptAgents: opts.exemptAgents ?? false,
  });
```

Create `apps/api/src/projects/current-project.decorator.ts`:

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { ProjectContext, ProjectScopedRequest } from './project-context';

/**
 * The ProjectContext ProjectMembershipGuard attached. Throws (fail closed) if a
 * handler reads it on a route the guard did not resolve.
 */
export const CurrentProject = createParamDecorator((_data: unknown, ctx: ExecutionContext): ProjectContext => {
  const req = ctx.switchToHttp().getRequest<ProjectScopedRequest>();
  if (!req.projectContext) throw new ForbiddenAppException({}, 'projects');
  return req.projectContext;
});
```

Replace `apps/api/src/projects/project-membership.guard.ts` with:

```ts
import { CanActivate, ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { ProjectAccessService } from './project-access.service';
import { PROJECT_ROLES_KEY } from './project-roles.decorator';
import { PROJECT_PERMISSION_KEY, ProjectPermissionMetadata } from './project-permission.decorator';
import { ProjectScopedRequest, withProjectRole } from './project-context';
import { KodaPrincipal, isAgentPrincipal, isUserPrincipal } from '../auth/principal/koda-principal.types';
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';

/**
 * Guards project-scoped routes by `params.slug`.
 *
 * Flow:
 *  1. No `slug` param: return true (sibling guards handle it), unless the route
 *     carries @ProjectPermission, which fails closed.
 *  2. Resolve the project (404 if missing or soft-deleted) and the caller's
 *     membership role ONCE (403 for a non-member user; global ADMIN -> 'ADMIN',
 *     agent -> null, no query for either).
 *  3. Attach `request.projectContext` for @CurrentProject() (#145, guard half).
 *  4. @ProjectRoles(...): refuse a non-admin user whose role is not listed.
 *  5. @ProjectPermission(...): check it against the ability for
 *     `{ ...principal, projectRole }` (#144). Agents are evaluated with their
 *     agent-role ability unless the route exempts them.
 */
@Injectable()
export class ProjectMembershipGuard implements CanActivate {
  constructor(
    private readonly access: ProjectAccessService,
    private readonly reflector: Reflector,
    @Optional() private readonly caslAbilityFactory?: KodaCaslAbilityFactory,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ProjectScopedRequest>();
    const permission = this.reflector.getAllAndOverride<ProjectPermissionMetadata | undefined>(
      PROJECT_PERMISSION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    const slug = req.params?.slug;
    if (!slug) {
      if (permission) throw new ForbiddenAppException({}, 'projects');
      return true;
    }

    if (!req.user) throw new ForbiddenAppException({}, 'projects');

    const projectId = await this.access.findProjectIdBySlug(slug);
    const role = await this.access.resolveMembership(projectId, req.user);
    req.projectContext = { project: { id: projectId, slug }, role };

    this.assertProjectRoles(ctx, req.user, role);
    if (permission) await this.assertProjectPermission(permission, req.user, role);
    return true;
  }

  private assertProjectRoles(ctx: ExecutionContext, user: KodaPrincipal, role: string | null): void {
    const roles = this.reflector.getAllAndOverride<string[]>(PROJECT_ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles?.length || !isUserPrincipal(user) || user.role === 'ADMIN') return;
    if (!role || !roles.includes(role)) throw new ForbiddenAppException({}, 'projects');
  }

  private async assertProjectPermission(
    meta: ProjectPermissionMetadata,
    user: KodaPrincipal,
    role: string | null,
  ): Promise<void> {
    if (meta.exemptAgents && isAgentPrincipal(user)) return;
    if (!this.caslAbilityFactory) throw new ForbiddenAppException({}, 'projects');
    const ability = await this.caslAbilityFactory.createForUser(withProjectRole(user, role));
    const [action, subject] = meta.permission;
    if (!ability.can(action, subject)) throw new ForbiddenAppException({}, 'projects');
  }
}
```

In `project-access.module.ts`, add `KodaCaslAbilityFactory` to `providers` (it has no constructor dependencies) so the guard can inject it wherever `ProjectAccessModule` is imported:

```ts
import { KodaCaslAbilityFactory } from '../auth/casl/koda-casl-ability.factory';
// ...
  providers: [
    ProjectAccessService,
    PrismaProjectRepository,
    { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository },
    KodaCaslAbilityFactory,
    ProjectMembershipGuard,
  ],
```

In `project-roles.decorator.ts`, replace the paragraph beginning "Tickets, comments and labels intentionally do not use this decorator" with:

```ts
 * KB write routes carry `@ProjectRoles('ADMIN', 'DEVELOPER', 'AGENT')` to refuse
 * a project VIEWER. Ticket and label routes use `@ProjectPermission` instead
 * (#144): their rules are CASL permissions derived from the project role.
```

- [ ] **Step 8: Run the project specs and the whole api unit suite**

Run: `cd apps/api && bun run test -- src/projects`
Expected: PASS.

Then run: `cd apps/api && bun run test`
Expected: PASS. If a spec that builds `ProjectMembershipGuard` in a `TestingModule` fails with a Nest dependency error, add `KodaCaslAbilityFactory` to that module's `providers`. The affected specs are `labels.controller.spec.ts`, `tickets.controller.spec.ts`, `comments.controller.spec.ts`, `projects.controller.spec.ts`, `rag.controller.spec.ts`, `retrieval.controller.spec.ts`, `memory.module.spec.ts`, `projects.module.spec.ts`, `kb-documents-membership.routes.spec.ts`, `retrieval-membership.routes.spec.ts` and `project-membership.guard.routes.spec.ts`. The factory is `@Optional()`, so a module that does not provide it still compiles; only routes with `@ProjectPermission` need it.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src
git commit -m "feat(projects): resolve membership once and check @ProjectPermission in the guard (#144, #145)"
```

---

### Task 3: Ticket routes move to `@ProjectPermission`; services receive the enriched principal

**Files:**
- Modify: `apps/api/src/tickets/tickets.controller.ts`
- Test: `apps/api/src/tickets/tickets.controller.spec.ts`, `apps/api/src/projects/project-membership.guard.routes.spec.ts`

**Interfaces:**
- Consumes: `ProjectPermission`, `PROJECT_PERMISSION_KEY`, `CurrentProject`, `ProjectContext`, `withProjectRole` (Task 2).
- Produces: every ticket route handler takes a trailing `@CurrentProject() project: ProjectContext` and passes `withProjectRole(principal, project.role)` to the service. So `TicketsService.update` → `assertTransitionPermission(principal)` evaluates the project role, with no service change. Tasks 7 and 8 extend `close` and `findByRef`.

Route → decorator mapping (exact):

| Route | Decorator |
|:--|:--|
| `POST /` (create) | `@ProjectPermission([CaslPermissionAction.CREATE, 'Ticket'])` (new; had none) |
| `GET /`, `GET :ref` | none (membership only) |
| `PATCH :ref` | `@ProjectPermission([KodaAction.UPDATE as CaslPermissionAction, 'Ticket'])` |
| `DELETE :ref` | `@ProjectPermission([CaslPermissionAction.DELETE, 'Ticket'])` |
| `POST :ref/assign` | `@ProjectPermission([KodaAction.UPDATE as CaslPermissionAction, 'Ticket'])` |
| `POST :ref/verify` / `start` / `fix` / `verify-fix` / `close` / `reject` | `@ProjectPermission([KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'])` |

- [ ] **Step 1: Update the metadata tests to expect `@ProjectPermission` (failing)**

In `tickets.controller.spec.ts`, replace each `Reflect.getMetadata(PERMISSION_KEY, controller.<handler>)` assertion with the project key, and add the create and "no global permission" assertions:

```ts
import { PROJECT_PERMISSION_KEY } from '../projects/project-permission.decorator';

describe('#144 project permissions on ticket routes', () => {
  const T = KodaAction.TRANSITION as CaslPermissionAction;
  const U = KodaAction.UPDATE as CaslPermissionAction;
  const cases: Array<[keyof TicketsController, [CaslPermissionAction, string]]> = [
    ['create', [CaslPermissionAction.CREATE, 'Ticket']],
    ['update', [U, 'Ticket']],
    ['softDelete', [CaslPermissionAction.DELETE, 'Ticket']],
    ['assign', [U, 'Ticket']],
    ['verify', [T, 'Ticket']],
    ['start', [T, 'Ticket']],
    ['fix', [T, 'Ticket']],
    ['verifyFix', [T, 'Ticket']],
    ['close', [T, 'Ticket']],
    ['reject', [T, 'Ticket']],
  ];

  it.each(cases)('%s carries @ProjectPermission(%j) and no global @RequiredPermission', (handler, permission) => {
    const fn = TicketsController.prototype[handler] as unknown as object;
    expect(Reflect.getMetadata(PROJECT_PERMISSION_KEY, fn)).toEqual({ permission, exemptAgents: false });
    expect(Reflect.getMetadata(PERMISSION_KEY, fn)).toBeUndefined();
  });
});
```

Delete the two old `requires ... permission on the HTTP route` tests (they assert `PERMISSION_KEY`).

Add a test that the enriched principal reaches the service. This file's fixtures are `mockAdminUser` / `mockMemberUser` / `mockAgent` (lines 60/74/88) and `mockTicketsService`; there is no `mockUserPrincipal` here:

```ts
  it('passes the principal enriched with the resolved project role to the service', async () => {
    const project = { project: { id: 'p1', slug: 'koda' }, role: 'DEVELOPER' };
    mockTicketsService.update.mockResolvedValue({ id: 't1' });
    await controller.update('koda', 'KODA-1', { title: 'x' }, mockMemberUser, project);
    expect(mockTicketsService.update).toHaveBeenCalledWith(
      'koda', 'KODA-1', { title: 'x' }, { ...mockMemberUser, projectRole: 'DEVELOPER' },
    );
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/api && bun run test -- src/tickets/tickets.controller.spec.ts`
Expected: FAIL. `PROJECT_PERMISSION_KEY` metadata is undefined, and `update` is called with the raw principal.

- [ ] **Step 3: Implement**

In `tickets.controller.ts`:
- Imports: drop `RequiredPermission` from the `@nathapp/nestjs-auth` import (keep `Principal`, `CaslPermissionAction`), and add:
  ```ts
  import { ProjectPermission } from '../projects/project-permission.decorator';
  import { CurrentProject } from '../projects/current-project.decorator';
  import { ProjectContext, withProjectRole } from '../projects/project-context';
  ```
- Replace each `@RequiredPermission([...])` with `@ProjectPermission([...])` per the mapping table, and add `@ProjectPermission([CaslPermissionAction.CREATE, 'Ticket'])` to `create`.
- On every handler that takes `@Principal() principal`, add a trailing parameter `@CurrentProject() project: ProjectContext` and pass `withProjectRole(principal, project.role)` wherever it passed `principal`. Example for `update` (apply the same shape to `create`, `softDelete`, `assign`, `verify`, `start`, `fix`, `verifyFix`, `reject`; `close` is rewritten in Task 7, so for now give it the same shape):

  ```ts
  @Patch(':ref')
  @ApiOperation({ summary: 'Update a ticket' })
  @ApiResponse({ status: 200, type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 403, description: 'Project role lacks UPDATE Ticket' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @ProjectPermission([KodaAction.UPDATE as CaslPermissionAction, 'Ticket'])
  async update(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() updateTicketDto: UpdateTicketDto,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const data = await this.updateTicket(slug, ref, updateTicketDto, withProjectRole(principal, project.role));
    return JsonResponse.Ok(data);
  }
  ```

  For `findAll`, keep `resolveSelfAssignee(filters, principal)` on the raw principal (the ids are the same).
- Change the `softDelete` `@ApiResponse({ status: 403, description: 'Forbidden - admin role required' })` text to `'Project ADMIN or global ADMIN required'`.

- [ ] **Step 4: Fix the existing controller tests' call sites**

Every direct `controller.<handler>(...)` call in `tickets.controller.spec.ts` that now takes a trailing project argument needs one. Add a fixture near the top, `const adminProject = { project: { id: 'proj-1', slug: 'koda' }, role: 'ADMIN' };`, and pass it as the last argument. Where a test asserts the service was called with the principal, the expected value becomes `withProjectRole(principal, 'ADMIN')`. For a global-ADMIN principal fixture that is `{ ...principal, projectRole: 'ADMIN' }`; for an agent it is the agent unchanged.

- [ ] **Step 5: Update the routes spec**

In `project-membership.guard.routes.spec.ts`, add `KodaCaslAbilityFactory` to the testing module's `providers` so the guard's `@ProjectPermission` check can run. Then run it:

Run: `cd apps/api && bun run test -- src/projects/project-membership.guard.routes.spec.ts`

If the spec's member principal is a DEVELOPER member and a case now returns 403 for `DELETE tickets/:ref` or `POST :ref/close`, that is the #144 ruling (both are ADMIN-only). Change the member's `findMembershipRole` stub to `'ADMIN'` **for those two cases only**, with a comment `// #144: delete and close are project-ADMIN only`. Do not change any 403 expectation for non-members.

- [ ] **Step 6: Run and confirm pass**

Run: `cd apps/api && bun run test -- src/tickets src/projects`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/tickets/tickets.controller.ts apps/api/src/tickets/tickets.controller.spec.ts apps/api/src/projects/project-membership.guard.routes.spec.ts
git commit -m "feat(tickets): project-role permissions on ticket routes (#144)"
```

---

### Task 4: Label routes move to `@ProjectPermission`

**Files:**
- Modify: `apps/api/src/labels/labels.controller.ts`
- Test: `apps/api/src/labels/labels.controller.spec.ts`

**Interfaces:**
- Consumes: `ProjectPermission`, `PROJECT_PERMISSION_KEY` (Task 2).
- Produces: nothing new for later tasks.

| Route | Decorator |
|:--|:--|
| `POST projects/:slug/labels` | `@ProjectPermission([CaslPermissionAction.CREATE, 'Label'])` |
| `GET projects/:slug/labels` | none |
| `PATCH projects/:slug/labels/:id` | `@ProjectPermission([CaslPermissionAction.UPDATE, 'Label'])` |
| `DELETE projects/:slug/labels/:id` | `@ProjectPermission([CaslPermissionAction.DELETE, 'Label'])` |
| `POST projects/:slug/tickets/:ref/labels` | `@ProjectPermission([KodaAction.UPDATE as CaslPermissionAction, 'Ticket'], { exemptAgents: true })` |
| `DELETE projects/:slug/tickets/:ref/labels/:labelId` | same as above |

Agents have `MANAGE Label`, so CREATE/UPDATE/DELETE Label behave for agents exactly as MANAGE did.

- [ ] **Step 1: Write the failing metadata test**

Add to `labels.controller.spec.ts`:

```ts
import { PERMISSION_KEY, CaslPermissionAction } from '@nathapp/nestjs-auth';
import { PROJECT_PERMISSION_KEY } from '../projects/project-permission.decorator';
import { KodaAction } from '../auth/casl/koda-action.enum';

describe('#144 project permissions on label routes', () => {
  const U = KodaAction.UPDATE as CaslPermissionAction;
  it.each([
    ['createFromHttp', [CaslPermissionAction.CREATE, 'Label'], false],
    ['updateFromHttp', [CaslPermissionAction.UPDATE, 'Label'], false],
    ['deleteFromHttp', [CaslPermissionAction.DELETE, 'Label'], false],
    ['assignLabelFromHttp', [U, 'Ticket'], true],
    ['removeLabelFromHttp', [U, 'Ticket'], true],
  ] as const)('%s carries @ProjectPermission(%j, exemptAgents=%s)', (handler, permission, exemptAgents) => {
    const fn = (LabelsController.prototype as unknown as Record<string, object>)[handler];
    expect(Reflect.getMetadata(PROJECT_PERMISSION_KEY, fn)).toEqual({ permission: [...permission], exemptAgents });
    expect(Reflect.getMetadata(PERMISSION_KEY, fn)).toBeUndefined();
  });

  it('findByProjectFromHttp carries no project permission (read is membership only)', () => {
    expect(Reflect.getMetadata(PROJECT_PERMISSION_KEY, LabelsController.prototype.findByProjectFromHttp)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/api && bun run test -- src/labels/labels.controller.spec.ts`
Expected: FAIL (metadata undefined).

- [ ] **Step 3: Implement**

In `labels.controller.ts`: import `ProjectPermission` and `KodaAction`, drop `RequiredPermission` from the import, and apply the table. Add `@ApiResponse({ status: 403, description: 'Forbidden' })` to the two ticket-label routes.

- [ ] **Step 4: Run and confirm pass**

Run: `cd apps/api && bun run test -- src/labels`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/labels
git commit -m "feat(labels): project-role permissions on label routes (#144)"
```

---

### Task 5: Comment update/delete use the comment's project role

**Files:**
- Modify: `apps/api/src/comments/comments.service.ts`
- Test: `apps/api/src/comments/comments.service.spec.ts`

**Interfaces:**
- Consumes: `ProjectAccessService.resolveMembership` (Task 2), `withProjectRole` (Task 2), factory (Task 1).
- Produces: nothing new.

The slug-less `PATCH/DELETE comments/:id` routes keep `@RequiredPermission([UPDATE|DELETE, 'Comment'])`. The global check passes for every user, because every user holds a conditional UPDATE/DELETE Comment rule. The real decision is the service's instance check, which now uses the project role. The project lookup already runs in `assertCommentProjectMembership`; it now returns the role instead of discarding it, so no query is added.

- [ ] **Step 1: Write failing tests**

Add to `comments.service.spec.ts`. Use the file's existing mocks for `commentRepo.findOwningProjectAndTicket`, `commentRepo.findById`, `commentRepo.delete` and `access`, and **replace** the `access` mock's `assertProjectMembership` with `resolveMembership` in its setup:

```ts
  describe('#144 project-role comment rights', () => {
    const ownership = {
      project: { id: 'p1', slug: 'koda', key: 'KODA', deletedAt: null },
      ticket: { id: 't1', deletedAt: null },
    };
    const othersComment = { id: 'c1', ticketId: 't1', body: 'b', type: 'GENERAL', authorUserId: 'someone-else', authorAgentId: null };

    beforeEach(() => {
      commentRepo.findOwningProjectAndTicket.mockResolvedValue(ownership);
      commentRepo.findById.mockResolvedValue(othersComment);
    });

    it("a project ADMIN may delete another user's comment", async () => {
      access.resolveMembership.mockResolvedValue('ADMIN');
      await expect(service.delete('c1', memberPrincipal)).resolves.toBeUndefined();
      expect(commentRepo.delete).toHaveBeenCalledWith('c1');
    });

    it("a project DEVELOPER may not delete another user's comment", async () => {
      access.resolveMembership.mockResolvedValue('DEVELOPER');
      await expect(service.delete('c1', memberPrincipal)).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(commentRepo.delete).not.toHaveBeenCalled();
    });

    it("a project ADMIN may not edit another user's comment", async () => {
      access.resolveMembership.mockResolvedValue('ADMIN');
      await expect(service.update('c1', { body: 'x' }, memberPrincipal)).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('a non-member still gets 404, not 403', async () => {
      access.resolveMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));
      await expect(service.delete('c1', memberPrincipal)).rejects.toBeInstanceOf(NotFoundAppException);
    });
  });
```

(`memberPrincipal` is the spec's global-MEMBER user fixture. Use its real name.)

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/api && bun run test -- src/comments/comments.service.spec.ts`
Expected: FAIL. The project ADMIN delete is refused (the ability has no project role), and `resolveMembership` is never called.

- [ ] **Step 3: Implement**

In `comments.service.ts`, import `withProjectRole` from `'../projects/project-context'`. Change `assertCommentProjectMembership` to return the role, using `resolveMembership` for every principal. For agents it resolves `null` with no query:

```ts
  private async assertCommentProjectMembership(
    commentId: string,
    principal: KodaPrincipal,
  ): Promise<{ projectId: string; role: string | null }> {
    const ownership = await this.commentRepo.findOwningProjectAndTicket(commentId);

    if (!ownership || ownership.ticket.deletedAt || ownership.project.deletedAt) {
      throw new NotFoundAppException({}, 'comments');
    }

    // Agents resolve to null without a lookup; global ADMIN resolves to 'ADMIN'.
    // A non-member's 403 becomes 404 so the comment's existence stays hidden.
    try {
      const role = await this.access.resolveMembership(ownership.project.id, principal);
      return { projectId: ownership.project.id, role };
    } catch (err) {
      if (err instanceof ForbiddenAppException) throw new NotFoundAppException({}, 'comments');
      throw err;
    }
  }
```

In `update` and `delete`, keep the result and build the ability from the enriched principal:

```ts
    const { role } = await this.assertCommentProjectMembership(commentId, principal);
    // ...existing findById + not-found check...
    const ability = await this.caslAbilityFactory.createForUser(withProjectRole(principal, role));
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd apps/api && bun run test -- src/comments`
Expected: PASS. Any pre-existing test that mocked `access.assertProjectMembership` for update/delete must now mock `access.resolveMembership`. Make that swap in the test setup: `resolveMembership: jest.fn().mockResolvedValue('DEVELOPER')` for members, `'ADMIN'` for the global-admin cases, `null` for agents.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/comments
git commit -m "feat(comments): project ADMIN may delete others' comments (#144)"
```

---

### Task 6: Members page reports the caller's `viewerRole`

**Files:**
- Modify: `apps/api/src/projects/members/project-members.service.ts`, `project-members.controller.ts`
- Test: `apps/api/src/projects/members/project-members.service.spec.ts`, `project-members.controller.spec.ts`

**Interfaces:**
- Consumes: `resolveMembership` (Task 2).
- Produces: `GET /api/projects/:slug/members` → `data: { ...page, canManage: boolean, viewerRole: string | null }`. Task 11 (web) reads `viewerRole`.

- [ ] **Step 1: Write failing tests**

In `project-members.service.spec.ts`, replace the `list checks membership, not admin rights, and reports canManage` test with the following (add `resolveMembership: jest.fn()` to the access stub):

```ts
  it('list resolves membership once and derives canManage and viewerRole from it', async () => {
    access.resolveMembership.mockResolvedValue('ADMIN');
    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });
    expect(access.resolveMembership).toHaveBeenCalledTimes(1);
    expect(access.canManageMembers).not.toHaveBeenCalled();
    expect(result.canManage).toBe(true);
    expect(result.viewerRole).toBe('ADMIN');
  });

  it('list reports viewerRole DEVELOPER and canManage false for a developer', async () => {
    access.resolveMembership.mockResolvedValue('DEVELOPER');
    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });
    expect(result).toEqual(expect.objectContaining({ canManage: false, viewerRole: 'DEVELOPER' }));
  });

  it('list reports viewerRole null and canManage false for an agent', async () => {
    access.resolveMembership.mockResolvedValue(null);
    const result = await service.list('proj', projectAdmin, { current: 1, size: 20 });
    expect(result).toEqual(expect.objectContaining({ canManage: false, viewerRole: null }));
  });
```

In `project-members.controller.spec.ts`, change the list test's mock to `service.list.mockResolvedValue({ page, canManage: true, viewerRole: 'ADMIN' })` and its expectation to `data: { ...toPageResult(page), canManage: true, viewerRole: 'ADMIN' }`. Match the existing assertion's shape, which may spread `page` directly.

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/api && bun run test -- src/projects/members`
Expected: FAIL (`viewerRole` undefined; `canManageMembers` still called).

- [ ] **Step 3: Implement**

`project-members.service.ts` `list`:

```ts
  async list(
    slug: string,
    principal: KodaPrincipal,
    page: IPageOption,
  ): Promise<{ page: IPageResult<ProjectMemberDto>; canManage: boolean; viewerRole: string | null }> {
    const projectId = await this.access.findProjectIdBySlug(slug);
    // One membership read serves the gate, canManage and viewerRole.
    const viewerRole = await this.access.resolveMembership(projectId, principal);
    const mapped = remapPage(await this.membersRepo.findMemberPage(projectId, page), ProjectMemberDto.from);
    return { page: mapped, canManage: viewerRole === ActorRole.ADMIN, viewerRole };
  }
```

(Import `ActorRole` from `'../../common/enums'` if not already imported.) `canManage` keeps its meaning: global ADMIN resolves to `'ADMIN'`, agents to `null`.

`project-members.controller.ts` `list`:

```ts
    const { page, canManage, viewerRole } = await this.members.list(slug, principal, { current, size });
    return JsonResponse.Ok({ ...toPageResult(page), canManage, viewerRole });
```

and update its `@ApiResponse` description to `'Page of members: { total, current, size, hasNext, hasPrev, records, canManage, viewerRole }'`.

- [ ] **Step 4: Run and confirm pass**

Run: `cd apps/api && bun run test -- src/projects/members`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/projects/members
git commit -m "feat(members): report the caller's project role on the members page"
```

---

### Task 7: `close()` is an admin override with a required reason

**Files:**
- Create: `apps/api/src/tickets/state-machine/allowed-actions.ts` (the `canOverrideClose` half; Task 8 adds the rest)
- Modify: `apps/api/src/tickets/state-machine/ticket-transitions.service.ts`
- Modify: `apps/api/src/tickets/tickets.controller.ts`
- Test: `apps/api/src/tickets/state-machine/allowed-actions.spec.ts`, `ticket-transitions.service.spec.ts`, `tickets.controller.spec.ts`

**Interfaces:**
- Consumes: `withProjectRole`, `CurrentProject`, `ProjectContext` (Task 2).
- Produces:
  ```ts
  export function canOverrideClose(principal: KodaPrincipal): boolean
  // TicketTransitionsService
  close(projectSlug: string, ticketRef: string, reason: string, principal: KodaPrincipal): Promise<TransitionResultWithComment>
  ```
  `principal` is the role-enriched principal. `canOverrideClose` is true for a user whose global `role === 'ADMIN'` or whose `projectRole === 'ADMIN'`, and false for every agent.

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/tickets/state-machine/allowed-actions.spec.ts`:

```ts
import { canOverrideClose } from './allowed-actions';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';

const user = (over: Partial<UserPrincipal> = {}): UserPrincipal => ({
  actorType: 'user', id: 'u1', name: 'u1', email: 'u1@x', role: 'MEMBER',
  blacklisted: false, revoked: false, authorities: ['MEMBER'], ...over,
});
const agent: AgentPrincipal = {
  actorType: 'agent', id: 'a1', name: 'bot', slug: 'bot', status: 'ACTIVE',
  agentRoles: ['DEVELOPER', 'REVIEWER', 'VERIFIER', 'TRIAGER'], capabilities: [],
  blacklisted: false, revoked: false, authorities: ['WORKER'],
};

describe('canOverrideClose', () => {
  it.each([
    ['global ADMIN', user({ role: 'ADMIN' }), true],
    ['project ADMIN', user({ projectRole: 'ADMIN' }), true],
    ['project DEVELOPER', user({ projectRole: 'DEVELOPER' }), false],
    ['project VIEWER', user({ projectRole: 'VIEWER' }), false],
    ['no project role', user(), false],
    ['agent with every role', agent, false],
  ])('%s -> %s', (_label, principal, expected) => {
    expect(canOverrideClose(principal)).toBe(expected);
  });
});
```

In `ticket-transitions.service.spec.ts`, replace the `describe('close (any valid → CLOSED)'` block's call sites with the new signature and add the behaviour tests. Add `ticketEventService` and `outboxService` mocks to the testing module so the COMMENT_ADDED event can be observed:

```ts
import { TicketEventService } from '../../events/ticket-event.service';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
// in beforeEach providers:
//   { provide: TicketEventService, useValue: mockTicketEventService },
//   { provide: NathappOutboxService, useValue: mockOutbox },
// with
//   mockTicketEventService = { create: jest.fn().mockResolvedValue({ id: 'ev-1', createdAt: new Date() }) };
//   mockOutbox = { record: jest.fn().mockResolvedValue(undefined) };

  describe('close (admin override with reason)', () => {
    const inProgress = { ...mockTicket, status: TicketStatus.IN_PROGRESS };

    beforeEach(() => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue(inProgress);
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue({ ...inProgress, status: TicketStatus.CLOSED });
      mockTicketRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockTicketRepo.createComment.mockResolvedValue({ ...mockComment, id: 'c-close', type: CommentType.GENERAL, body: 'duplicate of KODA-2' });
    });

    it('writes the reason as a GENERAL comment in the same transaction as the status change', async () => {
      const result = await service.close('koda', 'KODA-1', 'duplicate of KODA-2', mockUserPrincipal);
      expect(mockTxManager.run).toHaveBeenCalledTimes(1);
      expect(mockTicketRepo.createComment).toHaveBeenCalledWith(expect.objectContaining({
        ticketId: inProgress.id, body: 'duplicate of KODA-2', type: CommentType.GENERAL, authorUserId: 'user-123',
      }));
      expect(result.comment.id).toBe('c-close');
      expect(result.ticket.status).toBe(TicketStatus.CLOSED);
    });

    it('emits COMMENT_ADDED for the reason comment, like any comment', async () => {
      await service.close('koda', 'KODA-1', 'duplicate of KODA-2', mockUserPrincipal);
      expect(mockTicketEventService.create).toHaveBeenCalledWith(expect.objectContaining({
        action: 'COMMENT_ADDED', ticketId: inProgress.id, data: { commentId: 'c-close' },
      }));
    });

    it('does not write the comment when the conditional status write returns null (lost update, 409)', async () => {
      mockTicketRepo.updateTicketStatusIf.mockResolvedValue(null);
      mockTxManager.run.mockImplementation(async (fn: () => unknown) => fn());
      await expect(service.close('koda', 'KODA-1', 'reason', mockUserPrincipal)).rejects.toMatchObject({ status: 409 });
      expect(mockTicketRepo.createComment).not.toHaveBeenCalled();
    });

    it.each([TicketStatus.CREATED, TicketStatus.CLOSED, TicketStatus.REJECTED])('refuses from %s (400)', async (status) => {
      mockTicketRepo.findTicketByRefRaw.mockResolvedValue({ ...mockTicket, status });
      await expect(service.close('koda', 'KODA-1', 'reason', mockUserPrincipal)).rejects.toBeInstanceOf(AppException);
      expect(mockTicketRepo.createComment).not.toHaveBeenCalled();
    });
  });
```

In the transaction, the status write happens **before** the comment write, so the race test proves no orphan comment is written. Adapt any other existing `close(...)` call in this spec (three-argument form) to the four-argument form.

In `tickets.controller.spec.ts` (its fixtures are `mockAdminUser` / `mockMemberUser` / `mockAgent` at lines 60/74/88, and `mockTicketsService` / `mockTransitionsService`; the project role comes from the context argument, so non-admin cases use the global-MEMBER `mockMemberUser`), add:

```ts
  describe('POST :ref/close (admin override)', () => {
    const project = (role: string | null) => ({ project: { id: 'p1', slug: 'koda' }, role });

    it('403 for a project DEVELOPER, before any service call', async () => {
      await expect(controller.close('koda', 'KODA-1', { body: 'why' }, mockMemberUser, project('DEVELOPER')))
        .rejects.toBeInstanceOf(ForbiddenAppException);
      expect(mockTransitionsService.close).not.toHaveBeenCalled();
    });

    it('403 for an agent even with every agent role', async () => {
      await expect(controller.close('koda', 'KODA-1', { body: 'why' }, mockAgent, project(null)))
        .rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it.each([undefined, '', '   '])('400 for a project ADMIN with reason %j', async (body) => {
      await expect(controller.close('koda', 'KODA-1', { body }, mockMemberUser, project('ADMIN')))
        .rejects.toBeInstanceOf(ValidationAppException);
      expect(mockTransitionsService.close).not.toHaveBeenCalled();
    });

    it('closes for a project ADMIN with a reason, passing the enriched principal', async () => {
      mockTransitionsService.close.mockResolvedValue({ ticket: { id: 't1', status: 'CLOSED' }, comment: {}, activity: {} });
      const res = await controller.close('koda', 'KODA-1', { body: 'dup' }, mockMemberUser, project('ADMIN'));
      expect(mockTransitionsService.close).toHaveBeenCalledWith('koda', 'KODA-1', 'dup', { ...mockMemberUser, projectRole: 'ADMIN' });
      expect(res).toEqual(expect.objectContaining({ data: { id: 't1', status: 'CLOSED' } }));
    });
  });
```

(Import `ForbiddenAppException` from `@nathapp/nestjs-common` if not already imported.)

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/api && bun run test -- src/tickets`
Expected: FAIL (module `./allowed-actions` missing; `close` has the old signature).

- [ ] **Step 3: Implement `canOverrideClose`**

Create `apps/api/src/tickets/state-machine/allowed-actions.ts`:

```ts
import { KodaPrincipal, isUserPrincipal } from '../../auth/principal/koda-principal.types';

/**
 * `close()` is an admin override (Track 3 ruling 2026-09-27): global ADMIN or
 * project ADMIN only; agents never. `principal` must be the role-enriched one
 * (withProjectRole), so projectRole is the role in the project being accessed.
 */
export function canOverrideClose(principal: KodaPrincipal): boolean {
  if (!isUserPrincipal(principal)) return false;
  return principal.role === 'ADMIN' || principal.projectRole === 'ADMIN';
}
```

- [ ] **Step 4: Implement `close()` in the transitions service**

Replace `close` in `ticket-transitions.service.ts`:

```ts
  /**
   * Admin override: close from IN_PROGRESS, VERIFIED or VERIFY_FIX with a
   * required reason, written as a GENERAL comment in the same transaction as
   * the status change. Authorization (global/project ADMIN) is decided by the
   * controller from the request's ProjectContext; the normal path to CLOSED
   * remains verify-fix approve.
   */
  async close(
    projectSlug: string,
    ticketRef: string,
    reason: string,
    principal: KodaPrincipal,
  ): Promise<TransitionResultWithComment> {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);
    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const ticket = await this.findTicketByRef(projectSlug, ticketRef);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    if (
      ticket.status === TicketStatus.CLOSED ||
      ticket.status === TicketStatus.CREATED ||
      ticket.status === TicketStatus.REJECTED
    ) {
      throw new ValidationAppException({}, 'tickets');
    }

    const repo = this.ticketRepo as import('../prisma-tickets.repository').PrismaTicketsRepository;

    const transaction = await this.txManager.run(async () => {
      const actorFields = actorForeignKeys(principal, 'actor');

      // M3: conditional write first, so a lost race rolls back before any
      // comment row exists.
      const updatedTicket = await repo.updateTicketStatusIf(ticket.id, ticket.status, TicketStatus.CLOSED);
      if (!updatedTicket) {
        throw new HttpException('Ticket state changed concurrently', HttpStatus.CONFLICT);
      }

      const authorFields = actorForeignKeys(principal, 'authoredBy');
      const comment = await repo.createComment({
        ticketId: ticket.id,
        body: reason,
        type: CommentType.GENERAL,
        authorUserId: authorFields.authorUserId,
        authorAgentId: authorFields.authorAgentId,
      });

      const activity = await repo.createTicketActivity({
        ticketId: ticket.id,
        action: ActivityType.STATUS_CHANGE,
        fromStatus: ticket.status,
        toStatus: TicketStatus.CLOSED,
        ...actorFields,
      });

      await this.recordStatusChangeWebhooks(project.id, project.key, updatedTicket as unknown as TicketDomain, ticket.status, TicketStatus.CLOSED);
      await this.recordStatusChangedEvent(project.id, ticket.id, ticket.status, TicketStatus.CLOSED, principal);
      await this.recordCommentAddedEvent(project.id, ticket.id, comment.id, principal);

      return {
        ticket: updatedTicket as unknown as TransitionTicketShape,
        comment: comment as unknown as TransitionCommentShape,
        activity: activity as unknown as TransitionActivityShape,
      };
    });

    this.autoIndexTicket(project, transaction.ticket as unknown as TicketDomain);

    return transaction;
  }
```

Add the event helper next to `recordStatusChangedEvent`. It mirrors `CommentsService.recordCommentAdded`: it carries the comment id, never the body.

```ts
  /** COMMENT_ADDED for a comment written inside a transition transaction. */
  private async recordCommentAddedEvent(
    projectId: string,
    ticketId: string,
    commentId: string,
    principal: KodaPrincipal,
  ): Promise<void> {
    if (!this.ticketEventService || !this.outboxService) return;
    const actorType = isUserPrincipal(principal) ? 'user' : 'agent';
    const data = { commentId };
    const event = await this.ticketEventService.create({
      ticketId,
      projectId,
      action: 'COMMENT_ADDED',
      actorId: principal.id,
      actorType,
      source: 'internal',
      data,
    });
    await this.outboxService.record({
      type: 'ticket_event',
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId: principal.id, actorType, data }),
      metadata: { projectId, eventId: event.id },
    });
  }
```

- [ ] **Step 5: Implement the controller route**

In `tickets.controller.ts`, import `ForbiddenAppException` from `@nathapp/nestjs-common` and `canOverrideClose` from `'./state-machine/allowed-actions'`. Replace the `closeTicket` helper and the `close` route:

```ts
  async closeTicket(
    slug: string,
    ref: string,
    reason: string,
    principal: KodaPrincipal,
  ) {
    return this.transitionsService.close(slug, ref, reason, principal);
  }
```

```ts
  @Post(':ref/close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close a ticket (admin override; reason required, written as a GENERAL comment)' })
  @ApiResponse({ status: 200, description: 'Ticket closed', type: TicketResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid transition or blank reason' })
  @ApiResponse({ status: 403, description: 'Global ADMIN or project ADMIN required' })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  @ProjectPermission([KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'])
  async close(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Body() dto: TransitionWithCommentDto,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const actor = withProjectRole(principal, project.role);
    // Authorization before validation: a non-admin gets 403 whatever it sent.
    if (!canOverrideClose(actor)) {
      throw new ForbiddenAppException({}, 'tickets');
    }
    const result = await this.closeTicket(slug, ref, this.requireCommentBody(dto.body), actor);
    return JsonResponse.Ok(result.ticket);
  }
```

- [ ] **Step 6: Run and confirm pass**

Run: `cd apps/api && bun run test -- src/tickets`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/tickets
git commit -m "feat(tickets): close is an admin override with a required reason"
```

---

### Task 8: `allowedActions` on `GET :ref`

**Files:**
- Modify: `apps/api/src/tickets/state-machine/allowed-actions.ts`
- Modify: `apps/api/src/tickets/state-machine/ticket-transitions.ts` (export the rules)
- Create: `apps/api/src/tickets/dto/ticket-detail-response.dto.ts`
- Modify: `apps/api/src/tickets/tickets.service.ts`, `apps/api/src/tickets/tickets.controller.ts`
- Test: `allowed-actions.spec.ts`, `tickets.service.spec.ts`, `tickets.controller.spec.ts`

**Interfaces:**
- Consumes: `canOverrideClose` (Task 7), `validateTransition`, factory (Task 1), `withProjectRole` (Task 2).
- Produces:
  ```ts
  export const TICKET_ACTIONS = ['verify', 'start', 'fix', 'verify-fix', 'reject', 'close'] as const;
  export type TicketAction = (typeof TICKET_ACTIONS)[number];
  export function allowedActions(status: TicketStatus, perms: { canTransition: boolean; canClose: boolean }): TicketAction[]
  // TicketsService
  findByRefWithActions(projectSlug: string, ref: string, principal: KodaPrincipal): Promise<TicketDetailResponseDto>
  // TicketDetailResponseDto extends TicketResponseDto { allowedActions: TicketAction[] }
  ```
  The web (Task 11) renders exactly this list. Endpoint semantics: `verify` is offered only from CREATED. The verify endpoint also closes a VERIFY_FIX ticket, but `verify-fix` is the canonical action there, and offering both would render two buttons for one transition.

- [ ] **Step 1: Write the failing table test**

Append to `allowed-actions.spec.ts`:

```ts
import { allowedActions, TICKET_ACTIONS } from './allowed-actions';
import { TRANSITION_RULES, validateTransition } from './ticket-transitions';
import { TicketStatus, CommentType } from '../../common/enums';

/** What each endpoint asks the state machine for, from a given status. */
const ENDPOINT_TARGETS: Record<Exclude<typeof TICKET_ACTIONS[number], 'close'>, Array<[TicketStatus, CommentType | undefined]>> = {
  verify: [[TicketStatus.VERIFIED, CommentType.VERIFICATION]],
  start: [[TicketStatus.IN_PROGRESS, undefined]],
  fix: [[TicketStatus.VERIFY_FIX, CommentType.FIX_REPORT]],
  'verify-fix': [[TicketStatus.CLOSED, CommentType.REVIEW], [TicketStatus.IN_PROGRESS, CommentType.REVIEW]],
  reject: [[TicketStatus.REJECTED, CommentType.GENERAL]],
};
const CLOSE_SOURCES = [TicketStatus.IN_PROGRESS, TicketStatus.VERIFIED, TicketStatus.VERIFY_FIX];
const ALL_STATUSES = Object.values(TicketStatus) as TicketStatus[];
// Strict: validateTransition would also accept a 'NONE' rule with a comment type attached.
const passes = (from: TicketStatus, to: TicketStatus, c?: CommentType) => {
  try { validateTransition(from, to, c); } catch { return false; }
  const required = TRANSITION_RULES[from]?.[to];
  return required === 'NONE' ? c === undefined : c === required;
};

describe('allowedActions', () => {
  const roles = [
    ['project ADMIN', { canTransition: true, canClose: true }],
    ['DEVELOPER', { canTransition: true, canClose: false }],
    ['VIEWER', { canTransition: false, canClose: false }],
  ] as const;

  describe.each(roles)('%s', (_role, perms) => {
    it.each(ALL_STATUSES)('from %s: every action offered passes validateTransition', (status) => {
      for (const action of allowedActions(status, perms)) {
        if (action === 'close') {
          expect(CLOSE_SOURCES).toContain(status);
          continue;
        }
        expect(ENDPOINT_TARGETS[action].some(([to, c]) => passes(status, to, c))).toBe(true);
      }
    });

    it.each(ALL_STATUSES)('from %s: offers exactly the permitted actions', (status) => {
      const actions = allowedActions(status, perms);
      if (!perms.canTransition) expect(actions.filter((a) => a !== 'close')).toEqual([]);
      expect(actions.includes('close')).toBe(perms.canClose && CLOSE_SOURCES.includes(status));
    });
  });

  it('covers every reachable rule in TRANSITION_RULES for a transition-capable caller', () => {
    const perms = { canTransition: true, canClose: false };
    for (const [from, targets] of Object.entries(TRANSITION_RULES) as Array<[TicketStatus, Record<string, unknown>]>) {
      for (const to of Object.keys(targets) as TicketStatus[]) {
        // IN_PROGRESS -> VERIFIED needs a GENERAL comment no route supplies: unreachable by design.
        if (from === TicketStatus.IN_PROGRESS && to === TicketStatus.VERIFIED) continue;
        const actions = allowedActions(from, perms).filter((a): a is keyof typeof ENDPOINT_TARGETS => a !== 'close');
        expect({ from, to, covered: actions.some((a) => ENDPOINT_TARGETS[a].some(([t]) => t === to)) })
          .toEqual({ from, to, covered: true });
      }
    }
  });

  it('terminal statuses offer nothing, even to an admin', () => {
    const perms = { canTransition: true, canClose: true };
    expect(allowedActions(TicketStatus.CLOSED, perms)).toEqual([]);
    expect(allowedActions(TicketStatus.REJECTED, perms)).toEqual([]);
  });

  it('never offers verify-fix outside VERIFY_FIX (regression: NONE rules ignore the comment type)', () => {
    const perms = { canTransition: true, canClose: true };
    for (const status of [TicketStatus.CREATED, TicketStatus.VERIFIED, TicketStatus.IN_PROGRESS]) {
      expect(allowedActions(status, perms)).not.toContain('verify-fix');
    }
  });

  it('keeps a stable order for rendering', () => {
    expect(allowedActions(TicketStatus.CREATED, { canTransition: true, canClose: true })).toEqual(['verify', 'start', 'reject']);
    expect(allowedActions(TicketStatus.VERIFY_FIX, { canTransition: true, canClose: true })).toEqual(['verify-fix', 'close']);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/api && bun run test -- src/tickets/state-machine/allowed-actions.spec.ts`
Expected: FAIL (`allowedActions` not exported, `TRANSITION_RULES` not exported).

- [ ] **Step 3: Implement**

In `ticket-transitions.ts`, change `const TRANSITION_RULES: TransitionRule = {` to `export const TRANSITION_RULES: Readonly<TransitionRule> = {`, and add above it:

```ts
// IN_PROGRESS -> VERIFIED (GENERAL) is kept but unreachable: no route supplies
// a comment for it (PATCH {status} passes none). It is not an allowedActions entry.
```

Append to `allowed-actions.ts`:

```ts
import { TicketStatus, CommentType } from '../../common/enums';
import { TRANSITION_RULES } from './ticket-transitions';

export const TICKET_ACTIONS = ['verify', 'start', 'fix', 'verify-fix', 'reject', 'close'] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

/** The state-machine request each endpoint makes (verify only from CREATED; see file doc). */
const ACTION_TARGETS: Record<Exclude<TicketAction, 'close'>, Array<[TicketStatus, CommentType | undefined]>> = {
  verify: [[TicketStatus.VERIFIED, CommentType.VERIFICATION]],
  start: [[TicketStatus.IN_PROGRESS, undefined]],
  fix: [[TicketStatus.VERIFY_FIX, CommentType.FIX_REPORT]],
  'verify-fix': [[TicketStatus.CLOSED, CommentType.REVIEW], [TicketStatus.IN_PROGRESS, CommentType.REVIEW]],
  reject: [[TicketStatus.REJECTED, CommentType.GENERAL]],
};

const CLOSE_SOURCES: readonly TicketStatus[] = [TicketStatus.IN_PROGRESS, TicketStatus.VERIFIED, TicketStatus.VERIFY_FIX];

/**
 * Strict rule match. Not validateTransition: it returns early for a 'NONE'
 * rule without looking at the comment type, which would offer verify-fix
 * (IN_PROGRESS + REVIEW) on CREATED/VERIFIED tickets.
 */
function isValid(from: TicketStatus, to: TicketStatus, comment: CommentType | undefined): boolean {
  const required = TRANSITION_RULES[from]?.[to];
  if (required === undefined) return false;
  return required === 'NONE' ? comment === undefined : comment === required;
}

/**
 * M25: endpoint-level actions the caller may take on a ticket in `status`,
 * derived from the state machine and filtered by the caller's permissions
 * (TRANSITION from the project-role ability; close via canOverrideClose).
 */
export function allowedActions(
  status: TicketStatus,
  perms: { canTransition: boolean; canClose: boolean },
): TicketAction[] {
  const transitions = perms.canTransition
    ? (Object.keys(ACTION_TARGETS) as Array<Exclude<TicketAction, 'close'>>).filter((action) =>
        ACTION_TARGETS[action].some(([to, comment]) => isValid(status, to, comment)),
      )
    : [];
  const close = perms.canClose && CLOSE_SOURCES.includes(status) ? (['close'] as const) : [];
  return [...transitions, ...close];
}
```

The `ACTION_TARGETS` key order (`verify`, `start`, `fix`, `verify-fix`, `reject`) gives the stable render order the test pins. The `verify` endpoint's VERIFY_FIX → CLOSED branch is deliberately left out of `ACTION_TARGETS`.

- [ ] **Step 4: Run and confirm pass**

Run: `cd apps/api && bun run test -- src/tickets/state-machine/allowed-actions.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write failing service + controller tests for the detail response**

In `tickets.service.spec.ts`, add `KodaCaslAbilityFactory` to the testing module's providers (import from `'../auth/casl/koda-casl-ability.factory'`) and add:

```ts
  describe('findByRefWithActions (M25)', () => {
    beforeEach(() => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketScoped.mockResolvedValue({ ...mockTicket, status: 'VERIFIED' });
    });

    it.each([
      ['ADMIN', ['start', 'reject', 'close']],
      ['DEVELOPER', ['start', 'reject']],
      ['VIEWER', []],
    ])('project %s on a VERIFIED ticket -> %j', async (projectRole, expected) => {
      const res = await service.findByRefWithActions('koda', 'KODA-1', { ...mockUserPrincipal, projectRole });
      expect(res.allowedActions).toEqual(expected);
      expect(res.ref).toBe('KODA-1');
    });

    it('an agent gets transitions from its agent roles and never close', async () => {
      const res = await service.findByRefWithActions('koda', 'KODA-1', { ...mockAgentPrincipal, agentRoles: ['REVIEWER'] });
      expect(res.allowedActions).toEqual(['start', 'reject']);
    });
  });
```

(Adapt fixture names: `mockProject` / `mockTicket` / `mockUserPrincipal` / `mockAgentPrincipal`. If the spec has no agent fixture, add one shaped like the transitions spec's `mockAgentPrincipal`.)

In `tickets.controller.spec.ts` (fixtures `mockMemberUser` / `mockAgent`, not the service spec's `mockUserPrincipal`):

```ts
  it('GET :ref returns allowedActions computed for the enriched principal', async () => {
    mockTicketsService.findByRefWithActions.mockResolvedValue({ id: 't1', allowedActions: ['start'] });
    const res = await controller.findByRef('koda', 'KODA-1', mockMemberUser, { project: { id: 'p1', slug: 'koda' }, role: 'DEVELOPER' });
    expect(mockTicketsService.findByRefWithActions).toHaveBeenCalledWith('koda', 'KODA-1', { ...mockMemberUser, projectRole: 'DEVELOPER' });
    expect(res).toEqual(expect.objectContaining({ data: { id: 't1', allowedActions: ['start'] } }));
  });
```

Add `findByRefWithActions: jest.fn()` to the controller spec's tickets-service mock.

- [ ] **Step 6: Run and confirm failure**

Run: `cd apps/api && bun run test -- src/tickets`
Expected: FAIL (`findByRefWithActions` is not a function).

- [ ] **Step 7: Implement DTO, service and controller**

Create `apps/api/src/tickets/dto/ticket-detail-response.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { TicketResponseDto } from './ticket-response.dto';
import { TICKET_ACTIONS, TicketAction } from '../state-machine/allowed-actions';

/** GET :ref only; list and board responses do not carry allowedActions. */
export class TicketDetailResponseDto extends TicketResponseDto {
  @ApiProperty({
    description: 'Transition endpoints the caller may use on this ticket now (M25)',
    enum: TICKET_ACTIONS,
    isArray: true,
  })
  allowedActions!: TicketAction[];
}
```

In `tickets.service.ts`, inject the factory as the last constructor parameter, `private readonly caslAbilityFactory: KodaCaslAbilityFactory`. `TicketsModule` imports `AuthModule`, which exports it. Then add:

```ts
  /**
   * M25: the detail view plus the actions the caller may take. `principal`
   * must be role-enriched (withProjectRole) by the controller.
   */
  async findByRefWithActions(projectSlug: string, ref: string, principal: KodaPrincipal): Promise<TicketDetailResponseDto> {
    const ticket = await this.findByRef(projectSlug, ref);
    const ability = await this.caslAbilityFactory.createForUser(principal);
    const actions = allowedActions(ticket.status as TicketStatus, {
      canTransition: ability.can(KodaAction.TRANSITION as CaslPermissionAction, 'Ticket'),
      canClose: canOverrideClose(principal),
    });
    return { ...ticket, allowedActions: actions };
  }
```

Imports for `tickets.service.ts`: `CaslPermissionAction` from `@nathapp/nestjs-auth`, `KodaAction` from `'../auth/casl/koda-action.enum'`, `KodaCaslAbilityFactory` from `'../auth/casl/koda-casl-ability.factory'`, `allowedActions` and `canOverrideClose` from `'./state-machine/allowed-actions'`, and `TicketDetailResponseDto` from `'./dto/ticket-detail-response.dto'`.

In `tickets.controller.ts`, replace `findByRef` and drop its two stale `eslint-disable` comments:

```ts
  @Get(':ref')
  @ApiOperation({ summary: 'Get a ticket by reference (KODA-42 or CUID), with the caller\'s allowedActions' })
  @ApiResponse({ status: 200, type: TicketDetailResponseDto })
  @ApiResponse({ status: 404, description: 'Ticket or project not found' })
  async findByRef(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @Principal() principal: KodaPrincipal,
    @CurrentProject() project: ProjectContext,
  ) {
    const data = await this.ticketsService.findByRefWithActions(slug, ref, withProjectRole(principal, project.role));
    return JsonResponse.Ok(data);
  }
```

Keep the public `getTicket(slug, ref)` helper. Other callers and tests use it.

- [ ] **Step 8: Run and confirm pass**

Run: `cd apps/api && bun run test -- src/tickets src/projects`
Expected: PASS. If `project-membership.guard.routes.spec.ts` stubs `findByRef` for `GET :ref`, add a `findByRefWithActions` stub that returns the same value.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/tickets apps/api/src/projects/project-membership.guard.routes.spec.ts
git commit -m "feat(tickets): GET ticket returns allowedActions (M25)"
```

---

### Task 9: `assignee` on ticket responses (M26)

**Files:**
- Modify: `apps/api/src/tickets/domain/ticket.domain.ts`
- Modify: `apps/api/src/tickets/prisma-tickets.repository.ts`
- Modify: `apps/api/src/tickets/dto/ticket-response.dto.ts`
- Test: `apps/api/src/tickets/dto/ticket-response.dto.spec.ts`; integration assertion added in Task 13

**Interfaces:**
- Produces: `TicketResponseDto.assignee: { kind: 'user' | 'agent'; id: string; name: string } | null` on list, detail, create, update, assign, delete and transition responses. For a user without a `name`, the name falls back to the email (`User.name` is nullable). Tasks 10 and 11 consume it.

- [ ] **Step 1: Write the failing DTO test**

Append to `ticket-response.dto.spec.ts`:

```ts
describe('TicketResponseDto.assignee (M26)', () => {
  const base = { id: 't1', projectId: 'p1', number: 1, type: 'BUG', title: 'x', status: 'CREATED', priority: 'LOW', createdAt: new Date(), updatedAt: new Date() };

  it('maps a resolved user assignee', () => {
    const dto = TicketResponseDto.from({ ...base, assignee: { kind: 'user', id: 'u1', name: 'Ada' } }, 'KODA');
    expect(dto.assignee).toEqual({ kind: 'user', id: 'u1', name: 'Ada' });
  });

  it('maps a resolved agent assignee', () => {
    const dto = TicketResponseDto.from({ ...base, assignee: { kind: 'agent', id: 'a1', name: 'bot' } }, 'KODA');
    expect(dto.assignee).toEqual({ kind: 'agent', id: 'a1', name: 'bot' });
  });

  it('is null when unassigned or unresolved', () => {
    expect(TicketResponseDto.from(base, 'KODA').assignee).toBeNull();
  });
});
```

Add a repository mapping test to `prisma-tickets.repository.spec.ts`. Read that file first. If it only tests one helper and has no Prisma stub, create the stub inline like this:

```ts
import { PrismaTicketsRepository } from './prisma-tickets.repository';

describe('PrismaTicketsRepository assignee mapping (M26)', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 't1', projectId: 'p1', number: 1, type: 'BUG', title: 'x', description: null, status: 'CREATED', priority: 'LOW',
    assignedToUserId: null, assignedToAgentId: null, createdByUserId: null, createdByAgentId: null,
    gitRefVersion: null, gitRefFile: null, gitRefLine: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    labels: [], links: [], assignedToUser: null, assignedToAgent: null, ...over,
  });
  const repoWith = (found: unknown) => {
    const findUnique = jest.fn().mockResolvedValue(found);
    const prisma = { client: { ticket: { findUnique } } };
    return { repo: new PrismaTicketsRepository(prisma as never), findUnique };
  };

  it('selects only id/name/email of the assigned user and falls back to email for a null name', async () => {
    const { repo, findUnique } = repoWith(row({ assignedToUserId: 'u1', assignedToUser: { id: 'u1', name: null, email: 'ada@x' } }));
    const t = await repo.findTicketById('t1');
    expect(t?.assignee).toEqual({ kind: 'user', id: 'u1', name: 'ada@x' });
    expect(findUnique.mock.calls[0][0].include.assignedToUser).toEqual({ select: { id: true, name: true, email: true } });
  });

  it('maps an assigned agent by name', async () => {
    const { repo } = repoWith(row({ assignedToAgentId: 'a1', assignedToAgent: { id: 'a1', name: 'bot' } }));
    expect((await repo.findTicketById('t1'))?.assignee).toEqual({ kind: 'agent', id: 'a1', name: 'bot' });
  });

  it('maps no assignee to null', async () => {
    const { repo } = repoWith(row({}));
    expect((await repo.findTicketById('t1'))?.assignee).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/api && bun run test -- src/tickets/dto/ticket-response.dto.spec.ts src/tickets/prisma-tickets.repository.spec.ts`
Expected: FAIL (`assignee` undefined).

- [ ] **Step 3: Implement**

`ticket.domain.ts`: add the type and the field.

```ts
export interface TicketAssignee {
  kind: 'user' | 'agent';
  id: string;
  name: string;
}
// in TicketDomain, after `links?: TicketLink[];`
  /** M26: resolved name-only assignee; null when unassigned; undefined when not loaded. */
  assignee?: TicketAssignee | null;
```

`prisma-tickets.repository.ts`:
- Add the shared include above the class:
  ```ts
  /** One include for every ticket read, so every response carries labels, links and the assignee. */
  const TICKET_INCLUDE = {
    labels: { include: { label: true } },
    links: true,
    assignedToUser: { select: { id: true, name: true, email: true } },
    assignedToAgent: { select: { id: true, name: true } },
  } as const;
  ```
- Extend `PrismaTicketRow` with:
  ```ts
  assignedToUser?: { id: string; name: string | null; email: string } | null;
  assignedToAgent?: { id: string; name: string } | null;
  ```
- In `toDomain`, add after `links`:
  ```ts
      assignee: row.assignedToUser
        ? { kind: 'user', id: row.assignedToUser.id, name: row.assignedToUser.name ?? row.assignedToUser.email }
        : row.assignedToAgent
          ? { kind: 'agent', id: row.assignedToAgent.id, name: row.assignedToAgent.name }
          : null,
  ```
- Replace every `include: { labels: { include: { label: true } }, links: true }` and every multi-line `include: { labels: ..., links: true, }` with `include: TICKET_INCLUDE`. The sites are `findTicketPage`, `findTicketByProjectAndNumber`, `findTicketById`, `updateTicket`, `assignTicket`, `softDeleteTicket`, and both branches of `findTicketScoped`. Also add `include: TICKET_INCLUDE` to `createTicket` (`this.db.ticket.create({ data, include: TICKET_INCLUDE })`) and to the `findUnique` inside `updateTicketStatusIf`.
- Check with: `grep -n "include:" apps/api/src/tickets/prisma-tickets.repository.ts`. Every ticket read should show `TICKET_INCLUDE`. The only other include left is `findTicketWithComments` (`include: { comments: true }`).

`ticket-response.dto.ts`: add the property after `assignedToAgentId`:

```ts
  @ApiProperty({
    description: 'Resolved assignee (user or agent), or null when unassigned',
    nullable: true,
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['user', 'agent'] },
      id: { type: 'string' },
      name: { type: 'string' },
    },
  })
  assignee!: { kind: 'user' | 'agent'; id: string; name: string } | null;
```

In `from()`, add `assignee: ticket.assignee ?? null,` to the returned object.

- [ ] **Step 4: Run and confirm pass**

Run: `cd apps/api && bun run test -- src/tickets`
Expected: PASS. If a pre-existing test compares a full `TicketResponseDto.from(...)` result with `toEqual`, add `assignee: null` to its expected object.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/tickets
git commit -m "feat(tickets): resolve assignee name on ticket responses (M26)"
```

---

### Task 10: `approve` in the contract; regenerate openapi + CLI; CLI `close --reason`, `verify-fix` approve

**Files:**
- Modify: `apps/api/src/tickets/tickets.controller.ts` (`@ApiQuery`)
- Regenerate: `openapi.json`, `apps/cli/src/generated/**`
- Modify: `apps/cli/src/commands/ticket.ts`
- Test: `apps/cli/src/commands/ticket.spec.ts`

**Interfaces:**
- Consumes: the Task 7 close body, the Task 8 detail DTO, the Task 9 assignee (all exported into `openapi.json` by this task).
- Produces: generated `TicketsControllerVerifyFixData.query?: { approve?: boolean }` and `TicketsControllerCloseData.body: TransitionWithCommentDto`.

- [ ] **Step 1: Add `@ApiQuery` to verify-fix**

In `tickets.controller.ts`, import `ApiQuery` from `@nestjs/swagger` and add above `verifyFix`:

```ts
  @ApiQuery({ name: 'approve', type: Boolean, required: false, description: 'true closes the ticket; false (default) returns it to IN_PROGRESS' })
```

- [ ] **Step 2: Regenerate the spec and the client**

Run: `bun run generate` (repo root; builds the api, exports `openapi.json`, runs `openapi-ts`)
Expected: exit 0. Then:

```bash
grep -n '"approve"' openapi.json
grep -n "allowedActions\|\"assignee\"" openapi.json | head
grep -n "approve" apps/cli/src/generated/types.gen.ts
```

Expected: `approve` appears as a query parameter on `/api/projects/{slug}/tickets/{ref}/verify-fix`. `allowedActions` appears on `TicketDetailResponseDto`, and `assignee` on `TicketResponseDto`. `TicketsControllerCloseData` now has `body: TransitionWithCommentDto`.

- [ ] **Step 3: Write failing CLI tests**

In `apps/cli/src/commands/ticket.spec.ts`, in `describe('ticket verify-fix'`, change the `--pass` test and add a `--fail` expectation:

```ts
    it('--pass sends approve=true in one call and never calls close', async () => {
      (ticketsControllerVerifyFix as jest.Mock).mockResolvedValue({ data: {} });
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyFixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify-fix');
      await verifyFixCmd?.parseAsync(['node', 'test', 'KODA-1', '--comment', 'Looks good', '--pass']);
      expect(ticketsControllerVerifyFix).toHaveBeenCalledWith(expect.objectContaining({
        body: { body: 'Looks good' }, path: { slug: 'koda', ref: 'KODA-1' }, query: { approve: true },
      }));
      expect(ticketsControllerClose).not.toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('--fail sends approve=false', async () => {
      (ticketsControllerVerifyFix as jest.Mock).mockResolvedValue({ data: {} });
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyFixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify-fix');
      await verifyFixCmd?.parseAsync(['node', 'test', 'KODA-1', '--comment', 'Broken', '--fail']);
      expect(ticketsControllerVerifyFix).toHaveBeenCalledWith(expect.objectContaining({ query: { approve: false } }));
    });
```

In `describe('ticket close'`, change the success test and add the missing-reason test:

```ts
    it('sends the reason as the comment body', async () => {
      (ticketsControllerClose as jest.Mock).mockResolvedValue({ data: {} });
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const closeCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'close');
      await closeCmd?.parseAsync(['node', 'test', 'KODA-1', '--reason', 'duplicate of KODA-2']);
      expect(ticketsControllerClose).toHaveBeenCalledWith({
        body: { body: 'duplicate of KODA-2' }, path: { slug: 'koda', ref: 'KODA-1' },
      });
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it.each([[[]], [['--reason', '   ']]])('exits 3 without calling the API when the reason is missing or blank (%j)', async (extra) => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const closeCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'close');
      await closeCmd?.parseAsync(['node', 'test', 'KODA-1', ...extra]);
      expect(ticketsControllerClose).not.toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(3);
    });
```

(The existing verify-fix "requires comment → exit 3" test shows that `handleApiError(..., { validationError: true })` exits 3. Mirror its setup if `processExitSpy` needs to throw to stop execution.)

- [ ] **Step 4: Run and confirm failure**

Run: `cd apps/cli && bunx jest src/commands/ticket.spec.ts`
Expected: FAIL (`--pass` still calls close; `close` sends no body).

- [ ] **Step 5: Implement the CLI**

In `ticket.ts`, `verify-fix` action. Replace the call and the pass/close block:

```ts
        const ctx = await withContext({ projectSlug: options.project });

        await ticketsControllerVerifyFix({
          body: { body: options.comment },
          path: { slug: ctx.projectSlug, ref },
          query: { approve: Boolean(options.pass) },
        });

        console.log(options.pass
          ? `✓ Fix verified and ticket closed successfully`
          : `✓ Fix verification submitted successfully`);
        process.exit(0);
```

`close` command:

```ts
  ticket
    .command('close <ref>')
    .description('Close a ticket (project or global ADMIN only; the reason is recorded as a comment)')
    .option('--project <slug>', 'Project slug')
    .option('--reason <text>', 'Why the ticket is being closed (required)')
    .option('--json', 'Output as JSON')
    .action(async (ref: string, options) => {
      try {
        if (!options.reason || !String(options.reason).trim()) {
          handleApiError(new Error('--reason is required'), { validationError: true });
        }
        const ctx = await withContext({ projectSlug: options.project });

        await ticketsControllerClose({ body: { body: options.reason }, path: { slug: ctx.projectSlug, ref } });
        console.log(`✓ Ticket closed successfully`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
      }
    });
```

Change `TicketRow.assignee` (line ~34) to `assignee?: { kind?: 'user' | 'agent'; id?: string; name?: string } | null;`. The print sites already read `.name`.

Keep the `✓` characters: they are existing CLI output. Don't add any new symbols.

- [ ] **Step 6: Run and confirm pass**

Run: `cd apps/cli && bunx jest src/commands/ticket.spec.ts && bun run type-check`
Expected: PASS, and type-check clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/tickets/tickets.controller.ts openapi.json apps/cli/src
git commit -m "feat(cli): close takes --reason; verify-fix sends approve (M28)"
```

---

### Task 11: Web renders from `allowedActions` and hides controls by project role

**Files:**
- Modify: `apps/web/components/TicketActionPanel.vue`
- Modify: `apps/web/pages/[project]/tickets/[ref].vue`
- Modify: `apps/web/pages/[project]/labels.vue`
- Modify: `apps/web/components/TicketCard.vue`, `apps/web/components/TicketBoard.vue`
- Modify: `apps/web/composables/useProjectMembers.ts`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`
- Test: `apps/web/tests/components/TicketActionPanel.spec.ts`, new `apps/web/tests/pages/ticket-role-visibility.spec.ts`

**Interfaces:**
- Consumes: `GET :ref` → `allowedActions` (Task 8), `assignee` (Task 9), members page `viewerRole` / `canManage` (Task 6), close body (Task 7).
- Produces: no later task depends on it except e2e (Task 14). Button names stay "Verify", "Start", "Submit Fix", "Approve Fix", "Fail Fix", "Reject", "Close". The dialog placeholder stays `common.commentPlaceholder` ("Enter a comment or reason...") and the confirm button stays `common.confirm` ("Confirm").

Web unit tests in this repo read the `.vue` source as a string (Jest, `testEnvironment: node`, nothing is mounted). The new tests follow that pattern.

- [ ] **Step 1: Rewrite the panel spec's status-driven blocks (failing)**

In `tests/components/TicketActionPanel.spec.ts`, **delete** the describe blocks that assert hard-coded status rendering: AC1's `source references ticket.status to drive rendering` test and AC2 through AC6 (the status-literal blocks). Add:

```ts
describe('M25: panel renders only from the API allowedActions', () => {
  const source = () => readFileSync(panelPath, 'utf-8')

  test('reads ticket.allowedActions', () => {
    expect(source()).toContain('allowedActions')
  })

  test('has no hard-coded status blocks', () => {
    expect(source()).not.toMatch(/ticket\.status\s*===/)
  })

  test.each(['verify', 'start', 'fix', 'verify-fix', 'reject', 'close'])('handles the %s action', (action) => {
    expect(source()).toContain(`'${action}'`)
  })

  test('close opens the reason dialog instead of posting directly', () => {
    expect(source()).not.toContain("performAction('close')")
    expect(source()).toContain("openDialog('close')")
    expect(source()).toContain('tickets.actions.closeReasonTitle')
  })

  test('approve fix opens the dialog (the API requires a review comment)', () => {
    expect(source()).toContain("openDialog('verify-fix-approve')")
  })

  test('confirm is disabled for a blank comment and never sends an empty body', () => {
    expect(source()).toMatch(/:disabled="!canSubmit"/)
    expect(source()).not.toContain('comment.value ? { body: comment.value } : {}')
  })
})
```

Keep the AC7, AC8 (dialog, `$api`), AC9 (emit), endpoint, no-console and US-004 blocks as they are.

Create `apps/web/tests/pages/ticket-role-visibility.spec.ts`:

```ts
import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const read = (...p: string[]) => readFileSync(join(webDir, ...p), 'utf-8')

describe('#144 ticket page visibility follows the project role', () => {
  const page = () => read('pages', '[project]', 'tickets', '[ref].vue')

  test('loads the caller project role from the members endpoint', () => {
    expect(page()).toContain('useProjectMembers(')
    expect(page()).toContain('viewerRole')
  })

  test('assign and label controls need DEVELOPER or ADMIN, not the global role', () => {
    expect(page()).not.toContain("currentUser.value?.role === 'ADMIN'")
    expect(page()).toMatch(/const canWork = computed/)
  })

  test('delete ticket is shown only to a project/global ADMIN', () => {
    expect(page()).toMatch(/v-if="canManage"[\s\S]{0,200}deleteTicket/)
  })

  test('assignee type carries kind and id', () => {
    expect(page()).toMatch(/kind:\s*'user'\s*\|\s*'agent'/)
  })
})

describe('#144 labels page visibility', () => {
  const page = () => read('pages', '[project]', 'labels.vue')

  test('edit and delete are shown only to a project/global ADMIN', () => {
    expect(page()).toMatch(/v-if="canManage"[\s\S]{0,400}deleteLabel/)
  })

  test('the create form is hidden from a VIEWER', () => {
    expect(page()).toMatch(/v-if="canCreate"/)
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/web && bunx jest tests/components/TicketActionPanel.spec.ts tests/pages/ticket-role-visibility.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `TicketActionPanel.vue`**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { extractApiError } from '~/composables/useApi'

type TicketAction = 'verify' | 'start' | 'fix' | 'verify-fix' | 'reject' | 'close'
type DialogAction = 'verify' | 'fix' | 'reject' | 'close' | 'verify-fix-approve' | 'verify-fix-fail'

interface Ticket {
  id: string
  ref: string
  status: 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX' | 'CLOSED' | 'REJECTED'
  /** Computed by the API for the current user (M25); absent means no actions. */
  allowedActions?: TicketAction[]
  [key: string]: unknown
}

const props = defineProps<{
  ticket: Ticket
  projectSlug: string
}>()

const emit = defineEmits<{
  (e: 'transition'): void
}>()

const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const isOpen = ref(false)
const comment = ref('')
const pendingAction = ref<DialogAction | null>(null)

const actions = computed(() => new Set(props.ticket.allowedActions ?? []))
const canSubmit = computed(() => comment.value.trim().length > 0)
const dialogTitle = computed(() =>
  pendingAction.value === 'close' ? t('tickets.actions.closeReasonTitle') : t('common.addComment'),
)

function openDialog(action: DialogAction) {
  pendingAction.value = action
  comment.value = ''
  isOpen.value = true
}

function closeDialog() {
  isOpen.value = false
  pendingAction.value = null
  comment.value = ''
}

const baseUrl = computed(() => `/projects/${props.projectSlug}/tickets/${props.ticket.ref}`)

async function performAction(action: DialogAction | 'start', body: Record<string, unknown> = {}) {
  try {
    if (action === 'verify-fix-approve') {
      await $api.post(`${baseUrl.value}/verify-fix?approve=true`, body)
    } else if (action === 'verify-fix-fail') {
      await $api.post(`${baseUrl.value}/verify-fix?approve=false`, body)
    } else {
      await $api.post(`${baseUrl.value}/${action}`, body)
    }
    emit('transition')
  } catch (error: unknown) {
    toast.error(extractApiError(error))
  }
}

async function handleStart() {
  await performAction('start')
}

async function handleDialogSubmit() {
  const action = pendingAction.value
  if (!action || !canSubmit.value) return
  const body = { body: comment.value.trim() }
  closeDialog()
  await performAction(action, body)
}
</script>

<template>
  <div class="space-y-2">
    <Button v-if="actions.has('verify')" class="w-full" @click="openDialog('verify')">{{ t('tickets.actions.verify') }}</Button>
    <Button v-if="actions.has('start')" class="w-full" @click="handleStart">{{ t('tickets.actions.start') }}</Button>
    <Button v-if="actions.has('fix')" class="w-full" @click="openDialog('fix')">{{ t('tickets.actions.submitFix') }}</Button>
    <template v-if="actions.has('verify-fix')">
      <Button class="w-full" @click="openDialog('verify-fix-approve')">{{ t('tickets.actions.approveFix') }}</Button>
      <Button class="w-full" variant="outline" @click="openDialog('verify-fix-fail')">{{ t('tickets.actions.failFix') }}</Button>
    </template>
    <Button v-if="actions.has('close')" class="w-full" variant="outline" @click="openDialog('close')">{{ t('tickets.actions.close') }}</Button>
    <Button v-if="actions.has('reject')" class="w-full" variant="destructive" @click="openDialog('reject')">{{ t('tickets.actions.reject') }}</Button>

    <Dialog :open="isOpen" @update:open="isOpen = $event">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{{ dialogTitle }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4">
          <Textarea
            v-model="comment"
            :placeholder="t('common.commentPlaceholder')"
            rows="4"
          />
          <div class="flex justify-end gap-2">
            <Button variant="outline" @click="closeDialog">{{ t('common.cancel') }}</Button>
            <Button :disabled="!canSubmit" @click="handleDialogSubmit">{{ t('common.confirm') }}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
```

Add the i18n key (a new `*Title` key in `tickets.actions`; the section so far holds only button labels). In `en.json`, add to `tickets.actions`: `"closeReasonTitle": "Reason for closing"`. In `zh.json`, add to `tickets.actions`: `"closeReasonTitle": "关闭原因"`.

- [ ] **Step 4: Update `useProjectMembers.ts`**

Add `viewerRole?: string | null` to `MemberPage`. Add a `const viewerRole = ref<string | null>(null)` next to `canManage`. In `fetchInto`, add `if (res.viewerRole !== undefined) viewerRole.value = res.viewerRole`. Add `viewerRole` to the returned object.

- [ ] **Step 5: Update `[ref].vue`**

- Replace the local `Assignee` interface with:
  ```ts
  interface Assignee {
    kind: 'user' | 'agent'
    id: string
    name: string
  }
  ```
- Add `allowedActions?: Array<'verify' | 'start' | 'fix' | 'verify-fix' | 'reject' | 'close'>` to the local `Ticket` interface.
- Replace lines 290-293 (the `canAssign` block) with:
  ```ts
  // #144: controls follow the caller's role in THIS project (the API decides;
  // this only avoids offering actions that would 403).
  const { canManage, viewerRole, load: loadMembership } = useProjectMembers(slug)
  onMounted(() => { loadMembership().catch(() => {}) })
  const canWork = computed(() => canManage.value || viewerRole.value === 'DEVELOPER')
  ```
  Then rename every `canAssign` use in the template to `canWork`: the assign block at ~595, plus a new `v-if="canWork"` on the label Select/Add block (~664-676) and on the ticket label badges' `@click="removeLabel(...)"`. For the badges, keep the badge visible and bind `:class="canWork ? 'cursor-pointer' : ''"` and `@click="canWork && removeLabel(label.id)"`.
- Delete button (~719): add `v-if="canManage"` to the `<Button variant="destructive" ... @click="deleteTicket">`.
- If `onMounted` is not already imported in this file, import it from `'vue'`.

- [ ] **Step 6: Update `labels.vue`**

Add:

```ts
const { canManage, viewerRole, load: loadMembership } = useProjectMembers(slug)
onMounted(() => { loadMembership().catch(() => {}) })
const canCreate = computed(() => canManage.value || viewerRole.value === 'DEVELOPER')
```

(Use this page's existing slug variable.) Wrap the create form (lines ~116-143) in `<template v-if="canCreate">...</template>`. Wrap the edit/delete `<template v-else>` block (lines ~177-184) so its buttons render only with `v-if="canManage"`:

```vue
              <template v-else-if="canManage">
                <Button size="sm" variant="outline" @click="startEdit(label)">
                  {{ t('common.edit') }}
                </Button>
                <Button variant="destructive" size="sm" @click="deleteLabel(label.id)">
                  {{ t('labels.actions.delete') }}
                </Button>
              </template>
```

- [ ] **Step 7: Update `TicketCard.vue` / `TicketBoard.vue` assignee types**

In both files, replace the local `Assignee` interface with `interface Assignee { kind: 'user' | 'agent'; id: string; name: string }`. `TicketCard`'s `assigneeInitials(assignee)` reads `.name` and keeps working.

- [ ] **Step 8: Run web tests, type-check, lint**

Run: `cd apps/web && bunx jest && bun run type-check && bun run lint`
Expected: PASS. A pre-existing source-string spec (`ticket-detail.spec.ts`, `TicketBoard.spec.ts`) that asserted `canAssign` or the old `Assignee { name; email? }` shape must be updated to the new names. Change only the asserted identifier, not what the test checks.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): ticket actions from allowedActions; controls follow the project role"
```

---

### Task 12: Markdown render fallback escapes; sanitizer keeps `class` only for `language-*` on `<code>`

**Files:**
- Modify: `apps/web/lib/markdown.ts`
- Modify: `apps/web/components/MarkdownEditor.vue`
- Modify: `apps/web/pages/[project]/tickets/[ref].vue` (`renderedDescription`)
- Test: `apps/web/tests/lib/markdown.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export function escapeHtml(text: string): string
  export function renderMarkdownOrEscape(markdown: string): string   // never throws
  export function keepClassAttribute(tagName: string, value: string): boolean
  ```

- [ ] **Step 1: Write failing tests**

Append to `tests/lib/markdown.spec.ts`. Keep its existing `marked` and `isomorphic-dompurify` mocks. Extend the DOMPurify mock factory so it records hooks: add `addHook: jest.fn()` to the mocked default export object, next to `sanitize`. Then:

```ts
import DOMPurify from 'isomorphic-dompurify'
import { escapeHtml, renderMarkdownOrEscape, keepClassAttribute } from '../../lib/markdown'
import { marked } from 'marked'

describe('escapeHtml', () => {
  test('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;')
  })
})

describe('renderMarkdownOrEscape (M24)', () => {
  test('returns the sanitized render when rendering succeeds', () => {
    expect(renderMarkdownOrEscape('**hi**')).toContain('hi')
  })

  test('returns escaped text in a <p> when the renderer throws', () => {
    const spy = jest.spyOn(marked, 'parse').mockImplementationOnce(() => { throw new Error('boom') })
    expect(renderMarkdownOrEscape('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    spy.mockRestore()
  })

  test('returns an empty string for empty input', () => {
    expect(renderMarkdownOrEscape('')).toBe('')
  })
})

describe('keepClassAttribute (sanitizer LOW)', () => {
  test.each([
    ['code', 'language-ts', true],
    ['code', 'language-c-sharp', true],
    ['code', 'fixed inset-0', false],
    ['code', 'language-ts fixed', false],
    ['div', 'language-ts', false],
    ['span', 'fixed inset-0 z-50', false],
  ])('<%s class="%s"> keep=%s', (tag, value, keep) => {
    expect(keepClassAttribute(tag, value)).toBe(keep)
  })

  test('is registered as an uponSanitizeAttribute hook', () => {
    const calls = (DOMPurify.addHook as jest.Mock).mock.calls
    const hook = calls.find(([name]) => name === 'uponSanitizeAttribute')?.[1]
    expect(hook).toBeDefined()
    const drop = { attrName: 'class', attrValue: 'fixed inset-0', keepAttr: true }
    hook({ nodeName: 'DIV' }, drop)
    expect(drop.keepAttr).toBe(false)
    const keep = { attrName: 'class', attrValue: 'language-ts', keepAttr: true }
    hook({ nodeName: 'CODE' }, keep)
    expect(keep.keepAttr).toBe(true)
  })
})
```

The real DOMPurify cannot load under this Jest config (jsdom ESM transform error, confirmed while writing this plan). The real render is asserted in e2e (Task 14).

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/web && bunx jest tests/lib/markdown.spec.ts`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement `lib/markdown.ts`**

Keep `'class'` in `ALLOWED_ATTR`: the hook needs DOMPurify to consider the attribute before it can drop it. Add after `ALLOWED_URI_REGEXP`:

```ts
const LANGUAGE_CLASS = /^language-[\w-]+$/

/**
 * `class` is kept only on <code> with a single `language-*` token (syntax
 * highlighting). Anything else, e.g. `fixed inset-0`, could restyle page
 * chrome from user content.
 */
export function keepClassAttribute(tagName: string, value: string): boolean {
  return tagName.toLowerCase() === 'code' && LANGUAGE_CLASS.test(value.trim())
}

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName !== 'class') return
  if (!keepClassAttribute(node.nodeName, data.attrValue)) data.keepAttr = false
})

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** M24: never throws and never returns unsanitized HTML. */
export function renderMarkdownOrEscape(markdown: string): string {
  if (!markdown) return ''
  try {
    return renderSafeMarkdown(markdown)
  } catch {
    return `<p>${escapeHtml(markdown)}</p>`
  }
}
```

(`DOMPurify.addHook` runs once, at module load. The isomorphic export is a shared instance, so every `sanitize` call applies it.)

- [ ] **Step 4: Use it in both render sites**

`MarkdownEditor.vue`: import `renderMarkdownOrEscape` instead of `renderSafeMarkdown`, and replace the `renderedHtml` computed with:

```ts
// M24: renderMarkdownOrEscape catches renderer errors and escapes the raw text,
// so the v-html below never receives unsanitized input.
const renderedHtml = computed(() => renderMarkdownOrEscape(props.modelValue || ''))
```

`[ref].vue` (lines 166-173): import `renderMarkdownOrEscape` and replace the computed:

```ts
const renderedDescription = computed(() =>
  ticket.value?.description ? renderMarkdownOrEscape(ticket.value.description) : '',
)
```

`tests/components/MarkdownEditor.spec.ts` lines 112-128 assert that the component source contains `try`/`catch` and `v-html`. The catch now lives in `lib/markdown.ts`. Change that describe block to:

```ts
describe('US-002 AC3 / M24: renderer errors show escaped plain text', () => {
  test('component renders through renderMarkdownOrEscape', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('renderMarkdownOrEscape(')
    expect(source).toContain('v-html')
  })
})
```

Apply the same change to any `ticket-edit-markdown.spec.ts` / `ticket-detail.spec.ts` assertion that required a `try`/`catch` **around the markdown render** in `[ref].vue`. Leave the PATCH try/catch assertions (lines ~210-238) alone.

- [ ] **Step 5: Run and confirm pass**

Run: `cd apps/web && bunx jest && bun run type-check && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "fix(web): escape markdown render fallbacks and restrict class to code language tokens (M24)"
```

---

### Task 13: Integration — role matrix replaces the waived AC-29

> **Shared DB:** this task's run step is DB-backed. Follow the shared test database rules at the top. Run `pgrep -fl -f "koda-slice2a|track3-outbound-ssrf" || echo "slice 2a idle"` immediately before Step 3, and do not run while Slice 2a is active.

**Files:**
- Create: `apps/api/test/integration/projects/project-role-permissions.integration.spec.ts`
- Modify: `apps/api/test/integration/projects/project-membership-gate.integration.spec.ts` (header comment only)

**Interfaces:**
- Consumes: everything in Tasks 1-9 over real HTTP + Postgres. Helpers: `bootHttpApp`, `data`, `loginToken`, `TEST_PASSWORD` (`test/helpers/http-app.ts`), `resetDb` (`test/helpers/reset-db.ts`), and `JwtStrategyProvider` from `@nathapp/nestjs-auth` (the app's own signer, so a forged token is otherwise valid; `sign()` is inherited from `BaseJwtStrategyProvider`).

- [ ] **Step 1: Write the spec**

```ts
/**
 * Track 3 Slice 3 (#144): project-role write permissions, replayed over real
 * HTTP + Postgres as project ADMIN, DEVELOPER and VIEWER (all global MEMBER).
 * Replaces #143's waived AC-29. Every case builds its own fixture, because
 * transitions and deletes consume their target.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/projects/project-role-permissions
 * (Shared test DB: see the Slice 3 plan's warning before running.)
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { JwtStrategyProvider } from '@nathapp/nestjs-auth';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TIMEOUT = 30_000;

type Role = 'ADMIN' | 'DEVELOPER' | 'VIEWER';
type Method = 'get' | 'post' | 'patch' | 'delete';
interface Case {
  capability: string;
  /** Builds a fresh target as root; returns the request to replay. */
  setup: () => Promise<{ method: Method; url: string; body?: Record<string, unknown>; as?: (role: Role) => string }>;
  allowed: Record<Role, boolean>;
}

describeIntegration('project-role permissions (#144)', () => {
  let app: NathApplication;
  let server: Parameters<typeof request>[0];
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let counter = 0;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const asRoot = (method: Method, url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };

  const createUser = async (who: string) => {
    const res = await asRoot('post', '/api/admin/users', { email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    ids[who] = data<{ id: string }>(res).id;
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };
  const addMember = (slug: string, who: string, role: Role) =>
    asRoot('post', `/api/projects/${slug}/members`, { email: `${who}@koda.test`, role }).expect(201);

  const ticketIn = async (status: 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX', slug = 'team') => {
    const res = await asRoot('post', `/api/projects/${slug}/tickets`, { type: 'BUG', title: `t${counter++}` }).expect(201);
    const ref = data<{ ref: string }>(res).ref;
    const step = (action: string, body?: Record<string, unknown>) =>
      asRoot('post', `/api/projects/${slug}/tickets/${ref}/${action}`, body ?? {}).expect(200);
    if (status !== 'CREATED') await step('verify', { body: 'v' });
    if (status === 'IN_PROGRESS' || status === 'VERIFY_FIX') await step('start');
    if (status === 'VERIFY_FIX') await step('fix', { body: 'f' });
    return ref;
  };
  const label = async () => {
    const res = await asRoot('post', '/api/projects/team/labels', { name: `l${counter++}`, color: '#ff0000' }).expect(201);
    return data<{ id: string }>(res).id;
  };
  const commentBy = async (who: string, ref: string) => {
    const res = await request(server).post(`/api/projects/team/tickets/${ref}/comments`).set(auth(who)).send({ body: 'c' }).expect(201);
    return data<{ id: string }>(res).id;
  };

  const all = { ADMIN: true, DEVELOPER: true, VIEWER: true };
  const workers = { ADMIN: true, DEVELOPER: true, VIEWER: false };
  const adminOnly = { ADMIN: true, DEVELOPER: false, VIEWER: false };
  const whoFor: Record<Role, string> = { ADMIN: 'padmin', DEVELOPER: 'pdev', VIEWER: 'pviewer' };

  const cases: Case[] = [
    { capability: 'read ticket', allowed: all, setup: async () => ({ method: 'get', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}` }) },
    { capability: 'read labels', allowed: all, setup: async () => ({ method: 'get', url: '/api/projects/team/labels' }) },
    { capability: 'read comments', allowed: all, setup: async () => ({ method: 'get', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/comments` }) },
    { capability: 'create ticket', allowed: workers, setup: async () => ({ method: 'post', url: '/api/projects/team/tickets', body: { type: 'BUG', title: 'by role' } }) },
    { capability: 'update ticket', allowed: workers, setup: async () => ({ method: 'patch', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}`, body: { title: 'renamed' } }) },
    { capability: 'status via PATCH', allowed: workers, setup: async () => ({ method: 'patch', url: `/api/projects/team/tickets/${await ticketIn('VERIFIED')}`, body: { status: 'IN_PROGRESS' } }) },
    { capability: 'assign', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/assign`, body: { userId: ids.pdev } }) },
    { capability: 'verify', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/verify`, body: { body: 'ok' } }) },
    { capability: 'start', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('VERIFIED')}/start` }) },
    { capability: 'fix', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('IN_PROGRESS')}/fix`, body: { body: 'fixed' } }) },
    { capability: 'verify-fix approve', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('VERIFY_FIX')}/verify-fix?approve=true`, body: { body: 'lgtm' } }) },
    { capability: 'reject', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/reject`, body: { body: 'no' } }) },
    { capability: 'close override', allowed: adminOnly, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('IN_PROGRESS')}/close`, body: { body: 'duplicate' } }) },
    { capability: 'delete ticket', allowed: adminOnly, setup: async () => ({ method: 'delete', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}` }) },
    { capability: 'create label', allowed: workers, setup: async () => ({ method: 'post', url: '/api/projects/team/labels', body: { name: `r${counter++}`, color: '#00ff00' } }) },
    { capability: 'update label', allowed: adminOnly, setup: async () => ({ method: 'patch', url: `/api/projects/team/labels/${await label()}`, body: { name: `u${counter++}` } }) },
    { capability: 'delete label', allowed: adminOnly, setup: async () => ({ method: 'delete', url: `/api/projects/team/labels/${await label()}` }) },
    { capability: 'assign label to ticket', allowed: workers, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/labels`, body: { labelId: await label() } }) },
    {
      capability: 'remove label from ticket', allowed: workers, setup: async () => {
        const ref = await ticketIn('CREATED');
        const labelId = await label();
        await asRoot('post', `/api/projects/team/tickets/${ref}/labels`, { labelId }).expect(201);
        return { method: 'delete', url: `/api/projects/team/tickets/${ref}/labels/${labelId}` };
      },
    },
    { capability: 'create comment', allowed: all, setup: async () => ({ method: 'post', url: `/api/projects/team/tickets/${await ticketIn('CREATED')}/comments`, body: { body: 'hello' } }) },
    {
      capability: 'update own comment', allowed: all, setup: async () => {
        const ref = await ticketIn('CREATED');
        return { method: 'patch', url: '', body: { body: 'edited' }, as: (role) => `/api/comments/__own__${role}::${ref}` };
      },
    },
    {
      capability: "delete another user's comment", allowed: adminOnly, setup: async () => {
        const ref = await ticketIn('CREATED');
        return { method: 'delete', url: '', as: (role) => `/api/comments/__other__${role}::${ref}` };
      },
    },
  ];

  /** Resolves the comment placeholders: own = authored by the caller; other = authored by a different member. */
  const resolveUrl = async (role: Role, spec: Awaited<ReturnType<Case['setup']>>) => {
    if (!spec.as) return spec.url;
    const [kind, ref] = spec.as(role).replace('/api/comments/', '').split('::');
    if (kind.startsWith('__own__')) return `/api/comments/${await commentBy(whoFor[role], ref)}`;
    const author = role === 'DEVELOPER' ? 'pviewer' : 'pdev';
    return `/api/comments/${await commentBy(author, ref)}`;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    // registrationEnabled:false still allows the FIRST user (bootstrap admin), as in project-membership-gate.
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    for (const who of ['padmin', 'pdev', 'pviewer', 'multi']) await createUser(who);
    for (const [slug, key] of [['team', 'TEAM'], ['alpha', 'ALP']]) {
      await asRoot('post', '/api/projects', { name: slug, slug, key }).expect(201);
    }
    await addMember('team', 'padmin', 'ADMIN');
    await addMember('team', 'pdev', 'DEVELOPER');
    await addMember('team', 'pviewer', 'VIEWER');
    await addMember('alpha', 'multi', 'ADMIN');
    await addMember('team', 'multi', 'VIEWER');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  for (const c of cases) {
    for (const role of ['ADMIN', 'DEVELOPER', 'VIEWER'] as const) {
      const expected = c.allowed[role];
      it(`${c.capability}: project ${role} -> ${expected ? 'allowed' : '403'}`, async () => {
        const spec = await c.setup();
        const url = await resolveUrl(role, spec);
        const req = request(server)[spec.method](url).set(auth(whoFor[role]));
        const res = await (spec.body === undefined ? req : req.send(spec.body));
        if (expected) {
          expect({ status: res.status, ok: res.status >= 200 && res.status < 300 }).toEqual({ status: res.status, ok: true });
        } else {
          expect(res.status).toBe(403);
        }
      }, TIMEOUT);
    }
  }

  it('ADMIN in project A and VIEWER in project B gets VIEWER rights in B', async () => {
    const ref = await ticketIn('CREATED', 'team');
    await request(server).delete(`/api/projects/team/tickets/${ref}`).set(auth('multi')).expect(403);
    await request(server).post('/api/projects/team/tickets').set(auth('multi')).send({ type: 'BUG', title: 'x' }).expect(403);
    const alphaRef = await ticketIn('CREATED', 'alpha');
    await request(server).delete(`/api/projects/alpha/tickets/${alphaRef}`).set(auth('multi')).expect(200);
  }, TIMEOUT);

  it('a forged projectRole claim in an otherwise valid JWT is ignored', async () => {
    const signer = app.get(JwtStrategyProvider);
    const forged = await signer.sign({ sub: ids.pviewer, email: 'pviewer@koda.test', role: 'MEMBER', tokenVersion: 0, projectRole: 'ADMIN' });
    const ref = await ticketIn('CREATED');
    await request(server).delete(`/api/projects/team/tickets/${ref}`).set({ Authorization: `Bearer ${forged}` }).expect(403);
    // The forged token itself is valid: a read succeeds.
    await request(server).get(`/api/projects/team/tickets/${ref}`).set({ Authorization: `Bearer ${forged}` }).expect(200);
  }, TIMEOUT);

  it('close without a reason is 400 for a project ADMIN and leaves the ticket open', async () => {
    const ref = await ticketIn('IN_PROGRESS');
    await request(server).post(`/api/projects/team/tickets/${ref}/close`).set(auth('padmin')).send({ body: '   ' }).expect(400);
    const res = await request(server).get(`/api/projects/team/tickets/${ref}`).set(auth('padmin')).expect(200);
    expect(data<{ status: string }>(res).status).toBe('IN_PROGRESS');
  }, TIMEOUT);

  it('close writes the reason as a GENERAL comment', async () => {
    const ref = await ticketIn('IN_PROGRESS');
    await request(server).post(`/api/projects/team/tickets/${ref}/close`).set(auth('padmin')).send({ body: 'duplicate of TEAM-1' }).expect(200);
    const res = await request(server).get(`/api/projects/team/tickets/${ref}/comments`).set(auth('padmin')).expect(200);
    expect(data<Array<{ body: string; type: string }>>(res)).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: 'duplicate of TEAM-1', type: 'GENERAL' })]),
    );
  }, TIMEOUT);

  it.each([
    ['ADMIN', ['start', 'reject', 'close']],
    ['DEVELOPER', ['start', 'reject']],
    ['VIEWER', []],
  ] as const)('GET ticket returns allowedActions for project %s', async (role, expected) => {
    const ref = await ticketIn('VERIFIED');
    const res = await request(server).get(`/api/projects/team/tickets/${ref}`).set(auth(whoFor[role])).expect(200);
    expect(data<{ allowedActions: string[] }>(res).allowedActions).toEqual(expected);
  }, TIMEOUT);

  it('assignee resolves to the member name on detail and list', async () => {
    const ref = await ticketIn('CREATED');
    await asRoot('post', `/api/projects/team/tickets/${ref}/assign`, { userId: ids.pdev }).expect(200);
    const detail = await request(server).get(`/api/projects/team/tickets/${ref}`).set(auth('pdev')).expect(200);
    expect(data<{ assignee: unknown }>(detail).assignee).toEqual({ kind: 'user', id: ids.pdev, name: 'pdev' });
    const list = await request(server).get('/api/projects/team/tickets?assignedTo=self').set(auth('pdev')).expect(200);
    expect(data<{ records: Array<{ ref: string; assignee: unknown }> }>(list).records.find((r) => r.ref === ref)?.assignee)
      .toEqual({ kind: 'user', id: ids.pdev, name: 'pdev' });
  }, TIMEOUT);

  it('members page reports viewerRole for the caller', async () => {
    const res = await request(server).get('/api/projects/team/members').set(auth('pdev')).expect(200);
    expect(data<{ viewerRole: string; canManage: boolean }>(res)).toEqual(expect.objectContaining({ viewerRole: 'DEVELOPER', canManage: false }));
  }, TIMEOUT);
});
```

(If `GET .../comments` returns a page envelope rather than an array, read `.records` in the close-comment test. Check `POST .../labels` DTO field names against `labels/dto/create-label.dto.ts` and `assign-label.dto.ts` before running, and adjust `name`/`color`/`labelId` if they differ. Check the admin users route and the register bootstrap against `project-membership-gate.integration.spec.ts` lines 166-181, which this copies.)

- [ ] **Step 2: Update the old spec's header**

In `project-membership-gate.integration.spec.ts`, replace header lines 15-23 (the "Assumption: ... No CASL rule is redefined here." paragraph) with:

```ts
 * Visibility only: AC11/AC12 prove the membership gate (non-member 403, member
 * not 403/404). Write routes are exercised with a global-ADMIN member so that
 * this file keeps asserting visibility, not role rights. Project-role write
 * permissions (#144) are proven in project-role-permissions.integration.spec.ts,
 * which replaces #143's waived AC-29.
```

- [ ] **Step 3: Run it (DB-backed; follow the shared-DB rules)**

```bash
pgrep -fl -f "koda-slice2a|track3-outbound-ssrf" || echo "slice 2a idle"
cd apps/api && bun run test:db:up && bun run test:integration -- test/integration/projects/project-role-permissions
```

Expected: PASS, with 66 matrix tests (22 capabilities × 3 roles) plus 8 extra tests. If the `pgrep` line prints a process, stop here and report that the step is waiting on Slice 2a.

- [ ] **Step 4: Run the old membership spec to confirm nothing regressed**

Run: `cd apps/api && bun run test:integration -- test/integration/projects/project-membership-gate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/integration/projects
git commit -m "test(api): project-role matrix over HTTP replaces waived AC-29 (#144)"
```

---

### Task 14: E2E — buttons follow the API; close prompts for a reason; developer flow; sanitizer

> **Shared DB / ports:** always run with the isolated overrides from the shared test database section (`E2E_DATABASE_URL=...koda_slice3_e2e`, ports 3112/3113). Also run the `pgrep` check first.

**Files:**
- Create: `apps/web/tests/e2e/ticket-project-roles.spec.ts`
- Modify: `apps/web/tests/e2e/ticket-detail-operations.e2e.spec.ts` (close test, lines ~93-131)
- Modify: `apps/web/tests/e2e/ticket-lifecycle.spec.ts` (header comment lines 12-20)

**Interfaces:**
- Consumes: fixtures `login`, `createUser`, `addProjectMember`, `createProject`, `createTicket`, `transitionTicket`, `E2E_ADMIN` (`fixtures/api-client.ts`); `webLogin`, `confirmTransitionDialog`, `generateUniqueProjectKey` (`fixtures/page-helpers.ts`).

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import {
  login, createUser, addProjectMember, createProject, createTicket, transitionTicket, E2E_ADMIN,
} from './fixtures/api-client';
import { webLogin, confirmTransitionDialog, generateUniqueProjectKey } from './fixtures/page-helpers';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';
const PASSWORD = 'E2ePassword1!';
const PADMIN = { email: 'roles-padmin@koda-e2e.test', name: 'Roles Project Admin', password: PASSWORD };
const DEV = { email: 'roles-dev@koda-e2e.test', name: 'Roles Developer', password: PASSWORD };
const VIEWER = { email: 'roles-viewer@koda-e2e.test', name: 'Roles Viewer', password: PASSWORD };

test.describe('Ticket actions follow the project role (#144, M25)', () => {
  let token: string;
  let slug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const suffix = Date.now().toString().slice(-6);
    slug = (await createProject(token, { name: 'E2E Roles', slug: `e2erl${suffix}`, key: generateUniqueProjectKey('RL') })).slug;
    for (const u of [PADMIN, DEV, VIEWER]) await createUser(token, u);
    await addProjectMember(token, slug, PADMIN.email, 'ADMIN');
    await addProjectMember(token, slug, DEV.email, 'DEVELOPER');
    await addProjectMember(token, slug, VIEWER.email, 'VIEWER');
  });

  test('a DEVELOPER moves a ticket through the flow and never sees Close or Delete', async ({ page }) => {
    const ticket = await createTicket(token, slug, { title: 'Dev flow', type: 'BUG' });
    await webLogin(page, DEV.email, DEV.password);
    await page.goto(`/${slug}/tickets/${ticket.ref}`);

    await page.getByRole('button', { name: 'Verify' }).click();
    await confirmTransitionDialog(page, 'verified by dev');
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('button', { name: 'Submit Fix' }).click();
    await confirmTransitionDialog(page, 'fixed by dev');
    await expect(page.getByRole('button', { name: 'Approve Fix' })).toBeVisible({ timeout: 5000 });

    await expect(page.getByRole('button', { name: /^Close$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Delete Ticket/i })).toHaveCount(0);
  });

  test('a VIEWER sees no action buttons', async ({ page }) => {
    const ticket = await createTicket(token, slug, { title: 'Viewer view', type: 'BUG' });
    await webLogin(page, VIEWER.email, VIEWER.password);
    await page.goto(`/${slug}/tickets/${ticket.ref}`);
    await expect(page.getByText(ticket.title)).toBeVisible({ timeout: 5000 });
    for (const name of ['Verify', 'Start', 'Reject', 'Close']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${name}$`) })).toHaveCount(0);
    }
  });

  test('a project ADMIN sees Close; it prompts for a reason and records it', async ({ page }) => {
    const ticket = await createTicket(token, slug, { title: 'Admin close', type: 'BUG' });
    await transitionTicket(token, slug, ticket.ref, 'verify', { body: 'v' });
    await webLogin(page, PADMIN.email, PADMIN.password);
    await page.goto(`/${slug}/tickets/${ticket.ref}`);

    await page.getByRole('button', { name: /^Close$/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Reason for closing')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await confirmTransitionDialog(page, 'closing as duplicate');
    await expect(page.getByText(/^CLOSED$/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('closing as duplicate')).toBeVisible();
  });

  test('the assignee name renders', async ({ page }) => {
    const ticket = await createTicket(token, slug, { title: 'Assignee render', type: 'BUG' });
    const devSession = await login(DEV.email, DEV.password);
    const res = await fetch(`${API_URL}/api/projects/${slug}/tickets/${ticket.ref}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: devSession.userId }),
    });
    expect(res.ok).toBe(true);
    await webLogin(page, DEV.email, DEV.password);
    await page.goto(`/${slug}/tickets/${ticket.ref}`);
    await expect(page.getByText(DEV.name).first()).toBeVisible({ timeout: 5000 });
  });

  test('user markdown cannot restyle the page with class; code keeps language-*', async ({ page }) => {
    const description = '<div class="fixed inset-0" data-testid="overlay">boom</div>\n\n```ts\nconst a = 1\n```';
    const ticket = await createTicket(token, slug, { title: 'Sanitizer', type: 'BUG', description });
    await webLogin(page, DEV.email, DEV.password);
    await page.goto(`/${slug}/tickets/${ticket.ref}`);
    const overlay = page.locator('div', { hasText: /^boom$/ });
    await expect(overlay).toHaveCount(1, { timeout: 5000 });
    await expect(overlay).not.toHaveAttribute('class', /fixed/);
    await expect(page.locator('code.language-ts')).toHaveCount(1);
  });
});
```

(Check `createTicket`'s accepted fields in `fixtures/api-client.ts`. If it does not forward `description`, extend its `data` parameter type to include `description?: string`; it posts the object as JSON. `login()` returns `{ token, userId }`. Four new logins stay under the 5/min throttle because `getSession` caches per user.)

- [ ] **Step 2: Update the existing close test**

In `ticket-detail-operations.e2e.spec.ts`, in the close test (~lines 93-131), after `await page.getByRole('button', { name: CLOSE_REGEX }).first().click();` and **before** awaiting `closeRequest`, add:

```ts
    await confirmTransitionDialog(page, 'closing from e2e');
```

(Import `confirmTransitionDialog` from `./fixtures/page-helpers` if it is not imported.) The global E2E admin can still close.

In `ticket-lifecycle.spec.ts`, correct the header comment (lines 12-20). Buttons now come from the API's `allowedActions`. Approve Fix and Close open the comment dialog. Close is shown only to a project or global ADMIN.

- [ ] **Step 3: Run the e2e specs with isolation (follow the shared-DB rules)**

```bash
pgrep -fl -f "koda-slice2a|track3-outbound-ssrf" || echo "slice 2a idle"
cd apps/api && bun run test:db:up
cd ../web && E2E_DATABASE_URL=postgresql://koda:koda@localhost:5433/koda_slice3_e2e \
  E2E_API_PORT=3112 E2E_WEB_PORT=3113 E2E_API_URL=http://localhost:3112 \
  bunx playwright test tests/e2e/ticket-project-roles.spec.ts tests/e2e/ticket-detail-operations.e2e.spec.ts tests/e2e/ticket-lifecycle.spec.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/e2e
git commit -m "test(e2e): ticket actions follow the project role; close prompts for a reason"
```

---

### Task 15: Full verification, then PR prep

> **Shared DB:** Steps 2 and 3 are DB-backed. Run the `pgrep` check before each.

- [ ] **Step 1: Unit, lint, type-check (DB-free)**

```bash
cd apps/api && bun run lint && bun run type-check && bun run test
cd ../web && bun run lint && bun run type-check && bunx jest
cd ../cli && bun run lint && bun run type-check && bunx jest --forceExit
```

Expected: all green. Record the pass counts for the PR body.

- [ ] **Step 2: Full api integration suite**

```bash
pgrep -fl -f "koda-slice2a|track3-outbound-ssrf" || echo "slice 2a idle"
cd apps/api && bun run test:integration
```

Expected: PASS.

- [ ] **Step 3: Full e2e suite (isolated)**

```bash
pgrep -fl -f "koda-slice2a|track3-outbound-ssrf" || echo "slice 2a idle"
cd apps/web && E2E_DATABASE_URL=postgresql://koda:koda@localhost:5433/koda_slice3_e2e \
  E2E_API_PORT=3112 E2E_WEB_PORT=3113 E2E_API_URL=http://localhost:3112 bun run test:e2e
```

Expected: PASS. Any other e2e spec that clicks Close without the dialog, or relies on a global MEMBER creating tickets, fails here. Fix it the same way as Task 14 Step 2. Do not weaken an assertion.

- [ ] **Step 4: Contract is in sync**

```bash
bun run generate && git status --short openapi.json apps/cli/src/generated
```

Expected: no changes. If anything changed, the contract drifted after Task 10. Commit the regenerated files with `chore: regenerate openapi and CLI client`.

- [ ] **Step 5: Code review before push**

Dispatch the code-reviewer (or `superpowers:requesting-code-review`) on `git diff main...HEAD`. Fix CRITICAL/HIGH findings before pushing.

- [ ] **Step 6: Push and open the PR (on the user's go-ahead)**

The PR body must include:
- Closes #144. Partially addresses #145: guard half only. Services still take slug, so the per-service project lookup remains (Deviation 1).
- **Breaking:** CLI `ticket close` requires `--reason`. A global MEMBER who is a project VIEWER can no longer create tickets. `close` needs global/project ADMIN plus a reason.
- The five deviations listed above, verbatim.
- Follow-ups: code-intel route wiring (Slice 4), and the service `slug` → `ProjectContext` refactor (#145).
- Verification counts from Steps 1-3.
- Rebase note: whichever of Slice 2a / Slice 3 merges second regenerates `openapi.json` and the CLI client after the rebase.
