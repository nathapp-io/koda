---
description: "Permissions in apps/api: route keys with @Requires and RequiresGuard, service-level ownership and edge checks, project access through project.read, no decisions on role claims, union-type tightening in test mocks"
paths:
  - "apps/api/*"
priority: 45
---

# API Auth Rules — Permission Keys

Every authorization decision goes through `PermissionService` (`src/permissions/`) and a catalog key from `src/permissions/catalog.ts`. There is no CASL ability factory and no role-based decorator.

## Guard-Level vs Service-Level Authorization

- **Route keys** → `@Requires('<key>')` checked by `RequiresGuard`, listed after `ProjectMembershipGuard` in the same `@UseGuards(...)` on project routes. Delete the inline check from the service.
- **Ownership checks** (`comment.update.own`, `ticket.link.remove.own`) and **transition edges** → `@Requires(key, { enforcedBy: 'service' })` on the route, then `PermissionService.can(principal, key, { projectId, resource: { createdBy } })` in the service after the row lookup.
- Do **not** duplicate authorization: if the guard handles it, remove the inline `if`-throw from the service.

## Project Access

- Access to a project is holding `project.read` in it. `ProjectAccessService.resolveMembership` / `assertProjectMembership` decide it with `PermissionService.can(principal, 'project.read', { projectId })` and refuse with 403 `projects`. Use them; do not read membership rows to decide access.
- "Sees every project" is holding `project.read` globally: `ProjectAccessService.readsEveryProject(principal)`.

## No Decisions on Role Claims

- Never decide on `principal.role`, a user row's `role`, or a legacy project role. Ask for the key the action needs (for example `agent.update` to act for another agent, `role.binding.global` to override the last-admin rule).
- For another principal (an assignee, a target agent, an event actor), read its keys with `PermissionService.effectiveKeys({ type, id }, { projectId })`.

## Union Type Tightening & Test Mocks

When tightening a type from `string` to a union (e.g. `KodaAgentRole`), test mocks break:

```typescript
// WRONG — as const makes array readonly, incompatible with mutable AgentRoleNames[]
agentRoles: ['DEVELOPER'] as const,

// CORRECT — either use readonly in the interface, or type-cast
agentRoles: ['DEVELOPER'] as AgentRoleNames[],
```

Prefer `readonly` on interface array properties (`agentRoles: readonly KodaAgentRole[]`) so both mutable and `as const` arrays are accepted.
