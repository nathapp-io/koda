# Consolidate Actor Auth into Typed `KodaPrincipal`

## Context

Today the API has two parallel auth pipelines that produce two different request shapes:

- `JwtAuthGuard` (humans) → `request.user: IPrincipal`
- `CombinedAuthGuard.tryApiKey()` (agents) → `request.agent: PrismaAgent`, `request.actorType: 'agent'`, and **explicitly deletes `request.user`**

This divergence at the request boundary forces every downstream layer to cope:

- A custom `@CurrentUser()` decorator returns `request.user || request.agent` — a union of two unrelated types with no discriminator.
- A custom `@CurrentActor()` decorator wraps the same union in `{ currentUser, actorType }` — but the field is called `currentUser` even when it holds an `Agent`.
- 19 service methods carry `(currentUser, actorType)` pairs through the call graph.
- Authorization is hand-rolled with `currentUser?.extra?.role !== 'ADMIN'` checks — bypassing the library-native `@RequiredPermission()`.
- `ActorResolverService` exists solely to re-normalize the two request shapes into one `Actor` type, and re-queries `AgentRoleEntry` per call.
- The compliance checklist in `nathapp-nestjs-patterns` explicitly forbids custom `@CurrentUser()` — the library's `@Principal()` is the canonical decorator.

The intended outcome: **one auth pipeline, one principal shape on the request, one decorator, one typed actor model**, and library-native authorization for both humans and agents.

---

## Architectural Target

```
┌────────────────────────────────────────────────────────────────┐
│ CombinedAuthGuard                                              │
│   ├─ tryApiKey()  ─► AgentAuthProvider.buildPrincipal(agent)   │
│   └─ JWT fallback ─► JwtAuthProvider.getPrincipal(jwtPayload)  │
│                                                                │
│   Both write request.user: KodaPrincipal                       │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    @Principal() principal: KodaPrincipal
                              │
        ┌─────────────────────┴─────────────────────┐
        ▼                                           ▼
@RequiredPermission('ADMIN')            services receive single
(pure role gates)                       KodaPrincipal parameter
```

- One canonical request property: `request.user`. `request.agent` and `request.actorType` are deleted.
- One decorator: `@Principal()` from `@nathapp/nestjs-auth`. Custom `@CurrentUser()` and `@CurrentActor()` are deleted.
- Typed discriminated union (`KodaPrincipal = UserPrincipal | AgentPrincipal`) instead of untyped `extra: any`.
- `IPrincipal.authorities` populated for both actor types so the library's `@RequiredPermission()` works uniformly.

---

## Type Design

The `IPrincipal` interface from `@nathapp/nestjs-auth` allows extension fields directly on the principal (per the `AccountAuthProvider` pattern). We define typed subtypes with `actorType` as the discriminant — much safer than nesting in untyped `extra`.

`apps/api/src/auth/principal/koda-principal.types.ts` (new):

```typescript
import type { IPrincipal } from '@nathapp/nestjs-auth';

export type KodaUserRole = 'MEMBER' | 'ADMIN';
export type KodaAgentStatus = 'ACTIVE' | 'PAUSED';
// Agent roles are stored as free-form strings in `AgentRoleEntry.role` today.
// Keep `string` here until the DB values are audited (see Risk #5); narrow
// to a union (`'DEVELOPER' | 'REVIEWER' | 'VERIFIER' | 'TRIAGER'`) afterwards.
export type KodaAgentRole = string;

export interface UserPrincipal extends IPrincipal {
  actorType: 'user';
  id: string;          // narrowed (no longer `string | undefined`)
  role: KodaUserRole;
  email: string;
}

export interface AgentPrincipal extends IPrincipal {
  actorType: 'agent';
  id: string;
  slug: string;
  status: KodaAgentStatus;
  agentRoles: KodaAgentRole[];   // typed mirror of authorities
  capabilities: string[];
}

export type KodaPrincipal = UserPrincipal | AgentPrincipal;

export const isUserPrincipal = (p: KodaPrincipal): p is UserPrincipal =>
  p.actorType === 'user';
export const isAgentPrincipal = (p: KodaPrincipal): p is AgentPrincipal =>
  p.actorType === 'agent';
```

`authorities` (inherited from `IPrincipal`) is populated as:
- `UserPrincipal.authorities = [role]` — e.g. `['ADMIN']`
- `AgentPrincipal.authorities = agentRoles` — e.g. `['DEVELOPER', 'REVIEWER']`

This is what `@RequiredPermission('ADMIN')` reads.

---

## Component Changes

### 1. `JwtAuthProvider` → typed `UserPrincipal`

`apps/api/src/auth/jwt-auth.provider.ts` — extend the existing provider so the principal it returns is shaped as `UserPrincipal`:

```typescript
async getPrincipal(jwtPayload: Record<string, unknown>): Promise<UserPrincipal> {
  const role = (jwtPayload['role'] as KodaUserRole) ?? 'MEMBER';
  return {
    actorType: 'user',
    id: jwtPayload['sub'] as string,
    name: (jwtPayload['email'] as string) ?? (jwtPayload['sub'] as string),
    email: jwtPayload['email'] as string,
    role,
    blacklisted: false,
    revoked: false,
    authorities: [role],            // ← drives @RequiredPermission()
    extra: { sub: jwtPayload['sub'] }, // kept only if any caller reads .extra.sub
  };
}
```

### 2. `AgentAuthProvider` (new) — typed `AgentPrincipal` with caching

`apps/api/src/auth/agent-auth.provider.ts` (new). One DI-resolvable service that loads agent + roles + capabilities and returns an `AgentPrincipal`. Backed by `@nathapp/nestjs-cache` with tag-based invalidation so per-request cost is amortized:

```typescript
@Injectable()
export class AgentAuthProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheManager,
  ) {}

  async buildPrincipal(agent: Agent): Promise<AgentPrincipal> {
    return this.cache.get<AgentPrincipal>(
      ['agent-principal', agent.id, agent.status],
      async () => {
        const [roleEntries, capEntries] = await Promise.all([
          this.prisma.client.agentRoleEntry.findMany({ where: { agentId: agent.id } }),
          this.prisma.client.agentCapabilityEntry.findMany({ where: { agentId: agent.id } }),
        ]);
        const agentRoles = roleEntries.map((r) => r.role as KodaAgentRole);
        return {
          actorType: 'agent',
          id: agent.id,
          name: agent.slug,
          slug: agent.slug,
          status: agent.status as KodaAgentStatus,
          agentRoles,
          capabilities: capEntries.map((c) => c.capability),
          blacklisted: agent.status === 'PAUSED',
          revoked: false,
          authorities: agentRoles,        // ← drives @RequiredPermission()
        };
      },
      60_000, // 1 min TTL — short enough that role changes propagate within a minute even without explicit invalidation
      { tags: [`AGENT:${agent.id}`, `AGENT:${agent.id}:PRINCIPAL`] },
    );
  }
}
```

**Cache strategy choice**: project's existing `CacheModule.register()` strategy is reused. If the project is currently single-pod (`MEMORY`) this is fine; for multi-pod (`DISTRIBUTED`/`MULTI_TIER`) the tag-based invalidation also works and stays consistent across pods.

**Cache invalidation** — performed at the mutation sites where agents change:
- `agents.service.update*` (role grant/revoke, capability change, status change) → `cache.invalidateByTag(\`AGENT:${agentId}\`)`
- API key rotation/regeneration → same tag invalidation
- Agent deletion → same tag invalidation
- The 60s TTL is the safety net for any mutation site we miss; explicit tag invalidation is the fast path.

**Cache key includes status**: writes a fresh entry when an agent transitions ACTIVE↔PAUSED so the `blacklisted` field stays accurate even before the previous entry expires.

### 3. `CombinedAuthGuard` — slimmed and unified

`apps/api/src/auth/guards/combined-auth.guard.ts`:
- Inject `AgentAuthProvider`.
- `tryApiKey()` no longer mutates `request.agent` / `request.actorType` and no longer deletes `request.user`. After agent verification, it calls `agentAuthProvider.buildPrincipal(agent)` and assigns to `request.user`.
- JWT fallback path is unchanged — `JwtAuthProvider` already produces a `UserPrincipal`.
- Remove the verbose debug logging (or keep at debug level only).

### 4. Decorators — delete custom, use library

Delete:
- `apps/api/src/auth/decorators/current-user.decorator.ts` (both `@CurrentUser()` and `@CurrentActor()` definitions)

Replace usages with `@Principal()` from `@nathapp/nestjs-auth`. Controllers declare the type explicitly:

```typescript
async create(@Body() dto: CreateTicketDto, @Principal() principal: KodaPrincipal) { ... }
```

(`@Principal()` returns `IPrincipal`; the explicit `KodaPrincipal` annotation narrows it for downstream use. No runtime cast needed — the guard guarantees the shape.)

### 5. Service signatures — collapse the pair

19 service methods change from `(..., currentUser, actorType)` to `(..., principal: KodaPrincipal)`. Inside services:

- Type-switch FK writes use a helper:

  `apps/api/src/auth/principal/actor-foreign-keys.ts` (new):
  ```typescript
  export function actorForeignKeys(
    principal: KodaPrincipal,
    prefix: 'createdBy' | 'authoredBy' | 'assignedTo' | 'actor',
  ): Record<string, string | null> {
    const isUser = isUserPrincipal(principal);
    const userField = prefix === 'actor' ? 'actorUserId' :
                      prefix === 'authoredBy' ? 'authorUserId' :
                      `${prefix}UserId`;
    const agentField = prefix === 'actor' ? 'actorAgentId' :
                       prefix === 'authoredBy' ? 'authorAgentId' :
                       `${prefix}AgentId`;
    return {
      [userField]: isUser ? principal.id : null,
      [agentField]: isUser ? null : principal.id,
    };
  }
  ```

- Conditional/ownership checks use the type guards:
  ```typescript
  // Before: if (actorType === 'user' && currentUser.role === 'ADMIN')
  // After:  if (isUserPrincipal(principal) && principal.role === 'ADMIN')
  // Or:     if (principal.authorities.includes('ADMIN'))
  ```

### 6. `ActorResolverService` — delete

`apps/api/src/events/actor-resolver.service.ts` is removed. Its three callers in `koda-domain-writer.service.ts` (lines 80, 111, 143) construct synthetic actor data from event payloads, then call `assertActorHasEventRole`. Refactor: keep `assertActorHasEventRole` (move it inline to KodaDomainWriter), and replace the resolve+check chain with a direct authority list lookup. For agent events the existing `AgentAuthProvider.buildPrincipal()` can be reused; for user events the role comes from the event payload itself.

### 7. Pure role gates → `@RequiredPermission()`

Migrate the 12 pure ADMIN gates to library-native authorization (full list in Risk section).

---

## Risk Analysis — `@RequiredPermission()` Migration

### What's safe to migrate (12 sites, all "ADMIN-only")

| File | Lines |
|---|---|
| `outbox/admin.controller.ts` | 26, 48 |
| `rag/rag.controller.ts` | 134, 187, 212 |
| `agents/agents.controller.ts` | 21, 50, 57, 65, 73, 80 |

All currently do `if (currentUser?.extra?.role !== 'ADMIN') throw ForbiddenAppException`. Replace with `@RequiredPermission('ADMIN')` at the handler level and delete the inline check.

### What CANNOT migrate to `@RequiredPermission('ROLE')` in this PR (9 sites)

| File | Lines | Shape |
|---|---|---|
| `labels/labels.service.ts` | 32, 97, 138 | "MEMBER role denied unless agent" — role + actorType branching |
| `comments/comments.service.ts` | 164, 167, 195, 198 | "is author OR is admin" — ownership + role disjunction |
| `tickets/tickets.service.ts` | 306 | "user-only ADMIN check" — different rule for users vs agents |

**These should ultimately migrate to CASL** (deferred to follow-up PR — see "Deferred Work" below). For this PR they stay in the service layer but get rewritten to use the typed principal:

```typescript
// Before
if (actorType === 'user' && currentUser.role === 'ADMIN') { ... }

// After
if (isUserPrincipal(principal) && principal.role === 'ADMIN') { ... }
// Or for ownership-disjunction:
const isAuthor = isUserPrincipal(principal)
  ? comment.authorUserId === principal.id
  : comment.authorAgentId === principal.id;
const isAdmin = principal.authorities.includes('ADMIN');
```

This rewrite is a prerequisite for the CASL follow-up — once these read from a typed `KodaPrincipal`, swapping the inline check for `ability.can('update', comment)` is a localized change.

### Risks and mitigations

1. **JWT may not currently include `authorities`** — `JwtAuthProvider` reads `jwtPayload['authorities'] ?? []`. Today this is likely empty. **Mitigation**: derive `authorities = [role]` in `JwtAuthProvider.getPrincipal()` regardless of whether the JWT carries it. No change to JWT issuance is required.

2. **Test fixtures may build principals manually** — any unit/integration test that mocks `request.user` with the old shape will break. **Mitigation**: provide a `buildTestUserPrincipal()` / `buildTestAgentPrincipal()` factory in a test helper. Grep for `extra: { role` in `test/` to find affected fixtures.

3. **Library `PermissionAuthGuard` registration** — pure role gates only fire if `PermissionAuthGuard` is globally applied. Per `nathapp-nestjs-patterns/auth.md`: "applied globally by nestjs-app". Confirm this in `main.ts`/`AppFactory` bootstrap before relying on `@RequiredPermission()`. **Mitigation**: if not globally applied, add it as a global guard alongside the existing `CombinedAuthGuard` registration in `apps/api/src/main.ts`.

4. **Agent endpoints accidentally locked out** — some endpoints currently allow agents through implicitly because the inline check uses `currentUser?.extra?.role`, which is `undefined` for agents and `'ADMIN'` is required — so today, **agents already get 403 on these endpoints**. Migrating to `@RequiredPermission('ADMIN')` preserves this behavior because no agent has `'ADMIN'` in its authorities. ✅ No behavior change.

5. **`AgentRoleEntry` role string mismatch** — narrowing `KodaAgentRole` to a strict union risks runtime values that don't match. **Mitigation**: ship this PR with `KodaAgentRole = string`. Before merging, run `SELECT DISTINCT role FROM agent_role_entries` (or equivalent Prisma query) and audit the distinct values. If the set is small and stable, narrow the union in a follow-up commit (one-line type change). This keeps the PR safe even if the DB has unexpected values.

6. **Per-request DB cost** — `AgentAuthProvider.buildPrincipal()` runs two queries (roles + capabilities) on every authenticated agent request. Today, only role-using endpoints query `AgentRoleEntry` (via `ActorResolverService`); we'd otherwise shift this work to the auth boundary on every request. **Mitigation**: cache the built `AgentPrincipal` via `@nathapp/nestjs-cache` (`CacheManager`) with cache-aside pattern — see `AgentAuthProvider` design above. 60s TTL + tag-based invalidation on agent mutations. The cache key includes `agent.status`, so status transitions don't serve stale `blacklisted` values. Net per-request cost: one cache GET (L1 hit if `MULTI_TIER`, no DB hit on the hot path).

7. **`koda-domain-writer.service.ts` couples to `ActorResolverService`** — three call sites construct mock requests and call `resolve()`. After deletion, these sites need their own role lookup path. **Mitigation**: extract `assertActorHasEventRole` into KodaDomainWriter. Add a small `loadAgentRoles(agentId: string): Promise<string[]>` method on `AgentAuthProvider` that performs the same `agentRoleEntry.findMany` query (and shares the cache key/tag) — `buildPrincipal()` calls it internally; KodaDomainWriter calls it directly without needing a full `Agent` record. For user actors the role comes from the event payload (`data.actorRole`, defaulting to `'MEMBER'`).

8. **Cross-cutting `actorType === 'agent'` business logic** — `rag/rag.controller.ts:56` and `projects/projects.controller.ts:51` use actorType for **business logic** (agents are cross-project, users are scoped). These are not authorization. They migrate to `isAgentPrincipal(principal)` for type safety but the behavior is unchanged.

---

## Deferred Work — CASL Migration (follow-up PR)

The 9 conditional/ownership/role-mixing sites listed above are good CASL candidates. `@RequiredPermission([action, subject])` accepts CASL pairs and integrates with a custom `BaseCaslAbilityFactory` that builds per-principal abilities:

```typescript
// Sketch of the CASL ability (in the follow-up PR, not this one)
@Injectable()
export class KodaCaslAbilityFactory extends BaseCaslAbilityFactory {
  async getPermissions(principal: KodaPrincipal): Promise<CaslPermission[]> {
    if (isUserPrincipal(principal)) {
      if (principal.role === 'ADMIN') return [{ action: 'manage', subject: 'all' }];
      return [
        { action: 'read', subject: 'all' },
        { action: 'update', subject: 'Comment', conditions: { authorUserId: principal.id } },
        { action: 'delete', subject: 'Comment', conditions: { authorUserId: principal.id } },
      ];
    }
    // agent
    return [
      { action: 'manage', subject: 'Label' },                                       // agents bypass MEMBER restriction
      { action: 'update', subject: 'Comment', conditions: { authorAgentId: principal.id } },
      { action: 'delete', subject: 'Comment', conditions: { authorAgentId: principal.id } },
      ...principal.agentRoles.flatMap((r) => roleToCaslPermissions(r)),
    ];
  }
}
```

**Why deferred**: setting up the ability factory, classifying every domain action against a `subject` taxonomy, and integrating CASL conditions with Prisma-loaded entities is a separate design effort. It would roughly double the size and review surface of this PR. The current PR sets up the prerequisites (typed principal, populated `authorities`, normalized `request.user`), so the follow-up becomes a focused addition rather than a tangled refactor.

**Why not just leave the conditional checks alone forever**: hand-rolled `is author OR is admin` in services is exactly the duplication CASL was designed to eliminate; doing it once in an ability factory is more maintainable and more secure (centralized policy).

---

## Files Touched

### Create
- `apps/api/src/auth/principal/koda-principal.types.ts` — type definitions + guards
- `apps/api/src/auth/principal/actor-foreign-keys.ts` — FK helper
- `apps/api/src/auth/agent-auth.provider.ts` — agent → `AgentPrincipal` builder
- `apps/api/test/helpers/principal.ts` — test fixture factories

### Modify
- `apps/api/src/auth/jwt-auth.provider.ts` — return typed `UserPrincipal`, populate `authorities`
- `apps/api/src/auth/guards/combined-auth.guard.ts` — delegate to `AgentAuthProvider`, write `request.user` only
- `apps/api/src/auth/auth.module.ts` — provide `AgentAuthProvider`
- 8 controllers (`agents`, `tickets`, `comments`, `labels`, `rag`, `projects`, `memory`, `outbox/admin`) — swap decorators, add `@RequiredPermission('ADMIN')` to 12 handlers
- 4 services (`tickets/tickets.service`, `comments/comments.service`, `labels/labels.service`, `tickets/state-machine/ticket-transitions.service`) — collapse signatures, use type guards + `actorForeignKeys`
- `apps/api/src/agents/agents.service.ts` — invalidate `AGENT:${id}` cache tag on role/capability/status mutations
- `apps/api/src/koda-domain-writer/koda-domain-writer.service.ts` — replace `ActorResolverService` calls
- `apps/api/src/app.module.ts` — register `CacheModule` if not already registered (check current state); confirm `MULTI_TIER` or `DISTRIBUTED` for prod
- `apps/api/src/main.ts` — confirm/add `PermissionAuthGuard` global registration

### Delete
- `apps/api/src/auth/decorators/current-user.decorator.ts`
- `apps/api/src/events/actor-resolver.service.ts` (and its module wiring)
- Any DTO/local types named `CurrentUser` / `AnyUser` / `AdminUser` superseded by `KodaPrincipal`

---

## Verification

1. **Type-check**: `bun run type-check` (full monorepo) — flushes out any missed `currentUser`/`actorType` references and any service that still passes the old pair.
2. **Unit tests**: `cd apps/api && bun run test` — ensure all `*.spec.ts` pass after fixture updates.
3. **Integration tests**: `cd apps/api && bun run test:integration` — covers auth boundary + state-machine flows; specifically validates that:
   - JWT auth still produces `UserPrincipal` with correct role
   - API key auth produces `AgentPrincipal` with correct `agentRoles` from DB
   - `@RequiredPermission('ADMIN')` returns 403 for non-admin users and for any agent
   - Author-or-admin checks in `comments.service.ts` still work after refactor
   - Agent principal cache hit on second consecutive request — assert via the `CacheMetrics` `onCacheHit`/`onCacheMiss` hook (the `X-Cache` header is set by `CacheInterceptor`, not by the cache-aside `CacheManager.get()` we use here, so it does not apply)
   - Agent role mutation invalidates `AGENT:${id}` cache tag and the next request reloads fresh roles
4. **Manual smoke (one happy path each)**:
   - Human ADMIN logs in, calls `POST /agents/generate-api-key` → 200
   - Human MEMBER calls same → 403 (now from `@RequiredPermission`, not inline check)
   - Agent calls `GET /agents/me` → 200 with agent's data
   - Agent calls `POST /projects/:slug/tickets` with `DEVELOPER` role → ticket persisted with `createdByAgentId` populated
   - Comment author (agent) edits own comment → 200; another agent edits same comment → 403
5. **OpenAPI regeneration**: `bun run generate` — confirm the spec change set is purely DTO/type cleanup, no contract breakage.
6. **`grep` audit** before merging — no remaining hits for any of:
   - `@CurrentUser`, `@CurrentActor`
   - `request.agent`, `request.actorType`
   - `currentUser?.extra?.role`
   - `currentUser, actorType` in service signatures
   - `ActorResolverService`
