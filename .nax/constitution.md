# Koda Project Constitution

> Hard invariants. Full context: `docs/architecture.md`, `.nax/context.md`, `.nax/mono/apps/*/context.md`

## Non-Negotiable Rules

**Business logic lives in `apps/api` only.** Web and CLI are thin clients.

### Data Integrity

- Soft deletes only — never hard-delete `Ticket` or `Project`
- Ticket numbers: `MAX(number)+1` in a transaction — never `autoincrement()`; include soft-deleted rows
- Never import enums from `@prisma/client` — use `src/common/enums.ts`
- All ticket transitions go through `validateTransition()` — never update status directly via Prisma

### Auth

- Use `@nathapp/nestjs-auth` v3 — never `nestjs-iam`
- API key hashing: HMAC-SHA256 (deterministic); password hashing: bcrypt (rounds: 12)

### Code Generation

- Run `bun run generate` after any API contract change — before touching CLI code
- Never manually edit `apps/cli/src/generated/`
- Never manually edit generated `AGENTS.md` — edit the matching `context.md` and run `nax generate`

### Testing

- NAX acceptance tests go in `.nax/features/<feature>/` — never in `apps/*/test/`
- Do not create `us-XXX` folders in any app `test/` directory

### Boundaries

- Never push to remote — the human reviews and pushes
- Never add dependencies without justification in acceptance criteria
