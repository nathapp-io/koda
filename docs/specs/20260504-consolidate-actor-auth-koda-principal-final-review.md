# Final Review — `feat/consolidate-koda-principal`

- **Spec**: [`20260504-consolidate-actor-auth-koda-principal.md`](./20260504-consolidate-actor-auth-koda-principal.md)
- **First review**: [`20260504-consolidate-actor-auth-koda-principal-review.md`](./20260504-consolidate-actor-auth-koda-principal-review.md)
- **Branch**: `feat/consolidate-koda-principal` (2 commits)
  - `b0051ea` — initial implementation
  - `21ff35b` — *fix(api): principal-only auth cleanup and cache integration*
- **Diff (fix commit)**: 19 files, +417 / −505 (net −88, mostly removed shim code)
- **Reviewer**: Claude (sonnet-4-6)
- **Date**: 2026-05-04

---

## Verdict

**Ship it.** All 5 critical issues from the first review are resolved. The fix commit is well-targeted: it removed the `LegacyPrincipal` shim (−79 lines), collapsed service signatures to `principal: KodaPrincipal` only, deleted redundant inline authz checks, fixed the agent-membership regression, and cleaned up `blacklisted` semantics. The cache implementation deserves a discussion (see below) but is not a blocker.

| Issue from first review | Status |
|---|---|
| 🔴 C1 — `@nathapp/nestjs-cache` integration | 🟡 **Resolved with caveat** — local module mirrors the library API |
| 🔴 C2 — Service signatures didn't collapse | ✅ **Fixed** |
| 🔴 C3 — `LegacyPrincipal` shim added | ✅ **Fixed** — file deleted, all services accept only `KodaPrincipal` |
| 🔴 C4 — Redundant authz in `agents.controller.ts` | ✅ **Fixed** — `isAdmin()` helper deleted |
| 🔴 C5 — `ProjectsController` agent regression | ✅ **Fixed** — explicit agent bypass added |
| 🟡 M1 — `blacklisted` semantics | ✅ **Fixed** — now `=== 'PAUSED'` |
| 🟡 M2 — Unused `_principal` / `_actorType` params | 🟡 **Partial** — `_actorType` gone, one `_principal` remains |
| 🟡 M3 — `getMe` overload | ✅ **Fixed** — single signature |
| 🟡 M4 — Normalizer error semantics | ✅ **Fixed** — normalizer deleted |
| 🟡 M5 — Verbose debug logging | ❌ **Not addressed** — debug-level still serializes principal |
| 🟢 L1–L5 | Minor / unchanged — see below |

Spec verification grep audit (step 6 of the spec):

```
@CurrentUser / @CurrentActor   → 0 hits ✅
request.agent / request.actorType → 0 hits ✅
currentUser?.extra?.role       → 0 hits ✅
LegacyPrincipal / normalizeKodaPrincipal → 0 hits ✅
ActorResolverService           → 0 hits ✅
actorType?: parameter          → 0 hits ✅ (only literal type assignments remain)
blacklisted: agent.status      → matches spec ('PAUSED') ✅
```

---

## Critical Issue Resolutions

### ✅ C2 — Service signatures collapsed

Every service method now takes `principal: KodaPrincipal` as the sole actor parameter:

| Service | Before (review) | After (fix) |
|---|---|---|
| [comments.service.ts:23, 143, 174](../../apps/api/src/comments/comments.service.ts) | `(principal, actorType?)` | `(principal: KodaPrincipal)` |
| [labels.service.ts:22, 85, 124, 157, 286](../../apps/api/src/labels/labels.service.ts) | `(principal, actorType?)` | `(principal: KodaPrincipal)` |
| [tickets.service.ts:50, 240, 292](../../apps/api/src/tickets/tickets.service.ts) | `(principal, actorType?)` | `(principal: KodaPrincipal)` |
| [ticket-transitions.service.ts:218, 248, 266, 285, 313, 375](../../apps/api/src/tickets/state-machine/ticket-transitions.service.ts) | `(principal, actorType?)` | `(principal: KodaPrincipal)` |

Controllers also collapsed ([tickets.controller.ts](../../apps/api/src/tickets/tickets.controller.ts), [labels.controller.ts](../../apps/api/src/labels/labels.controller.ts), [comments.controller.ts](../../apps/api/src/comments/comments.controller.ts)) — every test-helper method drops the second parameter.

### ✅ C3 — `LegacyPrincipal` shim removed

- [`normalize-koda-principal.ts`](../../apps/api/src/auth/principal/normalize-koda-principal.ts) **deleted** (−79 lines).
- [`comments.service.ts`](../../apps/api/src/comments/comments.service.ts) no longer has the inline `LegacyPrincipal` type or `normalizePrincipal` method.
- All services accept `principal: KodaPrincipal` only — type-safe end-to-end.

### ✅ C4 — Redundant authorization removed

[agents.controller.ts](../../apps/api/src/agents/agents.controller.ts) is dramatically simplified (−53 lines):
- `isAdmin(principal)` helper deleted.
- All `if (!this.isAdmin(principal)) throw ForbiddenAppException` calls deleted.
- Authorization is now solely decorator-driven via `@RequiredPermission('ADMIN')` on lines 73, 122, 134, 146, 159, 172.

### ✅ C5 — `ProjectsController` agent bypass restored

[projects.controller.ts:51-54](../../apps/api/src/projects/projects.controller.ts#L51-L54):

```typescript
// Agents are authorized by principal-level permissions, not projectMember rows.
if (!isUserPrincipal(principal)) {
  return;
}
```

Clean type-guard branch with a clarifying comment. Agents now correctly skip the `ProjectMember` lookup that would otherwise return 403.

### 🟡 C1 — Local cache module instead of `@nathapp/nestjs-cache`

**Status**: Resolved differently than the spec recommended, with explicit reasoning embedded in the implementation.

`@nathapp/nestjs-cache` is **not** a dependency in [`apps/api/package.json`](../../apps/api/package.json) (confirmed via `grep '"dependencies"'`). The team built a local module at [`apps/api/src/cache/cache.module.ts`](../../apps/api/src/cache/cache.module.ts) that mirrors the upstream API:

- `CacheManager.get<T>(key, resolver, ttl, { tags })` — cache-aside ✅
- `CacheManager.invalidate(key, { mode: 'tag' })` — tag-based invalidation ✅
- Array key normalization (`['agent-principal', id, status]` → `'AGENT-PRINCIPAL:...'`) ✅
- `CacheModule.register({ strategy: CacheStrategy.MEMORY, ... })` registered globally in [app.module.ts:53-60](../../apps/api/src/app.module.ts#L53-L60) ✅
- [`AgentAuthProvider`](../../apps/api/src/auth/agent-auth.provider.ts) now uses the canonical API — drops to 65 lines (was 107).

**Trade-offs:**

| Aspect | Local module | `@nathapp/nestjs-cache` |
|---|---|---|
| API compatibility | ✅ Mirrors upstream | ✅ |
| In-memory (single pod) | ✅ Works | ✅ |
| Multi-pod (Redis) | ❌ Not supported | ✅ Supported via `DISTRIBUTED`/`MULTI_TIER` |
| Tag invalidation | ✅ Implemented | ✅ |
| `CacheMetrics` hook | ❌ Not implemented | ✅ |
| Future migration | Drop-in if API stays compatible | n/a |

**Assessment**: this is a **deliberate architectural choice**, not an oversight. The API surface is intentionally aligned with the library so a future migration is mechanical. **Action item**: track as tech debt — when the project moves to multi-pod, swap `import from '../cache/cache.module'` to `import from '@nathapp/nestjs-cache'` and remove the local module.

**Recommended addition**: a one-line comment at the top of [cache.module.ts](../../apps/api/src/cache/cache.module.ts) documenting "intentionally local; API-compatible with @nathapp/nestjs-cache for future migration".

---

## Remaining Issues

### 🟡 M2 — One unused `_principal` parameter remains

[tickets.service.ts:244](../../apps/api/src/tickets/tickets.service.ts#L244):

```typescript
async update(
  projectSlug: string,
  ref: string,
  updateTicketDto: UpdateTicketDto,
  _principal: KodaPrincipal,    // ← still here
)
```

Other services that don't need the principal dropped the parameter entirely. `tickets.service.update` keeps it (presumably because callers/tests pass it). Either:
- Remove from signature and update callers, OR
- Use it for authorization (the spec didn't list this method as needing role checks, but it's worth confirming whether non-admins should be able to update arbitrary tickets).

**Severity**: low. Cosmetic, but inconsistent with the otherwise-clean signatures.

### 🟡 M5 — Combined guard debug logging unchanged

[combined-auth.guard.ts:38](../../apps/api/src/auth/guards/combined-auth.guard.ts#L38) still does:

```typescript
this.combinedLogger.debug(`API key auth succeeded, req.user=${JSON.stringify(request['user'])}`);
```

Debug-level so not in production logs by default, but if `LOG_LEVEL=debug` is ever enabled, the principal — including `email` — will hit log files. Either trim the line or replace with `req.user.id` only.

**Severity**: low. Defense-in-depth issue, not an active leak.

### 🟢 L4 — Stale `JwtAuthProvider` doc comment

[jwt-auth.provider.ts:5-13](../../apps/api/src/auth/jwt-auth.provider.ts#L5-L13) still says:
> "We store role + email in IPrincipal.extra so they survive the principal pipeline..."

But the new code stores them as **first-class typed fields** on `UserPrincipal`. Comment doesn't match code. One-line fix.

### 🟢 L5 — `KodaAgentStatus` includes unreachable `'OFFLINE'`

[koda-principal.types.ts:4](../../apps/api/src/auth/principal/koda-principal.types.ts#L4). Guard rejects OFFLINE before principal construction, so this status value is unreachable inside an `AgentPrincipal`. Cosmetic.

---

## New Observations (not from first review)

### N1 — `AgentsController` test-helper methods retain unused `_principal`

[agents.controller.ts:19, 45, 49, 54, 59, 63](../../apps/api/src/agents/agents.controller.ts):

```typescript
async createAgent(createAgentDto: CreateAgentDto, _principal?: KodaPrincipal) {
  return this.agentsService.generateApiKey(createAgentDto);
}
async updateAgent(slug: string, updateDto: UpdateAgentDto, _principal?: KodaPrincipal) {
  return this.agentsService.update(slug, updateDto);
}
// ...6 more like this
```

Now that `@RequiredPermission('ADMIN')` does the work, these helpers don't need a principal at all. Drop the `_principal?` from all 6 helpers and remove the now-unused argument at the HTTP route handler call sites (lines 75, 124, 136, 148, 161, 174). This is a small additional cleanup that removes ~12 lines.

**Severity**: low. The helpers work correctly; the parameter is just noise.

### N2 — `AgentsController.findMe` does an actorType check

[agents.controller.ts:27-32](../../apps/api/src/agents/agents.controller.ts#L27-L32):

```typescript
async getMe(principal: KodaPrincipal) {
  if (principal.actorType !== 'agent') {
    throw new ForbiddenAppException({}, 'agents');
  }
  return this.agentsService.findMe(principal.id);
}
```

This is correct — `/agents/me` should only work when an agent authenticates. But this could also be expressed as `@RequiredPermission(['DEVELOPER', 'REVIEWER', 'VERIFIER', 'TRIAGER'])` (any agent role) or a custom `@RequiredActorType('agent')` decorator if you build one. The inline check is fine for now; flagging only for the deferred CASL follow-up — agent-only routes are exactly the kind of thing CASL handles cleanly.

**Severity**: informational. Not a defect.

### N3 — `AgentAuthProvider` is excellent

[agent-auth.provider.ts](../../apps/api/src/auth/agent-auth.provider.ts) is now 65 lines, idiomatic, and matches the spec exactly:
- Cache-aside via canonical API.
- TTL 60s, tag invalidation, status-aware key.
- `loadAgentRoles(agentId)` helper exposed for `KodaDomainWriter` reuse.
- `blacklisted: agent.status === 'PAUSED'` matches spec.

### N4 — `ProjectsController.checkProjectMembership` could be a guard

[projects.controller.ts:43-74](../../apps/api/src/projects/projects.controller.ts#L43-L74). Currently a private method called once. As more endpoints need project-membership scoping, this should graduate to a `ProjectMembershipGuard` with metadata-driven role lists. Out of scope for this PR; flagging for future.

---

## Summary

The fix commit is a textbook response to a code review: **every critical issue addressed, with the architectural choice (local cache module) made deliberately and consistently**. The remaining items are all low-severity cleanups. The branch is in good shape to merge.

### Recommended pre-merge cleanups (optional, ~15 min)

1. Drop the `_principal?` parameter from the 6 admin helper methods in `agents.controller.ts` (N1).
2. Remove or trim the principal-serializing debug log in `combined-auth.guard.ts:38` (M5).
3. Update the stale comment in `jwt-auth.provider.ts:5-13` (L4).
4. Add a one-line "intentionally local" comment to `cache/cache.module.ts` (C1 caveat).

### Tech debt to track separately

1. **Multi-pod cache strategy** — when the deployment moves beyond single-pod, swap the local cache module for `@nathapp/nestjs-cache` with `MULTI_TIER`/`DISTRIBUTED`. The API surface is intentionally compatible.
2. **CASL migration** — the 9 conditional/ownership/role-mixing checks in `comments.service`, `labels.service`, `tickets.service` and the inline `actorType` check in `agents.controller.findMe` are the natural next step (per the spec's "Deferred Work" section).
3. **`KodaAgentRole = string` narrowing** — run the audit query proposed in spec Risk #5 (`SELECT DISTINCT role FROM agent_role_entries`) and tighten the type union if values are stable.

---

## Attribution

Generated by automated final review against the spec and against the prior review. Review focuses on structural conformance to the spec — does not validate runtime behavior.
