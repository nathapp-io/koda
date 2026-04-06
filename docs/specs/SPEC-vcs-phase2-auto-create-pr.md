# SPEC: VCS Phase 2 — Auto-Create PR on Verified

**Status:** Draft  
**Date:** 2026-04-06  
**Feature:** `vcs-integration`  
**Depends On:** Phase 1 (VCS Connection + GitHub Issue Sync)

---

## Summary

When a ticket transitions to `VERIFIED` status, automatically create a GitHub branch and draft pull request linked to the ticket. The branch follows a conventional naming pattern (`koda/{KEY}-{number}/{slug}`), the PR body includes the ticket description, and the PR URL is stored as a `TicketLink` on the ticket. This gives developers (human or agent) a ready-to-use branch the moment a ticket is confirmed as valid work.

---

## Motivation

After a ticket is verified, the next step is always the same: create a branch, open a PR, start coding. Today this is manual. Automating it removes friction and ensures every verified ticket has a trackable PR from the start.

Why `VERIFIED` (not `IN_PROGRESS`):
- The state machine allows `VERIFIED → IN_PROGRESS` with no comment required — it's a lightweight transition
- Creating the PR at `VERIFIED` means the branch is ready before anyone picks up the work
- An agent can transition to `IN_PROGRESS` and immediately start pushing commits to the branch

---

## Design

### Extend IVcsProvider

```typescript
// Add to src/vcs/providers/vcs-provider.interface.ts

export interface CreatePrParams {
  branchName: string;
  title: string;
  body: string;
  baseBranch?: string;  // defaults to repo default branch
  draft?: boolean;       // defaults to true
}

export interface VcsPullRequest {
  number: number;
  url: string;
  branchName: string;
  state: string;        // 'open' | 'closed' | 'merged'
  draft: boolean;
}

export interface IVcsProvider {
  // ... existing Phase 1 methods ...

  /** Create a branch and open a pull request. */
  createPullRequest(params: CreatePrParams): Promise<VcsPullRequest>;

  /** Get the default branch name for the repo. */
  getDefaultBranch(): Promise<string>;
}
```

### GitHub Provider Implementation

`GitHubProvider.createPullRequest()`:
1. Get default branch via `GET /repos/{owner}/{repo}` → `default_branch`
2. Get HEAD SHA of default branch via `GET /repos/{owner}/{repo}/git/ref/heads/{default_branch}`
3. Create branch via `POST /repos/{owner}/{repo}/git/refs` with `ref: refs/heads/{branchName}` pointing to HEAD SHA
4. Create PR via `POST /repos/{owner}/{repo}/pulls` with `head: branchName`, `base: defaultBranch`, `draft: true`

### Branch Name Utility

```typescript
// src/vcs/utils/branch-name.util.ts

/**
 * Build a branch name from ticket ref and title.
 * Example: buildBranchName('KODA', 42, 'Fix login redirect bug')
 *          → 'koda/KODA-42/fix-login-redirect-bug'
 */
export function buildBranchName(
  projectKey: string,
  ticketNumber: number,
  title: string,
): string
```

Rules:
- Prefix: `koda/`
- Ticket ref: `{KEY}-{number}`
- Slug: lowercase, alphanumeric + hyphens only, max 50 chars, no trailing hyphens
- Full branch name max 100 chars

### Integration Point

Hook into the ticket status transition flow. After `validateTransition()` succeeds for any transition `→ VERIFIED`:

```typescript
// In tickets.service.ts — after successful status update to VERIFIED

if (newStatus === TicketStatus.VERIFIED && project.vcsConnection?.isActive) {
  void this.vcsService.createPrForTicket(ticket, project).catch((err) => {
    // Fire-and-forget — log error, don't block the transition
    this.logger.warn(`Failed to create PR for ${ticketRef}: ${err.message}`);
  });
}
```

**Fire-and-forget**: The status transition succeeds regardless of whether the PR creation works. If GitHub is down or the token is expired, the transition still completes. The error is logged and can be retried manually.

### VcsService.createPrForTicket()

```typescript
async createPrForTicket(
  ticket: { id: string; number: number; title: string; description: string | null },
  project: { key: string; vcsConnection: VcsConnection },
): Promise<void>
```

1. Build branch name via `buildBranchName(project.key, ticket.number, ticket.title)`
2. Build PR title: `{KEY}-{number}: {ticket.title}`
3. Build PR body: ticket description (or empty string if null)
4. Call `provider.createPullRequest({ branchName, title, body, draft: true })`
5. Create `TicketLink` with `{ ticketId, url: pr.url, provider: 'github', externalRef: '{owner}/{repo}#{pr.number}' }`
6. Log `TicketActivity` with action `'VCS_PR_CREATED'`

### New Activity Type

Add to `src/common/enums.ts`:

```typescript
export const ActivityType = {
  // ... existing ...
  VCS_PR_CREATED: 'VCS_PR_CREATED',
} as const;
```

### Failure Handling

- **GitHub API error (401, 403, 422, 500)**: Log warning with error details, do not block ticket transition, do not create `TicketLink`
- **Branch already exists (422)**: This can happen if the ticket was previously verified, rejected, then re-verified. Attempt to create PR pointing to existing branch. If PR also exists, skip silently.
- **Token decryption fails**: Log error, skip PR creation
- **No VCS connection on project**: Skip silently (not all projects use VCS)
- **VCS connection inactive**: Skip silently

---

## Stories

| ID | Title | Complexity | Depends On |
|:---|:------|:-----------|:-----------|
| VCS-P2-001 | Branch name utility + extend IVcsProvider + GitHub PR creation | Medium | Phase 1 |
| VCS-P2-002 | Auto-create PR on VERIFIED transition + TicketLink + activity log | Medium | VCS-P2-001 |
| VCS-P2-003 | Web ticket detail PR link display + CLI ticket show PR info | Simple | VCS-P2-002 |

---

## Acceptance Criteria

### VCS-P2-001 — Branch Name Utility + GitHub PR Creation

- `buildBranchName('KODA', 42, 'Fix login redirect bug')` returns `'koda/KODA-42/fix-login-redirect-bug'`
- `buildBranchName('PROJ', 1, 'A very long title that exceeds the maximum allowed length for branch names')` returns a branch name that is at most 100 characters
- `buildBranchName('PROJ', 1, 'Special chars: @#$%^&*()')` returns a branch name with only alphanumeric characters and hyphens in the slug portion
- `buildBranchName('PROJ', 1, 'trailing---hyphens---')` returns a branch name with no trailing hyphens in the slug portion
- `GitHubProvider.createPullRequest()` creates a new branch from the repo's default branch HEAD
- `GitHubProvider.createPullRequest()` opens a draft PR targeting the default branch and returns a `VcsPullRequest` with `number`, `url`, `branchName`, `state`, and `draft` fields
- `GitHubProvider.createPullRequest()` when the branch already exists (HTTP 422 on ref creation) skips branch creation and proceeds to create the PR
- `GitHubProvider.getDefaultBranch()` returns the repository's default branch name (e.g. `'main'`)

### Context Files
- `apps/api/src/vcs/providers/vcs-provider.interface.ts` — interface to extend (created in Phase 1)
- `apps/api/src/vcs/providers/github.provider.ts` — provider to extend (created in Phase 1)
- `apps/api/src/common/utils/git-url.util.ts` — existing URL building patterns
- `apps/api/src/ticket-links/` — TicketLink model and service patterns

### VCS-P2-002 — Auto-Create PR on VERIFIED Transition

- When a ticket transitions to `VERIFIED` and the project has an active VCS connection, `vcsService.createPrForTicket()` is called
- `createPrForTicket()` creates a `TicketLink` with the PR URL, provider `'github'`, and `externalRef` in `owner/repo#number` format
- `createPrForTicket()` logs a `TicketActivity` with action `'VCS_PR_CREATED'`
- When a ticket transitions to `VERIFIED` and the project has no VCS connection, no PR creation is attempted
- When a ticket transitions to `VERIFIED` and GitHub API returns an error, the ticket transition still succeeds (fire-and-forget)
- When a ticket transitions to `VERIFIED` and GitHub API returns an error, a warning is logged with the error details
- `ActivityType.VCS_PR_CREATED` is added to the `ActivityType` enum in `src/common/enums.ts`
- When a ticket transitions to a status other than `VERIFIED`, no PR creation is attempted

### Context Files
- `apps/api/src/tickets/tickets.service.ts` — status transition logic to hook into
- `apps/api/src/tickets/state-machine/ticket-transitions.ts` — transition rules
- `apps/api/src/ticket-links/ticket-links.service.ts` — TicketLink creation pattern
- `apps/api/src/common/enums.ts` — ActivityType enum to extend
- `apps/api/src/webhook/webhook-dispatcher.service.ts` — fire-and-forget pattern

### VCS-P2-003 — Web + CLI Display

- Web ticket detail page shows linked PR as a clickable badge with PR number and status (e.g. "PR #12 draft") when a `TicketLink` with provider `'github'` and an `externalRef` containing a PR number exists
- Web ticket activity timeline shows "PR created: owner/repo#12" entry for `VCS_PR_CREATED` activity type
- `koda ticket show <ref>` output includes linked PR URL and external ref in the links section
- `koda ticket show <ref> --json` output includes `links[]` with PR `TicketLink` entries
- i18n keys exist in both `en` and `zh` for PR-related display strings in API and web

### Context Files
- `apps/web/pages/[project]/tickets/[ref].vue` — ticket detail page to extend
- `apps/web/components/TicketCard.vue` — ticket card to extend (if not already done in Phase 1)
- `apps/cli/src/commands/ticket.ts` — `show` subcommand output
- `apps/web/i18n/locales/en.json` — i18n keys
- `apps/api/src/i18n/{en,zh}/vcs.json` — API i18n keys (created in Phase 1)
