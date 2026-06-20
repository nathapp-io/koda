# Prisma & Data Layer Compliance Report

**Date:** 2026-06-20
**Scope:** `apps/api/src` — checked against `@nathapp/nestjs-prisma` and `@nathapp/nestjs-data` patterns
**Reference skills:** `nathapp-nestjs-patterns` → `prisma.md`, `data.md`

---

## Summary

The audit found **three categories of violations** across roughly 20 source files. The root cause is consistent: many modules skip the `AbstractPrismaRepository` + `IRepository` + domain-type pattern and instead inject `PrismaService` directly into controllers, guards, and services, leaking Prisma model types outside the data layer.

| Severity | Count | Category |
|---|---|---|
| HIGH | 11 files | `PrismaService` injected outside repositories |
| HIGH | 14 files | `@prisma/client` types leaking out of the data layer |
| MEDIUM | 1 module | Repository token exported from module |
| MEDIUM | 1 service | Prisma error type caught directly in service layer |

---

## Violation 1 — `PrismaService` injected into controllers (HIGH)

**Rule:** Controllers must depend on services only. `PrismaService` is a data-layer concern and must never be injected into a controller.

| File | Line | Detail |
|---|---|---|
| `context/context.controller.ts` | 35 | Injects `PrismaService`; calls `this.prisma.client` directly on lines 39, 68 |
| `rag/rag.controller.ts` | 34 | Injects `PrismaService`; exposes `get db() { return this.prisma.client }` |
| `memory/timeline.controller.ts` | 14 | Injects `PrismaService`; returns raw client |
| `code-intel/code-intel.controller.ts` | 35 | Injects `PrismaService` with `@Optional()`; throws manually if absent; accesses `this.prisma.client` |
| `projects/projects.controller.ts` | 44 | Injects `PrismaService`; exposes `get db()` that casts raw client |

---

## Violation 2 — `PrismaService` injected into non-repository services/guards (HIGH)

**Rule:** Only `*.repository.ts` files may inject `PrismaService`. Services, guards, processors, and handlers must access data through a repository or service layer.

| File | Line | Detail |
|---|---|---|
| `auth/guards/combined-auth.guard.ts` | 16 | Injects `PrismaService`; calls `prisma.client.agent.findFirst` directly |
| `auth/agent-auth.provider.ts` | 10 | Injects `PrismaService<PrismaClient>` |
| `memory/memory-governance.processor.ts` | 12 | Injects `PrismaService` |
| `code-intel/code-commit-outbox-handler.ts` | 31 | Injects `PrismaService` |
| `rag/entity-store.ts` | 28 | Injects `PrismaService<PrismaClient>` with `@Optional()` |
| `code-intel/symbol-store.ts` | 43 | Injects `PrismaService<PrismaClient>` |

---

## Violation 3 — `@prisma/client` types leaking out of the data layer (HIGH)

**Rule:** ORM types (`PrismaClient`, Prisma models, Prisma namespaces) must only appear in `*.repository.ts` and persistence-mapping files. Services, controllers, guards, and DTOs must use domain types defined in the service layer.

| File | Leaked imports |
|---|---|
| `labels/labels.service.ts` | `Prisma` (for `Prisma.PrismaClientKnownRequestError`) |
| `tickets/state-machine/ticket-transitions.service.ts` | Prisma model types from `@prisma/client` |
| `auth/guards/combined-auth.guard.ts` | `PrismaClient` |
| `auth/agent-auth.provider.ts` | `Agent`, `PrismaClient` |
| `vcs/vcs-webhook.service.ts` | `VcsConnection`, `Project` |
| `vcs/vcs-connection.service.ts` | `VcsConnection` |
| `vcs/vcs-sync.service.ts` | `Project`, `VcsConnection` |
| `vcs/vcs-link-extractor.service.ts` | `Ticket`, `VcsConnection` |
| `vcs/vcs-polling.service.ts` | `VcsConnection`, `Project` |
| `vcs/vcs-pr-sync.service.ts` | `Project`, `Ticket`, `VcsConnection` |
| `vcs/vcs.controller.ts` | `Project` |
| `code-intel/symbol-store.ts` | `PrismaClient` |
| `rag/entity-store.ts` | `Prisma`, `PrismaClient` |

---

## Violation 4 — `VCS_REPOSITORY` token exported from `vcs.module.ts` (MEDIUM)

**Rule:** Repository tokens must be **module-private** and never appear in a module's `exports:`. Only services are the module's public contract.

**File:** `vcs/vcs.module.ts:30`

```typescript
// ❌ Current
exports: [VCS_REPOSITORY, VcsConnectionService, ...]

// ✅ Fix
exports: [VcsConnectionService, VcsSyncService, VcsWebhookService, VcsPollingService, VcsPrSyncService, VcsLinkExtractorService]
```

Consumers outside `VcsModule` that currently inject `VCS_REPOSITORY` must instead call the appropriate `VcsConnectionService` / `VcsSyncService` method.

---

## Violation 5 — Prisma error type caught in service layer (MEDIUM)

**Rule:** `Prisma.PrismaClientKnownRequestError` is an ORM type and must not be caught or inspected in the service layer. Error mapping belongs in the repository or in a global `PrismaExceptionFilter`.

**File:** `labels/labels.service.ts:43,102,169`

**Fix options (pick one):**
- Register `PrismaExceptionFilter` globally — the filter catches and maps Prisma errors before they reach service catch blocks.
- Move the `catch` logic into `PrismaLabelRepository`, re-throw as `AppException` subclasses.

---

## Affected Modules

| Module | Primary violations |
|---|---|
| `vcs/` | All VCS services use Prisma model types as domain types; `VCS_REPOSITORY` exported |
| `auth/` | Guard and provider inject `PrismaService` + leak `PrismaClient`/`Agent` types |
| `rag/` | Controller and entity-store inject `PrismaService` directly |
| `code-intel/` | Controller, symbol-store, and outbox-handler inject `PrismaService` |
| `memory/` | Timeline controller and governance processor inject `PrismaService` |
| `context/` | Controller injects `PrismaService` |
| `projects/` | Controller injects `PrismaService` |
| `labels/` | Service catches Prisma error types |
| `tickets/` | State-machine service imports Prisma model types |

---

## Recommended Fix Approach

The `vcs/` module is the most pervasive violation (8 files, Prisma types used as domain types throughout). The pattern to apply everywhere is:

1. **Define a domain type** (plain TS interface) owned by the service layer — e.g. `VcsConnectionDomain`, not the Prisma `VcsConnection` model.
2. **Create or extend an `AbstractPrismaRepository`** subclass that maps Prisma model → domain type.
3. **Replace direct `PrismaService` injections** in services/controllers/guards with the repository token or a service method.
4. **Remove the `VCS_REPOSITORY` export** from `vcs.module.ts`.
5. **Move Prisma error handling** from `labels.service.ts` into the repository or global filter.

See `docs/superpowers/plans/` for the full task-by-task refactor plan.
