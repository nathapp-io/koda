# SPEC: Ticket Links — Structured VCS References

**Status:** Draft  
**Date:** 2026-03-26  
**Phase:** 9  
**Feature:** `vcs-integration`

---

## Summary

Add a `TicketLink` model and API endpoints so agents and CI pipelines can structurally associate PR/MR URLs with tickets. A new `ticket link` / `ticket unlink` CLI command pair lets any agent log a PR to a ticket in one command. Provider (GitHub, GitLab, Bitbucket) and external reference (repo + number) are auto-detected from the URL.

---

## Motivation

Today, agents link PRs to tickets via free-text comments (`--type REVIEW`). This works but is unstructured — there is no way to query "which PR is linked to KDA-42?" without parsing comment bodies.

What's missing:
- Structured `links[]` on every ticket response — PR URL, provider, PR number, repo
- `koda ticket link KDA-42 --url <pr_url>` — one command, no custom comment body
- Deduplication — linking the same URL twice is a no-op, not an error
- Foundation for Phase 10 auto-sync (webhook: PR merged → auto-close ticket)

---

## Design

### Prisma Model

```prisma
model TicketLink {
  id          String   @id @default(cuid())
  ticketId    String
  url         String
  provider    String   // "github" | "gitlab" | "bitbucket" | "other"
  externalRef String?  // e.g. "nathapp-io/koda#12"
  createdAt   DateTime @default(now())

  ticket Ticket @relation(fields: [ticketId], references: [id], onDelete: Cascade)

  @@unique([ticketId, url])
}
```

Add to `Ticket` model: `links TicketLink[]`

### Provider Detection

```typescript
// src/ticket-links/utils/detect-provider.ts

export type LinkProvider = 'github' | 'gitlab' | 'bitbucket' | 'other';

export interface ParsedLink {
  provider: LinkProvider;
  externalRef: string | null; // "owner/repo#number" or null if not a PR/MR URL
}

// github.com/owner/repo/pull/42       → { provider: 'github', externalRef: 'owner/repo#42' }
// gitlab.com/owner/repo/-/merge_requests/7 → { provider: 'gitlab', externalRef: 'owner/repo#7' }
// bitbucket.org/owner/repo/pull-requests/3 → { provider: 'bitbucket', externalRef: 'owner/repo#3' }
// any other URL                        → { provider: 'other', externalRef: null }
export function detectProvider(url: string): ParsedLink
```

### API Endpoints

All endpoints are under `tickets.controller.ts` as nested routes:

```
POST   /projects/:projectSlug/tickets/:ref/links
       Body: { url: string }
       Response: TicketLinkResponseDto
       Rules: deduplicates on (ticketId, url) — returns existing if already linked

GET    /projects/:projectSlug/tickets/:ref/links
       Response: TicketLinkResponseDto[]

DELETE /projects/:projectSlug/tickets/:ref/links/:linkId
       Response: 204 No Content
       Rules: 404 if linkId not found on this ticket
```

`GET /projects/:projectSlug/tickets/:ref` already exists — add `links: TicketLinkResponseDto[]` to `TicketResponseDto`.

### DTOs

```typescript
// CreateTicketLinkDto
export class CreateTicketLinkDto {
  @IsUrl()
  url: string;
}

// TicketLinkResponseDto
export class TicketLinkResponseDto {
  id: string;
  url: string;
  provider: string;       // "github" | "gitlab" | "bitbucket" | "other"
  externalRef: string | null;
  createdAt: string;
}
```

### CLI Commands

```bash
# Link a PR/MR to a ticket
koda ticket link KDA-42 --url https://github.com/nathapp-io/koda/pull/12

# Remove a link (by URL)
koda ticket unlink KDA-42 --url https://github.com/nathapp-io/koda/pull/12

# Links are included in ticket show
koda ticket show KDA-42 --json
# → { ..., "links": [{ "id": "...", "url": "...", "provider": "github", "externalRef": "nathapp-io/koda#12" }] }
```

---

## Stories

| ID | Title | Complexity | Depends On |
|:---|:------|:-----------|:-----------|
| VCS-001 | Prisma model + provider detection utility | Simple | — |
| VCS-002 | API endpoints — POST, GET, DELETE | Medium | VCS-001 |
| VCS-003 | Include `links[]` in ticket show response | Simple | VCS-002 |
| VCS-004 | CLI `ticket link` + `ticket unlink` commands | Medium | VCS-002 |

---

## Acceptance Criteria

### VCS-001 — Prisma Model + Provider Detection

- `TicketLink` model exists in `schema.prisma` with fields `id`, `ticketId`, `url`, `provider`, `externalRef`, `createdAt` and a `@@unique([ticketId, url])` constraint
- `detectProvider('https://github.com/owner/repo/pull/42')` returns `{ provider: 'github', externalRef: 'owner/repo#42' }`
- `detectProvider('https://gitlab.com/owner/repo/-/merge_requests/7')` returns `{ provider: 'gitlab', externalRef: 'owner/repo#7' }`
- `detectProvider('https://bitbucket.org/owner/repo/pull-requests/3')` returns `{ provider: 'bitbucket', externalRef: 'owner/repo#3' }`
- `detectProvider('https://example.com/anything')` returns `{ provider: 'other', externalRef: null }`
- `detectProvider` does not throw on malformed URLs — returns `{ provider: 'other', externalRef: null }`

### VCS-002 — API Endpoints

- `POST /projects/:slug/tickets/:ref/links` with `{ url }` returns `201` and a `TicketLinkResponseDto` with `provider` and `externalRef` auto-populated
- `POST /projects/:slug/tickets/:ref/links` with a URL that is already linked returns `200` and the existing `TicketLinkResponseDto` (no duplicate created)
- `POST /projects/:slug/tickets/:ref/links` with an invalid URL (not a URL) returns `400`
- `POST /projects/:slug/tickets/:ref/links` with an unknown ticket ref returns `404`
- `GET /projects/:slug/tickets/:ref/links` returns an array of `TicketLinkResponseDto` for all links on that ticket
- `GET /projects/:slug/tickets/:ref/links` returns an empty array when no links exist
- `DELETE /projects/:slug/tickets/:ref/links/:linkId` returns `204` when the link exists and belongs to that ticket
- `DELETE /projects/:slug/tickets/:ref/links/:linkId` returns `404` when `linkId` does not exist on that ticket

### VCS-003 — Ticket Show Integration

- `GET /projects/:slug/tickets/:ref` response includes `links: TicketLinkResponseDto[]`
- `GET /projects/:slug/tickets/:ref` returns `links: []` when no links exist on the ticket
- Adding a link via `POST .../links` causes the ticket show response to include it in `links[]`

### VCS-004 — CLI Commands

- `koda ticket link <ref> --url <url>` calls `POST /projects/:slug/tickets/:ref/links` and prints the created link
- `koda ticket link <ref> --url <url>` with `--json` flag prints raw `TicketLinkResponseDto` JSON
- `koda ticket link <ref> --url <url>` when the URL is already linked prints the existing link without error
- `koda ticket unlink <ref> --url <url>` fetches links, finds matching URL, calls `DELETE .../links/:id`, exits 0
- `koda ticket unlink <ref> --url <url>` when no link matches that URL prints `"No link found for <url>"` and exits 1
- `koda ticket show <ref> --json` output includes `"links"` array with all linked PRs/MRs

---

## Context Files

### API
- `apps/api/prisma/schema.prisma` — existing models to follow for new `TicketLink`
- `apps/api/src/tickets/tickets.controller.ts` — existing controller pattern (nested routes, `@Public` + JWT guard, `JsonResponse`)
- `apps/api/src/tickets/tickets.service.ts` — `findByRef()` to resolve ticket from `:ref` param
- `apps/api/src/comments/comments.controller.ts` — another nested resource pattern to follow
- `apps/api/src/comments/comments.service.ts` — service pattern with Prisma access

### CLI
- `apps/cli/src/commands/ticket.ts` — existing ticket subcommands (`show`, `create`, `comment`) to extend
- `apps/cli/src/generated.ts` — regenerate after API changes (run `bun run generate` from `apps/cli`)
- `apps/cli/src/config.ts` — config resolution for `apiUrl` + `apiKey`
