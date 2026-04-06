# SPEC: VCS Phase 3 — PR/MR Status Sync

**Status:** Draft  
**Date:** 2026-04-06  
**Feature:** `vcs-integration`  
**Depends On:** Phase 2 (Auto-Create PR)

---

## Summary

Synchronize pull request status from GitHub back into Koda tickets. When a linked PR is merged, the ticket automatically transitions from `IN_PROGRESS` to `VERIFY_FIX` with an auto-generated `FIX_REPORT` comment containing merge metadata. PR status (draft, open, merged, closed) is tracked on the `TicketLink` and displayed in the web UI and CLI. Sync uses the same dual-mode approach as issue sync: webhook (`pull_request` events) or polling.

---

## Motivation

After Phase 2, Koda creates PRs for verified tickets, but has no visibility into what happens next. Developers merge PRs in GitHub, then must manually update the ticket status in Koda. This breaks the workflow — tickets get stuck in `IN_PROGRESS` long after the code is merged.

What's missing:
- PR status tracked on `TicketLink` (draft / open / merged / closed)
- Automatic `IN_PROGRESS → VERIFY_FIX` transition when PR is merged
- Auto-generated `FIX_REPORT` comment with merge SHA, PR URL, and author
- PR status visible on ticket cards and ticket detail page

---

## Design

### Extend IVcsProvider

```typescript
// Add to src/vcs/providers/vcs-provider.interface.ts

export interface VcsPrStatus {
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergedBy: string | null;     // GitHub login of merge author
  mergeSha: string | null;     // merge commit SHA
  url: string;
  title: string;
}

export interface IVcsProvider {
  // ... existing methods ...

  /** Get current status of a pull request. */
  getPullRequestStatus(prNumber: number): Promise<VcsPrStatus>;

  /** List open PRs that reference a branch name pattern. */
  listPullRequests(state?: 'open' | 'closed' | 'all'): Promise<VcsPrStatus[]>;
}
```

### Extend TicketLink

Add PR-specific tracking fields to `TicketLink`:

```prisma
model TicketLink {
  // ... existing fields ...
  prState     String?    // "draft" | "open" | "merged" | "closed"
  prNumber    Int?       // PR number for direct lookup
  prUpdatedAt DateTime?  // last time PR status was synced
}
```

`prState` is a denormalized view of the PR status:
- `draft` = PR is open and draft
- `open` = PR is open and not draft
- `merged` = PR was merged
- `closed` = PR was closed without merge

### PR Status Sync Logic

```typescript
// src/vcs/vcs-pr-sync.service.ts

async syncPrStatus(
  project: Project & { vcsConnection: VcsConnection },
): Promise<{ updated: number }>
```

1. Find all `TicketLink` entries for the project where `provider = 'github'` and `prNumber IS NOT NULL` and `prState NOT IN ('merged', 'closed')`
2. For each link, call `provider.getPullRequestStatus(link.prNumber)`
3. Compute new `prState` from response
4. If `prState` changed, update the `TicketLink`
5. If new state is `merged`, trigger ticket transition (see below)

### Auto-Transition on Merge

When a PR status changes to `merged`:

1. Load the ticket associated with the `TicketLink`
2. Check if ticket status is `IN_PROGRESS` — only auto-transition from this status
3. Call `validateTransition(IN_PROGRESS, VERIFY_FIX)` — this requires a `FIX_REPORT` comment
4. Auto-generate a `FIX_REPORT` comment:
   ```
   PR merged: {pr.url}
   Merge commit: {pr.mergeSha}
   Merged by: {pr.mergedBy}
   ```
5. Transition ticket to `VERIFY_FIX` with the auto-generated comment
6. Log `TicketActivity` with action `'VCS_PR_MERGED'`

**Guard rails:**
- Only auto-transition from `IN_PROGRESS` — if ticket is in any other status, update `prState` on the link but do not transition
- If transition fails (e.g. ticket was already moved), log warning and continue

### Polling

Extend `VcsSyncService` to also poll PR statuses. On each polling tick (same interval as issue sync):

1. Run issue sync (existing Phase 1 logic)
2. Run PR status sync (new Phase 3 logic)

### Webhook

Extend the existing `POST /projects/:slug/vcs-webhook` controller to handle `pull_request` events:

| GitHub Action | Koda Effect |
|:-------------|:------------|
| `opened` | Update `TicketLink.prState` to `'open'` or `'draft'` |
| `ready_for_review` | Update `prState` from `'draft'` to `'open'` |
| `closed` + `merged = true` | Update `prState` to `'merged'`, trigger auto-transition |
| `closed` + `merged = false` | Update `prState` to `'closed'` |
| `reopened` | Update `prState` to `'open'` |
| `converted_to_draft` | Update `prState` to `'draft'` |

Match PR to ticket via `prNumber` on `TicketLink`.

### New Activity Type

Add to `src/common/enums.ts`:

```typescript
export const ActivityType = {
  // ... existing ...
  VCS_PR_MERGED: 'VCS_PR_MERGED',
} as const;
```

### API Endpoints

No new endpoints. PR status sync runs via:
- Existing polling interval (extended)
- Existing webhook endpoint (extended to handle `pull_request` events)

One optional convenience endpoint:

| Method | Path | Auth | Purpose |
|:-------|:-----|:-----|:--------|
| `POST` | `/projects/:slug/vcs/sync-pr` | Bearer | Trigger manual PR status sync |

### Failure Handling

- **GitHub API error when fetching PR status**: Log warning, skip this PR, continue with next. Do not update `prState` on failure.
- **Ticket not in `IN_PROGRESS` when PR merges**: Update `prState` to `'merged'` on the link, but do not attempt transition. Log info-level message.
- **Transition validation fails**: Log warning, do not block. The `prState` is still updated.
- **PR number not found on GitHub (404)**: Log warning, mark `prState` as `'closed'` (PR was likely deleted).
- **Multiple PRs linked to same ticket**: Each PR is tracked independently. Only the first merge triggers the auto-transition (subsequent merges find the ticket already in `VERIFY_FIX` or beyond).

---

## Stories

| ID | Title | Complexity | Depends On |
|:---|:------|:-----------|:-----------|
| VCS-P3-001 | Extend TicketLink schema + IVcsProvider PR status methods + GitHub implementation | Medium | Phase 2 |
| VCS-P3-002 | PR status sync service + auto-transition on merge + polling/webhook integration | Complex | VCS-P3-001 |
| VCS-P3-003 | Web PR status display + CLI PR info + manual sync-pr endpoint | Medium | VCS-P3-002 |

---

## Acceptance Criteria

### VCS-P3-001 — Schema + Provider PR Status

- `TicketLink` model has new nullable fields `prState`, `prNumber` (Int), `prUpdatedAt`
- `GitHubProvider.getPullRequestStatus(42)` calls `GET /repos/{owner}/{repo}/pulls/42` and returns a `VcsPrStatus` with `number`, `state`, `draft`, `merged`, `mergedAt`, `mergedBy`, `mergeSha`, `url`, `title`
- `GitHubProvider.getPullRequestStatus(42)` returns `merged: true` and populates `mergedAt`, `mergedBy`, `mergeSha` when the PR has been merged
- `GitHubProvider.getPullRequestStatus(99999)` throws `NotFoundAppException` when GitHub returns 404
- `GitHubProvider.listPullRequests('open')` returns an array of `VcsPrStatus` for all open PRs in the repo
- Phase 2 `createPullRequest()` now also sets `prNumber` and `prState` on the created `TicketLink`

### Context Files
- `apps/api/prisma/schema.prisma` — `TicketLink` model to extend
- `apps/api/src/vcs/providers/vcs-provider.interface.ts` — interface to extend
- `apps/api/src/vcs/providers/github.provider.ts` — provider to extend
- `apps/api/src/ticket-links/ticket-links.service.ts` — TicketLink patterns

### VCS-P3-002 — PR Status Sync + Auto-Transition

- `vcsPrSyncService.syncPrStatus()` queries `TicketLink` entries where `prNumber IS NOT NULL` and `prState NOT IN ('merged', 'closed')` for the project
- `syncPrStatus()` updates `TicketLink.prState` and `prUpdatedAt` when the GitHub PR state has changed
- When a PR state changes to `merged` and the ticket is in `IN_PROGRESS`, the ticket transitions to `VERIFY_FIX`
- The auto-transition creates a `Comment` with type `FIX_REPORT` containing the PR URL, merge commit SHA, and merge author
- The auto-transition logs a `TicketActivity` with action `VCS_PR_MERGED`
- When a PR state changes to `merged` and the ticket is NOT in `IN_PROGRESS`, `prState` is updated but no transition is attempted
- When the GitHub API returns an error for a specific PR, that PR is skipped and the sync continues with remaining PRs
- Polling service runs PR status sync after issue sync on each polling tick
- `POST /projects/:slug/vcs-webhook` with `pull_request.closed` event and `merged = true` updates `prState` to `'merged'` and triggers auto-transition
- `POST /projects/:slug/vcs-webhook` with `pull_request.closed` event and `merged = false` updates `prState` to `'closed'` without transition
- `POST /projects/:slug/vcs-webhook` with `pull_request.opened` event updates `prState` to `'open'` or `'draft'` based on the PR's draft flag
- `POST /projects/:slug/vcs-webhook` with `pull_request.ready_for_review` event updates `prState` from `'draft'` to `'open'`
- Webhook matches PR to `TicketLink` via `prNumber` field

### Context Files
- `apps/api/src/vcs/vcs-sync.service.ts` — polling service to extend (created in Phase 1)
- `apps/api/src/vcs/vcs-webhook.controller.ts` — webhook controller to extend (created in Phase 1)
- `apps/api/src/tickets/tickets.service.ts` — ticket transition logic
- `apps/api/src/tickets/state-machine/ticket-transitions.ts` — `IN_PROGRESS → VERIFY_FIX` requires `FIX_REPORT`
- `apps/api/src/comments/comments.service.ts` — comment creation pattern
- `apps/api/src/common/enums.ts` — ActivityType enum

### VCS-P3-003 — Web + CLI Display + Manual Sync

- Web ticket card on the board shows a PR status badge (colored dot/label: green for merged, blue for open, gray for draft, red for closed) when `prState` is present on a linked `TicketLink`
- Web ticket detail page shows PR status section with: PR number (linked), current state badge, merge info (SHA, author, time) when merged
- Web ticket detail activity timeline shows "PR merged: owner/repo#12 by @user" for `VCS_PR_MERGED` activity
- `koda ticket show <ref>` displays linked PR status (number, state) in the output
- `koda ticket show <ref> --json` includes `prState`, `prNumber`, `prUpdatedAt` in `links[]` entries
- `POST /projects/:slug/vcs/sync-pr` triggers a manual PR status sync and returns `{ updated: number }`
- `koda vcs sync-pr` calls the manual PR sync endpoint and prints the count of updated PRs
- i18n keys exist in both `en` and `zh` for PR status labels and merge notification strings

### Context Files
- `apps/web/components/TicketCard.vue` — ticket card component
- `apps/web/pages/[project]/tickets/[ref].vue` — ticket detail page
- `apps/cli/src/commands/ticket.ts` — `show` subcommand
- `apps/cli/src/commands/vcs.ts` — VCS commands (created in Phase 1)
- `apps/web/i18n/locales/en.json` — i18n keys
