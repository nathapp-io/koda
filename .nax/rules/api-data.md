---
paths:
  - "apps/api/*"
appliesTo:
  - "**/*.service.ts"
  - "**/*.repository.ts"
  - "**/tickets/**"
  - "**/projects/**"
  - "**/prisma/**"
priority: 80
---

# API Data & Persistence — apps/api

## Data & Domain
- Soft-delete Projects/Tickets only (`deletedAt`), no hard deletes
- Ticket numbers: allocate with `MAX(number)+1` in Prisma transaction
- Include soft-deleted tickets in numbering; do not reuse numbers
- All ticket transitions must go through `validateTransition()`
- Do not update ticket status directly via Prisma
- Ticket refs use `PROJECT_KEY-NUMBER` format
- Keep workflow constraints centralized in state-machine validation

## Prisma
- Inject `PrismaService<PrismaClient>` from `@nathapp/nestjs-prisma`
- Access client via `this.prisma.client`
- Schema path is `apps/api/prisma/schema.prisma`
- In tests, prefer `createMockPrismaService()` / `createMockPrismaClient()` from `@nathapp/nestjs-prisma`
- Avoid hand-rolled Prisma mock shapes unless there is a specific gap

## Pagination Anti-Patterns
- Do not write unbounded `do { ... } while (hasMore)` loops without a hard iteration cap. A misbehaving repository, broken cache, or non-pagination-aware mock can cause infinite loops that allocate until OOM
- Do not hardcode the page-size literal in the termination predicate (`length === 100`); reference a `PAGE_SIZE` constant so the predicate cannot drift from the `limit` argument
- Always pair pagination with a `MAX_PAGES` safety bound and a `logger.warn` on overflow — silent infinite loops are worse than a logged early exit
- Prefer `data.length >= PAGE_SIZE` over `data.length === PAGE_SIZE` so a repository overshoot still terminates
