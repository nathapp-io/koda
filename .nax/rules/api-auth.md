---
paths:
  - "apps/api/*"
priority: 45
---

# API Auth Rules — CASL & Permissions

## CASL Factory Registration (`forRootAsync`)

`caslAbilityFactory` takes a **bare class**, unlike `authProvider` which takes `{ useClass: ... }`:

```typescript
// ✅ CORRECT
AuthModule.forRootAsync({
  authProvider: { useClass: JwtAuthProvider },
  caslAbilityFactory: KodaCaslAbilityFactory,
})

// ❌ WRONG — library wraps with useClass internally → double-wrapped → silent failure
AuthModule.forRootAsync({
  caslAbilityFactory: { useClass: KodaCaslAbilityFactory },
})
```

Failure mode: no runtime error, but `@RequiredPermission([action, subject])` silently stops enforcing — guard can't resolve the factory from DI.

## Enumerate Subjects — Don't Use `all` With Virtual Subjects

The wildcard subject `all` covers **everything**, including virtual subjects like `AgentScope` and `AdminScope`. If you use `manage all` for ADMIN, they can access agent-only routes.

**Always enumerate real subjects.** Virtual subjects are granted selectively:

```typescript
// ✅ CORRECT — enumerated, excludes virtual subjects
{ action: MANAGE, subject: 'Comment' },
{ action: MANAGE, subject: 'Label' },
{ action: MANAGE, subject: 'Ticket' },

// ❌ WRONG — manages to leak into virtual subjects
{ action: MANAGE, subject: 'all' },
```

## Guard-Level vs Service-Level Authorization

- **Pure role gates** (`ADMIN`-only, `AgentScope`-only) → `@RequiredPermission` on the controller. Delete inline checks from service.
- **Ownership checks** → `@RequiredPermission([action, subject])` on the controller as coarse gate, then `ability.can(action, subject('Subject', instance))` in the service for the precise check.
- Do **not** duplicate authorization: if the guard handles it, remove the inline `if`-throw from the service.

## Union Type Tightening & Test Mocks

When tightening a type from `string` to a union (e.g. `KodaAgentRole`), test mocks break:

```typescript
// ❌ WRONG — as const makes array readonly, incompatible with mutable AgentRoleNames[]
agentRoles: ['DEVELOPER'] as const,

// ✅ CORRECT — either use readonly in the interface, or type-cast
agentRoles: ['DEVELOPER'] as AgentRoleNames[],
```

Prefer `readonly` on interface array properties (`agentRoles: readonly KodaAgentRole[]`) so both mutable and `as const` arrays are accepted.
