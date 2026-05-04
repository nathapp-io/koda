# CASL Migration — Centralize Authorization in `KodaCaslAbilityFactory`

## Context

[`20260504-consolidate-actor-auth-koda-principal.md`](./20260504-consolidate-actor-auth-koda-principal.md) was the prerequisite. It produced a typed `KodaPrincipal`, populated `IPrincipal.authorities`, and registered `@RequiredPermission('ADMIN')` on the 12 pure-role gates. It explicitly deferred 9 conditional/ownership/role-mixing sites to this follow-up.

The deferred sites currently express authorization with hand-rolled inline checks — a mix of role lookups, ownership comparisons, and `actorType` branching:

```typescript
// labels.service.ts (3 sites)
if (isUserPrincipal(principal) && principal.role === 'MEMBER') {
  throw new ForbiddenAppException({}, 'labels');
}

// comments.service.ts (4 sites)
const isAuthor = isUserPrincipal(principal)
  ? comment.authorUserId === principal.id
  : comment.authorAgentId === principal.id;
const isAdmin = isUserPrincipal(principal) && principal.role === 'ADMIN';
if (!isAuthor && !isAdmin) throw new ForbiddenAppException({}, 'comments');

// tickets.service.ts (1 site)
if (isUserPrincipal(principal) && principal.role !== 'ADMIN') {
  throw new ForbiddenAppException({}, 'tickets');
}

// agents.controller.ts (1 site — found in final review N2)
if (principal.actorType !== 'agent') {
  throw new ForbiddenAppException({}, 'agents');
}
```

Each is a small policy, but **they live in 4 different files and 3 different modules**. There is no single place to ask "who can update a comment?" — the answer is scattered across `comments.service.ts:160-164`, `comments.service.ts:190-194`, the `MEMBER`-deny rule in `labels.service.ts`, and the implicit policy in `@RequiredPermission`.

`@nathapp/nestjs-auth` already supports CASL via `@RequiredPermission([action, subject])` and `BaseCaslAbilityFactory.getPermissions(principal)` (see `nathapp-nestjs-patterns/auth.md`). CASL is the conventional way to centralize this kind of policy.

The intended outcome: **one ability factory that owns every authorization decision, expressed as `(action, subject, conditions?)` tuples**. Inline `if`-throws disappear from services. Ownership rules become CASL `conditions`. Type-checked at compile time, testable in isolation.

---

## Architectural Target

```
┌─────────────────────────────────────────────────────────────┐
│  KodaCaslAbilityFactory (single source of truth)            │
│    getPermissions(principal: KodaPrincipal) →               │
│      [{ action, subject, conditions? }, ...]                │
└─────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
   @RequiredPermission   policy.can()   tests
   (controllers)         (services)     (factory in isolation)
```

- **Pure role gates** stay on `@RequiredPermission` (e.g. ADMIN-only routes — already migrated in PR1).
- **Resource-level checks** (action × subject without conditions) move to `@RequiredPermission([action, subject])`.
- **Ownership / conditional checks** (action × subject × `{ field: value }`) move to a `policy.can(action, instance)` call inside the service after the resource is loaded.
- **`actorType`-based gates** (e.g. agents-only routes) become `@RequiredPermission([action, 'AgentScope'])` with the rule encoded in the factory.

CASL ability is computed once per request, cached on `principal.extra.ability`. Decorator and service callers read from the same cached instance.

---

## Prerequisite — Tighten `KodaAgentRole`

PR1 deliberately left `KodaAgentRole = string` ([`koda-principal.types.ts:5`](../../apps/api/src/auth/principal/koda-principal.types.ts#L5)) to avoid throwing on unknown DB values before an audit. The CASL factory's `agentRoleDerivedPermissions` (below) switches on role values:

```typescript
switch (role) {
  case 'DEVELOPER': ...
  case 'REVIEWER': ...
  case 'VERIFIER': ...
  case 'TRIAGER': ...
}
```

With `KodaAgentRole = string`, this switch has no compile-time exhaustiveness guarantee — adding a 5th role to the DB silently fails to grant any permissions. **Tighten the type before adding the factory** so the switch becomes exhaustive and TypeScript enforces it.

### Single-source-of-truth pattern (project convention)

`apps/api/CLAUDE.md` rule: *"do not use Prisma enums; use local constants/types from `src/common/enums.ts`"*. Follow that pattern.

`apps/api/src/common/enums.ts`:
```typescript
export const AGENT_ROLES = ['DEVELOPER', 'REVIEWER', 'VERIFIER', 'TRIAGER'] as const;
export type AgentRole = typeof AGENT_ROLES[number];
```

One declaration powers four checkpoints:

| Layer | Use | Catches |
|---|---|---|
| Type system | `KodaAgentRole = AgentRole` | Typos in service code at compile time |
| DTO validation | `@IsIn([...AGENT_ROLES])` on `UpdateRolesDto.roles` and `CreateAgentDto.roles` | Bad values from API clients at the boundary |
| Seed | `for (const role of AGENT_ROLES) { ... }` | Seed and type can never drift |
| Startup audit (optional) | On boot, `SELECT DISTINCT role FROM agent_role_entries`, fail fast if any value isn't in `AGENT_ROLES` | Direct SQL writes / migration-introduced drift |

### Audit step (one-time gate)

Before committing the narrow union, run against staging + prod:

```sql
SELECT role, COUNT(*) FROM agent_role_entries GROUP BY role;
```

Then:
- If only the four expected values → commit the constant + validator.
- If typos or legacy values → either (a) clean them up via one-shot data migration first, or (b) include them in `AGENT_ROLES` deliberately.

This is a one-time gate, not an ongoing process. Once narrow + validated, drift only comes from direct SQL, which the optional startup audit catches.

### Why not seeds-as-SSOT, Prisma enums, or a lookup table

- **Seeds** populate data, they don't constrain it. They don't help the type system. They don't catch writes after install.
- **Prisma enums** — banned by project rule.
- **Lookup table with FK** (`agent_role` table) — most rigorous (DB enforces it), but overkill for a 4-value enum that changes rarely. Worth it only if you'd attach metadata (display name, permission templates) to each role.

### Tasks (small, can be a separate commit before the CASL work)

1. Add `AGENT_ROLES` const + `AgentRole` type to `src/common/enums.ts`.
2. Replace `KodaAgentRole = string` with `import { AgentRole as KodaAgentRole } from '../../common/enums'` in `koda-principal.types.ts`.
3. Replace the `role as AgentRole` casts in [`agents.service.ts:157, 257`](../../apps/api/src/agents/agents.service.ts#L157) with explicit validation that throws `ValidationAppException` on invalid values.
4. Add `@IsIn([...AGENT_ROLES])` to `roles` fields on `CreateAgentDto` and `UpdateRolesDto`.
5. (Optional) Add startup audit in `main.ts` or a `HealthCheck` that fails fast if `agent_role_entries.role` contains values outside `AGENT_ROLES`.

After this lands, the CASL factory's switch statement gets exhaustiveness checking via `assertNever(role)` in the `default:` branch — TypeScript will refuse to compile if a new role is added to `AGENT_ROLES` without also adding a permission case here.

---

## CASL Action / Subject Taxonomy

Define the action/subject space upfront so factory + decorators stay aligned.

### Actions (`KodaAction`)

```typescript
export enum KodaAction {
  CREATE = 'create',
  READ = 'read',
  UPDATE = 'update',
  DELETE = 'delete',
  MANAGE = 'manage',         // wildcard — grants all of the above
  ASSIGN = 'assign',          // ticket-specific: assign to user/agent
  TRANSITION = 'transition',  // ticket-specific: change status via state machine
  ROTATE_KEY = 'rotateKey',   // agent-specific: rotate API key
}
```

### Subjects (`KodaSubject`)

```typescript
export type KodaSubject =
  | 'Comment'
  | 'Label'
  | 'Ticket'
  | 'Project'
  | 'Agent'
  | 'AgentScope'    // virtual subject for "agent-authenticated routes"
  | 'AdminScope'    // virtual subject for legacy ADMIN-only gates
  | 'all';          // wildcard
```

Subjects that map to Prisma models (`Comment`, `Ticket`, etc.) accept ownership conditions. Virtual subjects (`AgentScope`, `AdminScope`) are pure role gates.

---

## Component Design

### 1. `KodaCaslAbilityFactory` (new)

`apps/api/src/auth/casl/koda-casl-ability.factory.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { BaseCaslAbilityFactory, CaslPermission } from '@nathapp/nestjs-auth';
import { KodaPrincipal, isUserPrincipal } from '../principal/koda-principal.types';
import { KodaAction } from './koda-action.enum';

@Injectable()
export class KodaCaslAbilityFactory extends BaseCaslAbilityFactory {
  async getPermissions(principal: KodaPrincipal): Promise<CaslPermission[]> {
    if (isUserPrincipal(principal)) {
      return this.userPermissions(principal);
    }
    return this.agentPermissions(principal);
  }

  private userPermissions(principal: UserPrincipal): CaslPermission[] {
    if (principal.role === 'ADMIN') {
      return [
        { action: KodaAction.MANAGE, subject: 'all' },
      ];
    }
    // MEMBER
    return [
      { action: KodaAction.READ, subject: 'all' },
      { action: KodaAction.CREATE, subject: 'Comment' },
      { action: KodaAction.UPDATE, subject: 'Comment', conditions: { authorUserId: principal.id } },
      { action: KodaAction.DELETE, subject: 'Comment', conditions: { authorUserId: principal.id } },
      { action: KodaAction.CREATE, subject: 'Ticket' },
      // MEMBERs cannot mutate Labels (current behavior)
      // MEMBERs cannot soft-delete Tickets (current behavior)
    ];
  }

  private agentPermissions(principal: AgentPrincipal): CaslPermission[] {
    return [
      // Agent-authenticated routes
      { action: KodaAction.READ, subject: 'AgentScope' },

      // Resource permissions
      { action: KodaAction.READ, subject: 'all' },
      { action: KodaAction.CREATE, subject: 'Comment' },
      { action: KodaAction.UPDATE, subject: 'Comment', conditions: { authorAgentId: principal.id } },
      { action: KodaAction.DELETE, subject: 'Comment', conditions: { authorAgentId: principal.id } },
      { action: KodaAction.MANAGE, subject: 'Label' },     // agents bypass MEMBER restriction
      { action: KodaAction.CREATE, subject: 'Ticket' },

      // Role-derived permissions (from agentRoles)
      ...this.agentRoleDerivedPermissions(principal),
    ];
  }

  private agentRoleDerivedPermissions(principal: AgentPrincipal): CaslPermission[] {
    const perms: CaslPermission[] = [];
    for (const role of principal.agentRoles) {
      switch (role) {
        case 'DEVELOPER':
          perms.push({ action: KodaAction.TRANSITION, subject: 'Ticket' });
          break;
        case 'REVIEWER':
          perms.push({ action: KodaAction.TRANSITION, subject: 'Ticket' });
          break;
        case 'VERIFIER':
          perms.push({ action: KodaAction.TRANSITION, subject: 'Ticket' });
          break;
        case 'TRIAGER':
          perms.push({ action: KodaAction.UPDATE, subject: 'Ticket' });
          break;
        default:
          // Exhaustiveness check: requires the prerequisite — once
          // KodaAgentRole is a strict union, TypeScript fails to compile
          // if a new role is added to AGENT_ROLES without a case here.
          assertNever(role);
      }
    }
    return perms;
  }
}
```

The factory is the **only** place authorization rules are defined. Adding/changing a rule = editing this file.

### 2. Module wiring

`apps/api/src/auth/auth.module.ts` — extend the existing `NathappAuthModule.forRootAsync(...)`:

```typescript
NathappAuthModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  authProvider: { useClass: JwtAuthProvider },
  caslAbilityFactory: { useClass: KodaCaslAbilityFactory },  // ← new
  useFactory: (config: ConfigService) => ({ /* unchanged */ }),
}),
```

`KodaCaslAbilityFactory` added to `providers` and `exports`.

### 3. Service-level helper (optional)

Inside services, the typical CASL call is:

```typescript
const ability = await this.abilityFactory.createForPrincipal(principal);
if (!ability.can(KodaAction.UPDATE, comment)) {
  throw new ForbiddenAppException({}, 'comments');
}
```

To avoid the boilerplate `createForPrincipal` everywhere, expose a thin helper or rely on the library's `PolicyService` pattern. Confirm what `@nathapp/nestjs-auth` provides before designing this — likely `AbilityBuilderService` or similar from the lib.

---

## Migration Sites

### Pure role / actorType gates → `@RequiredPermission([action, subject])` on the controller

| Site | Current | After |
|---|---|---|
| `agents.controller.ts:findMe` (the `actorType !== 'agent'` check from final-review N2) | inline throw | `@RequiredPermission([KodaAction.READ, 'AgentScope'])` |
| `tickets.service.ts:298-300` (user-only ADMIN check on `softDelete`) | inline throw in service | `@RequiredPermission([KodaAction.DELETE, 'Ticket'])` on the controller; ability factory grants `DELETE Ticket` only to ADMIN users |
| `labels.service.ts:30-32, 91-93, 138-140` (MEMBER-deny on Labels) | inline throw in service | `@RequiredPermission([KodaAction.MANAGE, 'Label'])` on each label controller route; ability factory grants `MANAGE Label` to ADMIN + agents only |

### Ownership checks → `ability.can(action, instance)` in service

| Site | Current | After |
|---|---|---|
| `comments.service.ts:160-164` (`update` author-or-admin) | inline `isAuthor && isAdmin` | `if (!ability.can(KodaAction.UPDATE, comment)) throw` — CASL evaluates `conditions: { authorUserId/authorAgentId: principal.id }` against the loaded `comment` instance |
| `comments.service.ts:190-194` (`delete` author-or-admin) | inline | `if (!ability.can(KodaAction.DELETE, comment)) throw` |

These checks happen **after** the comment is loaded (CASL needs the resource instance to evaluate conditions). The decorator alone can't enforce them.

---

## Risks

### R1 — Loading vs. checking ordering for ownership rules

`@RequiredPermission([UPDATE, 'Comment'])` checks "can the user update *any* comment?" — not "can they update *this specific one*?". For ownership-conditional rules, the service must:
1. Load the resource.
2. Call `ability.can(action, instance)`.
3. Throw on failure.

**Mitigation**: keep the decorator as a coarse gate (rejects users with no `Comment.UPDATE` ability at all) and the service-layer `ability.can(action, instance)` as the precise check. CASL's design supports this two-layer pattern naturally.

### R2 — Subject identification with plain Prisma objects

CASL identifies subjects by class name. Prisma returns plain objects, not class instances, so `ability.can(action, comment)` won't auto-detect `comment` as the `'Comment'` subject. Two options:

- Wrap with CASL's `subject(name, instance)` helper: `ability.can(KodaAction.UPDATE, subject('Comment', comment))`.
- Configure `detectSubjectType` on the ability builder.

**Mitigation**: pick `subject()` wrapping — explicit, no global config required. Document the pattern in the factory's JSDoc.

### R3 — `manage all` for ADMIN may be too permissive

ADMIN users currently get `{ action: 'manage', subject: 'all' }` in the sketch. This means any new resource added to the system gets ADMIN access by default. For a tracker app this is usually correct, but it's a **policy decision** that should be explicit, not accidental.

**Mitigation**: choose explicitly. Either:
- Keep `manage all` and document the intent.
- Enumerate ADMIN permissions per subject. More verbose but no surprises when new resources are added.

### R4 — Test fixture rewrites

Every test that asserts "agent gets 403" or "MEMBER gets 403" needs to verify the same outcome via CASL instead of via the old inline check. Behavior should be identical, but assertion patterns may shift (e.g. tests that mocked services no longer need to mock authorization — it happens in the guard/factory layer).

**Mitigation**: write tests against `KodaCaslAbilityFactory.getPermissions(principal)` directly — assert that the returned permission list matches expected for ADMIN/MEMBER/agent. Then trust the library's `@RequiredPermission` to wire it into the guard. Reduces test surface.

### R5 — `PermissionAuthGuard` already global; route-level `@RequiredPermission` deps on it

Confirmed in PR1 — the guard is registered via `app.useAppGlobalGuards()` in [main.ts:50](../../apps/api/src/main.ts#L50). No additional registration needed. The `caslAbilityFactory` option in `AuthModule.forRoot` wires the factory into the guard.

### R6 — CASL JSON serialization

`CaslPermission` rules are serializable. If permissions are ever cached (e.g. on the principal in cache.module.ts), JSON round-tripping is safe. Conditions like `{ authorUserId: principal.id }` are plain objects.

**Mitigation**: not an issue today — permissions are computed per-request inside the guard. Cache integration would be a follow-up.

---

## Files Touched

### Create

- `apps/api/src/auth/casl/koda-action.enum.ts` — `KodaAction` enum + `KodaSubject` type union.
- `apps/api/src/auth/casl/koda-casl-ability.factory.ts` — the single source of truth for permissions.
- `apps/api/src/auth/casl/koda-casl-ability.factory.spec.ts` — exhaustive permission list assertions per actor type / role.
- `apps/api/src/common/utils/assert-never.ts` (if not already present) — helper for exhaustiveness checks.

### Modify

- `apps/api/src/common/enums.ts` — add `AGENT_ROLES` const + `AgentRole` type (Prerequisite section).
- `apps/api/src/auth/principal/koda-principal.types.ts` — replace `KodaAgentRole = string` with import from `common/enums`.
- `apps/api/src/agents/agents.service.ts` — replace `role as AgentRole` casts (lines 157, 257) with `@IsIn`-validated values plus an `assertAgentRole()` runtime check.
- `apps/api/src/agents/dto/create-agent.dto.ts` and `update-roles.dto.ts` — add `@IsIn([...AGENT_ROLES])` to `roles` fields.
- `apps/api/src/auth/auth.module.ts` — register `KodaCaslAbilityFactory` via `caslAbilityFactory` option, add to providers/exports.
- `apps/api/src/comments/comments.controller.ts` — add `@RequiredPermission([KodaAction.UPDATE, 'Comment'])` and `[DELETE, 'Comment']` on the routes.
- `apps/api/src/comments/comments.service.ts` — replace inline `isAuthor / isAdmin` with `ability.can(action, subject('Comment', comment))`. Inject ability builder service.
- `apps/api/src/labels/labels.controller.ts` — add `@RequiredPermission([KodaAction.MANAGE, 'Label'])` to mutation routes.
- `apps/api/src/labels/labels.service.ts` — delete the 3 inline `MEMBER`-deny throws; rule now lives in the factory.
- `apps/api/src/tickets/tickets.controller.ts` — add `@RequiredPermission([KodaAction.DELETE, 'Ticket'])` on `softDelete`.
- `apps/api/src/tickets/tickets.service.ts` — delete the inline ADMIN check from `softDelete`.
- `apps/api/src/agents/agents.controller.ts` — add `@RequiredPermission([KodaAction.READ, 'AgentScope'])` on `findMe`; delete the inline `actorType !== 'agent'` check.
- Test fixtures — switch from "mock principal with role X" assertions to factory-level assertions where possible.

### Delete

- The 9 inline authorization sites listed above.

---

## Verification

1. **Prerequisite verification** — confirm DB audit query returned only the four expected `AGENT_ROLES` values. Confirm `bun run type-check` passes after narrowing `KodaAgentRole`. Confirm a synthetic `POST /agents` with `roles: ['DEVLOPER']` (typo) returns 400 from the DTO validator, not 500 from a downstream cast.
2. **Unit tests for the factory** — assert `getPermissions(adminUserPrincipal)` includes `{ action: 'manage', subject: 'all' }`; `getPermissions(memberUserPrincipal)` excludes `MANAGE Label`; `getPermissions(developerAgentPrincipal)` includes `TRANSITION Ticket`. One assertion per role × subject combination.
3. **Integration tests** — preserve every authorization scenario from PR1's verification:
   - Human ADMIN can soft-delete tickets; MEMBER cannot.
   - Comment author (user) can edit own comment; another user gets 403.
   - Comment author (agent) can edit own comment; another agent gets 403.
   - Agent can call `/agents/me`; user gets 403.
   - MEMBER user cannot create labels; ADMIN and agent can.
4. **Type-check** — `bun run type-check`. Verify `KodaSubject` enum is exhaustive against actual usage.
5. **OpenAPI regeneration** — `bun run generate`. Permission requirements should appear in route metadata; confirm Swagger UI reflects the new gates.
6. **Grep audit** — no remaining hits for:
   - `isUserPrincipal\(.*\) && .*\.role === 'ADMIN'` (use ability instead)
   - `if .*authorUserId === .*\.id` outside the factory (use ability conditions)
   - `principal\.actorType !== 'agent'` outside the factory (use `AgentScope`)

---

## Out of Scope (for a future PR)

- **`KodaDomainWriter.assertActorHasEventRole`** — also a role-based check, but it operates on synthetic event-payload actors, not request principals. Would need a different abstraction (e.g. an `EventActorPolicy`). Defer.
- **Project membership policies** — `ProjectsController.checkProjectMembership` is project-scoped, not principal-scoped. CASL conditions can express it (`{ projectId: { $in: principal.projectIds } }`) but that requires loading project memberships into the principal. Significant scope. Defer.
- **Permission caching** — recomputing the ability list on every request is fine for now. If a profile shows it matters, cache `{ ability: <serialized rules> }` on `AgentPrincipal.extra` (already cached for 60s).
- **CASL conditions with Prisma queries** — CASL's MongoDB-style conditions don't translate directly to Prisma `where` clauses. List-filtering authorization (e.g. "show me only comments I can update") is not in this PR; instance-level checks only.
