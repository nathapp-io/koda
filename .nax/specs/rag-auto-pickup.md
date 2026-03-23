# Feature: rag-auto-pickup (Stories 4-6)

## Overview

Extend the Koda RAG module (Stories 1-3 already merged) with:
- **Story 4**: KB CLI commands (`koda kb add/search/list`) in `apps/cli`
- **Story 5**: Agent auto-pickup API endpoint + capability matching algorithm in `apps/api`
- **Story 6**: `auto_assign` field on Project model + `koda agent pickup` CLI command

The RAG API endpoints already exist at `POST/GET /api/projects/:slug/kb/documents`, `DELETE /api/projects/:slug/kb/documents/:sourceId`, and `POST /api/projects/:slug/kb/search`. The CLI must call these via the generated client (`KnowledgeBaseService` or equivalent from `apps/cli/src/generated`). The agent pickup endpoint is new.

**Branch:** `feat/rag-auto-pickup`
**Working directories:** `apps/cli` (Stories 4, 6 CLI), `apps/api` (Stories 5, 6 API)
**Depends on:** Phase 7 Stories 1-3 (RAG module already on this branch)
**Reference skill:** `nathapp-nestjs-patterns`

---

## Architecture Constraints

### CLI Patterns (MANDATORY)

Study the existing commands before writing any new code:
- `apps/cli/src/commands/agent.ts` — pattern for sub-commands
- `apps/cli/src/commands/label.ts` — pattern for project-scoped commands
- `apps/cli/src/utils/auth.ts` — `resolveAuth({})` for config resolution
- `apps/cli/src/utils/api.ts` — `unwrap(response)` for `{ ret, data }` envelope
- `apps/cli/src/utils/error.ts` — `handleApiError(err)` for error handling
- `apps/cli/src/utils/output.ts` — `table()`, `error()` for output
- `apps/cli/src/client.ts` — `configureClient(apiUrl, apiKey)` for HTTP client

**Every CLI command MUST follow this exact structure:**
```typescript
import { Command } from 'commander';
import { resolveAuth } from '../utils/auth';
import { configureClient } from '../client';
import { SomeService } from '../generated';
import { error } from '../utils/output';
import { unwrap } from '../utils/api';
import { handleApiError } from '../utils/error';

export function kbCommand(program: Command): void {
  const kb = program.command('kb').description('Manage knowledge base');

  kb.command('search')
    .description('Search the project knowledge base')
    .requiredOption('--project <slug>', 'Project slug')
    .requiredOption('--query <query>', 'Search query')
    .option('--json', 'Output as JSON')
    .option('--limit <n>', 'Max results', '5')
    .action(async (options) => {
      try {
        const auth = resolveAuth({});
        if (!auth.apiKey || !auth.apiUrl) {
          error('Not configured. Run: koda login --api-key <key>');
          process.exit(2);
          return;
        }
        const client = configureClient(auth.apiUrl, auth.apiKey);
        const response = await KnowledgeBaseService.search(client, options.project, { query: options.query, limit: parseInt(options.limit) });
        const data = unwrap(response);
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          // human-readable output
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err);
      }
    });
}
```

**Register in `apps/cli/src/main.ts`:** `kbCommand(program)` after other command registrations.

### Generated Client

The `apps/cli/src/generated/` directory contains auto-generated service classes from `openapi.json`. After any API changes, re-run `bun run generate:cli` from the monorepo root to regenerate.

If a `KnowledgeBaseService` doesn't exist in `generated/`, check the actual generated service names by reading `apps/cli/src/generated/index.ts`. The KB endpoints are under `/api/projects/:slug/kb/*` — look for the matching service.

### API Patterns (MANDATORY)

- Controllers return `JsonResponse.Ok(data)` — never raw objects
- Use `AppException` subclasses for errors — never raw `HttpException`
- Inject `PrismaService` via `@Inject('PrismaService')` and use `(this.prisma as any).client` pattern (see existing controllers)
- Local TypeScript enums in `src/common/enums.ts` — do NOT import from `@prisma/client` (SQLite)
- When adding `auto_assign` to Project: check `src/common/enums.ts` first, add `AutoAssignMode` enum there

### Prisma Migration

For Story 6 (`autoAssign` on Project):
- Add field to `apps/api/prisma/schema.prisma`: `autoAssign String @default("OFF")`
- Run migration: `cd apps/api && npx prisma migrate dev --name add_auto_assign`
- Update any relevant Project DTOs/response types

---

## Requirements

### US-001 — KB CLI Commands (`koda kb add/search/list`)

Implement three `koda kb` sub-commands in `apps/cli/src/commands/kb.ts`.

**Files to create/modify:**
```
apps/cli/src/
├── commands/
│   └── kb.ts          ← NEW — all 3 kb sub-commands
└── main.ts            ← MODIFY — register kbCommand(program)
```

**Commands:**

| Command | Flags | Description |
|:--------|:------|:------------|
| `koda kb search` | `--project <slug>`, `--query <text>`, `--limit <n>` (default 5), `--json` | Hybrid search KB |
| `koda kb list` | `--project <slug>`, `--limit <n>` (default 100), `--json` | List indexed documents |
| `koda kb add` | `--project <slug>`, `--file <path>` | Read file, POST content as manual doc |

**`koda kb search` human-readable output:**
```
Verdict: LIKELY DUPLICATE

  #1 [HIGH 0.91] KODA-12 — Null pointer in AuthService
     Type: BUG | Status: CLOSED | Labels: typescript, auth

  #2 [MED  0.74] KODA-8  — Auth middleware throws on expired token
     Type: BUG | Status: CLOSED | Labels: auth
```

**`koda kb list` human-readable output:**
```
ID              Source    Created
doc_1234_abc    ticket    2026-03-20T10:00:00.000Z
doc_5678_def    manual    2026-03-21T14:30:00.000Z
```

**`koda kb add` output:**
```
✓ File indexed: ./docs/architecture.md (1 document added)
```

**Unit tests** (`apps/cli/src/commands/kb.spec.ts`):
- `kb search` — resolves auth, calls generated KnowledgeBase search service, prints verdict
- `kb list` — calls generated list endpoint, formats as table
- `kb add` — reads file, posts as manual doc

**Acceptance Criteria:**
- [ ] `koda kb search --project koda --query "auth error"` exits 0 and prints verdict + results
- [ ] `koda kb search --json` outputs raw JSON matching API response shape
- [ ] `koda kb list --project koda` exits 0 and prints document table
- [ ] `koda kb add --project koda --file ./README.md` exits 0 and confirms indexed
- [ ] Missing `--project` or `--query` causes exit code 3 (validation error)
- [ ] Missing auth config causes exit code 2
- [ ] API errors handled via `handleApiError(err)`
- [ ] `kbCommand(program)` registered in `main.ts`
- [ ] `bun run test` passes in `apps/cli`

---

### US-002 — Agent Auto-Pickup API (`GET /api/agents/:slug/pickup`)

Add `suggestTicket()` to `AgentsService` and a new `pickup` endpoint.

**Files to create/modify:**
```
apps/api/src/agents/
├── agents.service.ts     ← MODIFY — add suggestTicket() method
└── agents.controller.ts  ← MODIFY — add GET :slug/pickup endpoint
```

**Pickup endpoint:**
```
GET /api/agents/:slug/pickup?project=<projectSlug>
Auth: Any (JWT or API key)
Response: { ticket, matchScore, matchedCapabilities } | null
```

**`suggestTicket()` algorithm (in AgentsService):**
```typescript
async suggestTicket(agentSlug: string, projectSlug: string) {
  const agent = await this.db.agent.findUnique({
    where: { slug: agentSlug },
    include: { capabilities: true },
  });
  if (!agent) throw new NotFoundAppException();

  const agentCaps = new Set(agent.capabilities.map(c => c.capability));

  // Find unassigned VERIFIED tickets in project
  const candidates = await this.db.ticket.findMany({
    where: {
      project: { slug: projectSlug },
      status: 'VERIFIED',
      assignedToAgentId: null,
      assignedToUserId: null,
      deletedAt: null,
    },
    include: { labels: { include: { label: true } } },
    orderBy: { priority: 'desc' },
  });

  // Score by label/capability overlap
  const scored = candidates.map(ticket => {
    const ticketLabels = new Set(ticket.labels.map(tl => tl.label.name));
    const matchedCaps = [...agentCaps].filter(c => ticketLabels.has(c));
    return { ticket, score: matchedCaps.length, matchedCapabilities: matchedCaps };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? null;
}
```

**Response shape:**
```json
{
  "ret": 0,
  "data": {
    "ticket": { "id": "...", "ref": "KODA-5", "title": "...", "type": "BUG", "priority": "HIGH", "status": "VERIFIED" },
    "matchScore": 2,
    "matchedCapabilities": ["typescript", "auth"]
  }
}
```

Returns `null` data (with `ret: 0`) when no suitable ticket found.

**Unit tests** in `agents.service.spec.ts`:
- Returns highest-scored ticket when multiple candidates exist
- Returns null when no VERIFIED unassigned tickets
- Throws NotFoundAppException for unknown agent slug
- Score 0 (no capability overlap) still returns a ticket (highest priority fallback)

**Acceptance Criteria:**
- [ ] `GET /api/agents/:slug/pickup?project=koda` returns `{ ticket, matchScore, matchedCapabilities }` or null
- [ ] Only VERIFIED + unassigned tickets are candidates
- [ ] Ties broken by priority order (CRITICAL > HIGH > MEDIUM > LOW)
- [ ] Returns 404 if agent slug not found
- [ ] Returns 400 if `project` query param missing
- [ ] Unit tests cover happy path + no-match + unknown agent
- [ ] `bun run test` passes in `apps/api`

---

### US-003 — Auto-Assign Config on Project

Add `autoAssign` field to Project model and expose it in Project API responses.

**Files to create/modify:**
```
apps/api/
├── prisma/schema.prisma                    ← MODIFY — add autoAssign field
├── prisma/migrations/                      ← NEW migration
└── src/projects/
    ├── projects.service.ts                 ← MODIFY — include autoAssign in create/update/response
    ├── projects.controller.ts              ← MODIFY — expose autoAssign in responses
    └── dto/
        ├── create-project.dto.ts           ← MODIFY — add optional autoAssign field
        └── update-project.dto.ts           ← MODIFY — add optional autoAssign field
apps/cli/src/
└── commands/agent.ts                       ← MODIFY — add `pickup` sub-command
```

**Schema change:**
```prisma
model Project {
  // ... existing fields
  autoAssign    String  @default("OFF")  // "OFF" | "SUGGEST" | "AUTO"
}
```

**`AutoAssignMode` enum** — add to `apps/api/src/common/enums.ts`:
```typescript
export const AutoAssignMode = {
  OFF: 'OFF',
  SUGGEST: 'SUGGEST',
  AUTO: 'AUTO',
} as const;
export type AutoAssignMode = typeof AutoAssignMode[keyof typeof AutoAssignMode];
```

**Migration:** Run `cd apps/api && npx prisma migrate dev --name add_auto_assign`

**CLI `koda agent pickup` command** (extend `apps/cli/src/commands/agent.ts`):
```bash
koda agent pickup --project <slug> [--json]
```
Human output:
```
Suggested ticket: KODA-5 — Fix null reference in AuthService
Priority: HIGH | Type: BUG
Match score: 2 | Matched capabilities: typescript, auth
```
No match output: `No suitable tickets found for pickup.`

**Unit tests:**
- Create project → `autoAssign` defaults to `OFF`
- Update project with `autoAssign: 'SUGGEST'` → persisted
- Invalid `autoAssign` value → 400 validation error

**Acceptance Criteria:**
- [ ] `autoAssign` field added to Prisma schema with `@default("OFF")`
- [ ] Migration created and applied without errors (`prisma migrate dev`)
- [ ] `AutoAssignMode` const enum added to `src/common/enums.ts`
- [ ] `autoAssign` returned in project list/show responses
- [ ] `autoAssign` accepts `OFF | SUGGEST | AUTO` values; invalid value → 400
- [ ] `koda agent pickup --project koda` exits 0, prints suggested ticket or "no match"
- [ ] `koda agent pickup --json` outputs raw JSON from pickup endpoint
- [ ] `bun run test` passes in both `apps/api` and `apps/cli`

---

## Dependency Order

```
US-001 (KB CLI — standalone, no API changes)
US-002 (Agent pickup endpoint in API)
  └→ US-003 (auto_assign schema + agent pickup CLI — needs US-002 endpoint)
```

US-001 and US-002 can run in parallel. US-003 depends on US-002.

---

## Files Summary

| File | Action | Story |
|:-----|:-------|:------|
| `apps/cli/src/commands/kb.ts` | CREATE | US-001 |
| `apps/cli/src/main.ts` | MODIFY — register kbCommand | US-001 |
| `apps/cli/src/commands/kb.spec.ts` | CREATE | US-001 |
| `apps/api/src/agents/agents.service.ts` | MODIFY — add suggestTicket() | US-002 |
| `apps/api/src/agents/agents.controller.ts` | MODIFY — add GET :slug/pickup | US-002 |
| `apps/api/prisma/schema.prisma` | MODIFY — add autoAssign | US-003 |
| `apps/api/src/common/enums.ts` | MODIFY — add AutoAssignMode | US-003 |
| `apps/api/src/projects/dto/create-project.dto.ts` | MODIFY — add autoAssign | US-003 |
| `apps/api/src/projects/dto/update-project.dto.ts` | MODIFY — add autoAssign | US-003 |
| `apps/api/src/projects/projects.service.ts` | MODIFY — expose autoAssign | US-003 |
| `apps/cli/src/commands/agent.ts` | MODIFY — add pickup sub-command | US-003 |
