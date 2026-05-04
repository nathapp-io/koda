# Code Review — `feat/consolidate-koda-principal`

- **Spec**: [`20260504-consolidate-actor-auth-koda-principal.md`](./20260504-consolidate-actor-auth-koda-principal.md)
- **Branch**: `feat/consolidate-koda-principal`
- **Commit**: `b0051ea` — *feat(api): consolidate actor auth into KodaPrincipal*
- **Diff**: 34 files, +1417 / −673
- **Reviewer**: Claude (sonnet-4-6) — automated structural review against the spec
- **Date**: 2026-05-04

---

## Verdict

The spec was followed for the **surface-level pieces** (decorator removal, type definitions, ADMIN gates, `ActorResolverService` deletion) but **the deeper architectural goals were not delivered**. Five critical deviations need to be addressed before merge.

| Severity | Count |
|---|---|
| 🔴 Critical | 5 |
| 🟡 Medium | 5 |
| 🟢 Low | 5 |

---

## What's Right

- Custom `@CurrentUser()` / `@CurrentActor()` decorators **fully removed** (0 grep hits).
- `request.agent` / `request.actorType` writes **fully removed** (0 grep hits).
- `ActorResolverService` **deleted**; `assertActorHasEventRole` correctly inlined into `KodaDomainWriter` ([koda-domain-writer.service.ts:56-68](../../apps/api/src/koda-domain-writer/koda-domain-writer.service.ts#L56-L68)).
- New `loadAgentRoles(agentId)` helper on `AgentAuthProvider` ([agent-auth.provider.ts:53](../../apps/api/src/auth/agent-auth.provider.ts#L53)) — matches spec Risk #7 mitigation. Reused by `KodaDomainWriter`.
- `KodaPrincipal` discriminated union + `isUserPrincipal` / `isAgentPrincipal` guards match the spec ([koda-principal.types.ts](../../apps/api/src/auth/principal/koda-principal.types.ts)).
- `actorForeignKeys` helper present and used ([labels.service.ts:257](../../apps/api/src/labels/labels.service.ts#L257), [tickets.service.ts:98](../../apps/api/src/tickets/tickets.service.ts#L98)).
- All 12 ADMIN gates have `@RequiredPermission('ADMIN')` decorator ([agents.controller.ts:108,157,169,181,194,207](../../apps/api/src/agents/agents.controller.ts), etc.).
- `JwtAuthProvider` populates `authorities: [role]` ([jwt-auth.provider.ts:29](../../apps/api/src/auth/jwt-auth.provider.ts#L29)) so `@RequiredPermission` works.
- `CombinedAuthGuard` writes `request.user` only ([combined-auth.guard.ts:93](../../apps/api/src/auth/guards/combined-auth.guard.ts#L93)).
- Cache invalidation called at every agent mutation ([agents.service.ts:131,151,242,270,300,312](../../apps/api/src/agents/agents.service.ts)).

---

## 🔴 Critical Issues

### C1 — `@nathapp/nestjs-cache` is not used at all

**Spec §Component Changes #2** mandated `CacheManager` from `@nathapp/nestjs-cache` with tag-based invalidation. The implementation rolls its own `Map<string, CacheEntry>` + manual `tagIndex` ([agent-auth.provider.ts:6-102](../../apps/api/src/auth/agent-auth.provider.ts#L6-L102)).

```bash
$ rg "CacheModule|@nathapp/nestjs-cache|CacheManager" apps/api/src/
# 0 matches
```

**Consequences:**
- **No multi-pod consistency** — the in-memory `Map` is per-pod. Agent A on pod 1 invalidates locally; pod 2 still serves stale cached principal until 60s TTL. Spec specifically called for `MULTI_TIER`/`DISTRIBUTED`.
- Reinventing tag invalidation (the library already does this; see `@nathapp/nestjs-cache` docs).
- No `CacheMetrics` hook → can't satisfy verification step 3 ("assert cache hit via `CacheMetrics`").
- `CacheModule` is not registered in `app.module.ts`.

**Fix:**
```typescript
return this.cache.get<AgentPrincipal>(
  ['agent-principal', agent.id, agent.status],
  async () => { /* ...resolver... */ },
  60_000,
  { tags: [`AGENT:${agent.id}`, `AGENT:${agent.id}:PRINCIPAL`] },
);
```
Register `CacheModule` in `app.module.ts` per the spec's "Files Touched" list.

---

### C2 — Service signatures did not collapse

**Spec §Component Changes #5** mandated:
> "19 service methods change from `(..., currentUser, actorType)` to `(..., principal: KodaPrincipal)`"

The implementation kept the dual parameter — services still take `(principal, actorType?)`:

| File | Methods affected |
|---|---|
| [labels.service.ts:26-27, 91-92, 133-134, 168-169, 299-300](../../apps/api/src/labels/labels.service.ts) | All 5 methods |
| [comments.service.ts:38-39, 86-87, 207-208, 239-240](../../apps/api/src/comments/comments.service.ts) | All 3 methods |
| [tickets.service.ts:54-55, 247-248, 299-300](../../apps/api/src/tickets/tickets.service.ts) | All 3 methods |
| [tickets.controller.ts:40-137](../../apps/api/src/tickets/tickets.controller.ts) | 9 testing-helper methods |
| [comments.controller.ts:31-62](../../apps/api/src/comments/comments.controller.ts) | 3 controller helpers |

This defeats the spec's central goal. The whole point was that `KodaPrincipal.actorType` makes the second parameter redundant.

**Fix:** drop every `actorType?` parameter. Inside the service, use `principal.actorType` (or `isUserPrincipal(principal)`). The `KodaPrincipal` type already carries the discriminator.

---

### C3 — `LegacyPrincipal` shim was added without authorization

A new file [`normalize-koda-principal.ts`](../../apps/api/src/auth/principal/normalize-koda-principal.ts) and an inline duplicate at [comments.service.ts:13-78](../../apps/api/src/comments/comments.service.ts#L13-L78) accept a `LegacyPrincipal` shape and runtime-normalize it back to `KodaPrincipal`. Service signatures advertise `principal: KodaPrincipal | LegacyPrincipal` and call `normalizeKodaPrincipal(...)` at the top of every method.

**This is the opposite of the spec direction.** The architectural target was *"one principal shape on the request"* — the guard normalizes once, not every service per call.

The shim:
- Inverts the control flow (normalize at consumer instead of producer).
- Reintroduces the dual-shape problem in a different location.
- Duplicates logic between `normalize-koda-principal.ts` and `comments.service.ts`'s private `normalizePrincipal`.
- Tolerates legacy callers that the migration was supposed to eliminate.

If tests are currently passing legacy shapes, **fix the tests**, don't shim production code. Spec Risk #2 already proposed a `buildTestUserPrincipal()` / `buildTestAgentPrincipal()` factory.

**Fix:**
- Delete `normalize-koda-principal.ts`.
- Delete the inline `normalizePrincipal` in `comments.service.ts`.
- Change service signatures to `principal: KodaPrincipal` only.
- Update tests to build proper `KodaPrincipal` fixtures.

---

### C4 — Redundant authorization in `agents.controller.ts`

Every admin endpoint has BOTH `@RequiredPermission('ADMIN')` AND an inline `if (!this.isAdmin(principal)) throw ForbiddenAppException` ([agents.controller.ts:33-100](../../apps/api/src/agents/agents.controller.ts#L33-L100)).

This creates two divergent authorization paths:
- The decorator runs first via `PermissionAuthGuard` and returns 403 for non-admins.
- If somehow that bypasses (e.g., guard misregistered), the inline check is a fallback.

Either the decorator works → inline check is dead code; or it doesn't → the decorator migration is a no-op and we still rely on the old check. Pick one.

**Fix:** delete the `isAdmin()` helper and all inline checks. If you can't trust `@RequiredPermission`, fix the guard registration instead. Spec §Risk #4 already analyzed why `@RequiredPermission('ADMIN')` preserves behavior.

---

### C5 — Possible regression in `ProjectsController.checkProjectMembership`

[projects.controller.ts:43-69](../../apps/api/src/projects/projects.controller.ts#L43-L69) looks up `projectMember` by `userId: principal.id` regardless of `actorType`. The pre-refactor code (per the exploration) had `if (actorType !== 'agent')` to bypass membership for agents (agents are cross-project).

After the refactor, an authenticated agent calling `GET /projects/:slug/memory` will fail the `findUnique({ where: { projectId_userId: { projectId, userId: agent.id }}})` lookup → 403.

If this is intentional (agents shouldn't access project memory), it's still a behavior change that should be in the commit message and tested. If unintentional, it's a regression.

**Fix:** branch on `isUserPrincipal(principal)` — agents either skip membership or use a different lookup path (e.g., `agentRoleEntry`).

---

## 🟡 Medium Issues

### M1 — `blacklisted` semantics flipped

Spec example: `blacklisted: agent.status === 'PAUSED'`. Impl: `blacklisted: agent.status === 'OFFLINE'` ([agent-auth.provider.ts:40](../../apps/api/src/auth/agent-auth.provider.ts#L40)).

Since `CombinedAuthGuard` rejects OFFLINE before reaching `buildPrincipal` ([combined-auth.guard.ts:91](../../apps/api/src/auth/guards/combined-auth.guard.ts#L91)), `blacklisted` is **always `false`** at runtime. Either the field is meaningless and should be removed, or PAUSED should set it true (matching the spec — PAUSED can authenticate but should be blocked from sensitive actions).

### M2 — `tickets.service.update` has unused `_principal` / `_actorType` parameters

[tickets.service.ts:247-248](../../apps/api/src/tickets/tickets.service.ts#L247-L248). Leading underscore signals unused. Either remove them (callers also pass them — coupled change), or actually use them for some authorization. Currently they're noise.

### M3 — `AgentsController.getMe` has bizarre overload

[agents.controller.ts:43-52](../../apps/api/src/agents/agents.controller.ts#L43-L52):
```typescript
async getMe(principalOrId?: KodaPrincipal | string, actorType?: 'user' | 'agent' | undefined)
```

Two unrelated calling conventions in one signature. The HTTP route uses `getMe(principal)`. The legacy `(id, actorType)` form serves no caller in production. Drop the overload.

### M4 — `normalizeKodaPrincipal` throws a localized exception for an internal error

[normalize-koda-principal.ts:39, 46](../../apps/api/src/auth/principal/normalize-koda-principal.ts#L39): throws `ValidationAppException({}, 'auth')` when normalization fails. But this code path runs inside services like `LabelsService.create`, and the resulting error message will be a localized "auth" key — confusing in a "label create" failure flow. Symptomatic of C3 — the normalizer shouldn't exist at all.

### M5 — `CombinedAuthGuard` debug logging is verbose

[combined-auth.guard.ts:29, 31, 36, 38, 47, 50, 55](../../apps/api/src/auth/guards/combined-auth.guard.ts) — 7 debug log lines per request. Spec said *"Remove the verbose debug logging (or keep at debug level only)"*. They're at debug level, so technically compliant, but `JSON.stringify(request['user'])` in line 38 will serialize the principal — including potentially sensitive `email` — into log lines whenever the debug level is enabled. Either trim or guard with a conditional.

---

## 🟢 Low Issues

### L1 — `agentsService.agentAuthProvider` is `@Optional()`

[agents.service.ts:81](../../apps/api/src/agents/agents.service.ts#L81). Cache invalidation silently no-ops if not injected. Acceptable for unit tests but means a missing wire-up in production won't fail loudly. Worth a one-line comment explaining why it's optional.

### L2 — Cache key prefix inconsistency

Hand-rolled key: `agent-principal:${id}:${status}` (lowercase). Spec used array form `['agent-principal', id, status]` which the cache lib uppercases to `AGENT-PRINCIPAL:...`. Cosmetic; fixed naturally if you adopt C1's fix.

### L3 — `agents.service.ts` `AgentRole` cast

[agents.service.ts:157, 257](../../apps/api/src/agents/agents.service.ts#L157): `role: role as AgentRole`. Forced cast suggests the input type isn't well-constrained. Per spec Risk #5, `KodaAgentRole = string` is correct for now; this cast is acceptable but worth an audit (Risk #5 audit step) before narrowing.

### L4 — Stale documentation comment on `JwtAuthProvider`

[jwt-auth.provider.ts:5-13](../../apps/api/src/auth/jwt-auth.provider.ts#L5-L13) describes storing role/email "in IPrincipal.extra", but the new code stores `actorType`, `id`, `email`, `role` as **first-class typed fields** on `UserPrincipal` (and *also* in `extra` redundantly). The comment doesn't match the new typed-subclass design.

### L5 — `KodaAgentStatus` adds `'OFFLINE'` beyond spec

[koda-principal.types.ts:4](../../apps/api/src/auth/principal/koda-principal.types.ts#L4) — spec had `'ACTIVE' | 'PAUSED'`, impl includes `'OFFLINE'`. Reasonable since `Agent.status` can be OFFLINE in the DB, but the guard rejects OFFLINE so this principal status value is unreachable. Either keep for completeness or trim.

---

## Recommended Action Plan

In priority order:

1. **C1** — Migrate `AgentAuthProvider` to `@nathapp/nestjs-cache`. Register `CacheModule`. Without this, the cache strategy is fundamentally broken in multi-pod deployments.
2. **C3** — Delete the `LegacyPrincipal` shim and `normalizeKodaPrincipal`. This becomes load-bearing the moment new code depends on it. Hard to undo later.
3. **C2** — Collapse service signatures to single `KodaPrincipal` parameter. Touches many files but is mechanical (the discriminator is already on the principal).
4. **C4** — Delete `isAdmin()` helper from `agents.controller.ts`.
5. **C5** — Verify agent access to `/projects/:slug/memory` and either restore the bypass or document/test the new behavior.
6. **M1, M2, M3, M4, M5** — Address as cleanup after the criticals.
7. **L1–L5** — Optional polish.

After fixes, re-run the spec's verification grep audit to confirm no regression.

---

## Attribution

Generated by automated review against the spec. Human verification recommended for C5 (regression hypothesis) and any policy/security decisions in M1 (blacklisted semantics).
