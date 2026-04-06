# SPEC: VCS Phase 4 — Branch & Commit Links

**Status:** Draft  
**Date:** 2026-04-06  
**Feature:** `vcs-integration`  
**Depends On:** Phase 3 (PR Status Sync)

---

## Summary

Automatically extract and display branch and commit references linked to Koda tickets. When PR data is fetched (via webhook or polling), the head branch and commits that reference a ticket key (e.g. `KODA-42`) in their message are stored as `TicketLink` entries. The web UI groups links by type (PR, branch, commit) on the ticket detail page, and the CLI includes them in ticket show output.

---

## Motivation

After Phases 2 and 3, Koda tracks PRs linked to tickets. But developers also reference tickets in commit messages (`KODA-42: fix null check`) and work on named branches (`koda/KODA-42/fix-null-check`). Today these references are invisible in Koda — you'd have to go to GitHub to see them.

What's missing:
- Branch link extracted from PR head branch and stored as a `TicketLink`
- Commit links extracted from PR commits that reference `{KEY}-{number}` in their message
- Grouped display of all VCS artifacts (PRs, branches, commits) on the ticket detail page
- A `linkType` field on `TicketLink` to distinguish PRs from branches from commits

---

## Design

### Extend TicketLink

```prisma
model TicketLink {
  // ... existing fields ...
  linkType  String  @default("url")  // "url" | "pr" | "branch" | "commit"
}
```

Existing links default to `"url"`. Phase 2 PR creation sets `"pr"`. This phase adds `"branch"` and `"commit"`.

### Extend IVcsProvider

```typescript
// Add to src/vcs/providers/vcs-provider.interface.ts

export interface VcsCommit {
  sha: string;
  message: string;
  authorLogin: string | null;
  url: string;
  date: string;
}

export interface IVcsProvider {
  // ... existing methods ...

  /** List commits on a pull request. */
  listPrCommits(prNumber: number): Promise<VcsCommit[]>;
}
```

### Link Extraction Logic

```typescript
// src/vcs/vcs-link-extractor.service.ts

async extractLinksFromPr(
  project: Project & { vcsConnection: VcsConnection },
  prNumber: number,
  ticketLink: TicketLink,
): Promise<{ branchLinksCreated: number; commitLinksCreated: number }>
```

1. Get PR details via `provider.getPullRequestStatus(prNumber)` → extract `branchName`
2. Build branch URL: `https://github.com/{owner}/{repo}/tree/{branchName}`
3. Upsert `TicketLink` with `linkType = 'branch'`, `url = branchUrl`, `provider = 'github'`
4. Get PR commits via `provider.listPrCommits(prNumber)`
5. Filter commits whose message contains `{KEY}-{number}` (case-insensitive match)
6. For each matching commit, upsert `TicketLink` with `linkType = 'commit'`, `url = commitUrl`, `provider = 'github'`

### Ticket Key Pattern Matching

```typescript
// src/vcs/utils/ticket-ref-matcher.util.ts

/**
 * Check if a string contains a reference to a ticket.
 * Matches patterns like "KODA-42", "koda-42", "PROJ-1".
 */
export function containsTicketRef(text: string, projectKey: string, ticketNumber: number): boolean

/**
 * Extract all ticket refs from a string.
 * Returns array of { key, number } matches.
 */
export function extractTicketRefs(text: string): Array<{ key: string; number: number }>
```

Pattern: `/\b{KEY}-{NUMBER}\b/i`

### Integration Points

**On PR creation (Phase 2):** After `createPrForTicket()` creates the PR and `TicketLink`, also call `extractLinksFromPr()` to create the branch link. (No commits exist yet on a fresh PR.)

**On PR status sync (Phase 3):** After `syncPrStatus()` updates a `TicketLink`, call `extractLinksFromPr()` to pick up new commits since last sync.

**On webhook `pull_request.synchronize` event:** This fires when new commits are pushed to the PR branch. Call `extractLinksFromPr()` to pick up the new commits.

### Web UI

Ticket detail page VCS section groups links by `linkType`:

```
Pull Requests
  PR #12 (merged) — owner/repo#12

Branch
  koda/KODA-42/fix-null-check

Commits
  abc123d — "KODA-42: fix null check in auth handler"
  def456a — "KODA-42: add unit tests"
```

Each entry is a clickable link to the GitHub URL.

### Failure Handling

- **GitHub API error when listing PR commits**: Log warning, skip commit extraction, branch link may still be created from PR data alone
- **Commit message does not match ticket ref**: Commit is not linked (this is expected — not all PR commits reference the ticket)
- **Duplicate link (same ticketId + url)**: Upsert via `@@unique([ticketId, url])` — no error, existing link is returned
- **PR has 250+ commits** (GitHub API pagination limit): Fetch first page only (250 commits). Log info if truncated. This covers the vast majority of PRs.

---

## Stories

| ID | Title | Complexity | Depends On |
|:---|:------|:-----------|:-----------|
| VCS-P4-001 | Extend TicketLink schema + IVcsProvider commits method + ticket ref matcher utility | Medium | Phase 3 |
| VCS-P4-002 | Link extractor service + integration with PR creation and PR status sync | Medium | VCS-P4-001 |
| VCS-P4-003 | Web grouped VCS links display + CLI ticket show links + webhook synchronize handler | Medium | VCS-P4-002 |

---

## Acceptance Criteria

### VCS-P4-001 — Schema + Provider + Utilities

- `TicketLink` model has a new field `linkType` with default `"url"`
- Existing `TicketLink` entries are unaffected by migration (default `"url"` applied)
- `GitHubProvider.listPrCommits(12)` calls `GET /repos/{owner}/{repo}/pulls/12/commits` and returns an array of `VcsCommit` with `sha`, `message`, `authorLogin`, `url`, `date`
- `GitHubProvider.listPrCommits(99999)` throws `NotFoundAppException` when GitHub returns 404
- `containsTicketRef('KODA-42: fix bug', 'KODA', 42)` returns `true`
- `containsTicketRef('koda-42 fix bug', 'KODA', 42)` returns `true` (case-insensitive)
- `containsTicketRef('fix bug in KODA-43', 'KODA', 42)` returns `false` (different number)
- `containsTicketRef('fix bug', 'KODA', 42)` returns `false` (no reference)
- `containsTicketRef('prefixKODA-42suffix', 'KODA', 42)` returns `false` (not a word boundary match)
- `extractTicketRefs('KODA-42 and PROJ-7 mentioned')` returns `[{ key: 'KODA', number: 42 }, { key: 'PROJ', number: 7 }]`

### Context Files
- `apps/api/prisma/schema.prisma` — `TicketLink` model to extend
- `apps/api/src/vcs/providers/vcs-provider.interface.ts` — interface to extend
- `apps/api/src/vcs/providers/github.provider.ts` — provider to extend
- `apps/api/src/ticket-links/` — existing TicketLink patterns

### VCS-P4-002 — Link Extractor + Integration

- `extractLinksFromPr()` creates a `TicketLink` with `linkType = 'branch'` for the PR's head branch
- `extractLinksFromPr()` creates `TicketLink` entries with `linkType = 'commit'` for each PR commit whose message contains the ticket ref
- `extractLinksFromPr()` does not create duplicate links (upserts on `@@unique([ticketId, url])`)
- `extractLinksFromPr()` skips commits whose message does not contain the ticket ref
- After Phase 2's `createPrForTicket()` completes, `extractLinksFromPr()` is called to create the branch link
- After Phase 3's `syncPrStatus()` updates a `TicketLink`, `extractLinksFromPr()` is called to pick up new commits
- When GitHub API fails during commit listing, the branch link is still created and the error is logged as a warning

### Context Files
- `apps/api/src/vcs/vcs.service.ts` — VCS service (Phase 1, extended in Phase 2)
- `apps/api/src/vcs/vcs-pr-sync.service.ts` — PR sync service (Phase 3)
- `apps/api/src/ticket-links/ticket-links.service.ts` — TicketLink creation pattern

### VCS-P4-003 — Web Display + CLI + Webhook

- Web ticket detail page VCS section groups links by `linkType`: PRs, branches, and commits displayed in separate subsections
- Web PR subsection shows PR number, status badge, and clickable link
- Web branch subsection shows branch name as a clickable link to GitHub
- Web commit subsection shows abbreviated SHA (7 chars) and commit message as a clickable link
- Web commit subsection shows commits in reverse chronological order (newest first)
- `koda ticket show <ref>` output displays linked branches and commits in the links section, grouped by type
- `koda ticket show <ref> --json` output includes `linkType` field on each entry in `links[]`
- `POST /projects/:slug/vcs-webhook` with `pull_request.synchronize` event calls `extractLinksFromPr()` to capture new commits
- i18n keys exist in both `en` and `zh` for branch/commit link display labels

### Context Files
- `apps/web/pages/[project]/tickets/[ref].vue` — ticket detail page
- `apps/web/components/TicketCard.vue` — ticket card component
- `apps/cli/src/commands/ticket.ts` — `show` subcommand
- `apps/api/src/vcs/vcs-webhook.controller.ts` — webhook controller (Phase 1)
- `apps/web/i18n/locales/en.json` — i18n keys
