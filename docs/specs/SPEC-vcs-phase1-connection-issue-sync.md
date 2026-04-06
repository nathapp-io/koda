# SPEC: VCS Phase 1 — Connection + GitHub Issue Sync

**Status:** Draft  
**Date:** 2026-04-06  
**Feature:** `vcs-integration`

---

## Summary

Add a per-project VCS connection model and a GitHub issue sync pipeline so that issues from a configured GitHub repository can be imported into Koda as tickets. Projects configure a connection (repo, token, sync mode, allowed authors), then issues flow in via scheduled polling, inbound webhook, or manual single-issue import. This phase is GitHub-only; the provider interface is designed for GitLab to be added later without changing sync logic.

---

## Motivation

Today Koda tickets are created manually or via CI webhook (pipeline failures only). Teams that track work in GitHub Issues must context-switch between systems or manually duplicate issues into Koda.

What's missing:
- A per-project VCS connection that stores repo coordinates, auth token, and sync preferences
- Automatic inbound sync of GitHub issues into Koda tickets (polling or webhook)
- Author-based filtering so only issues from configured team members are synced
- A manual "import this issue" action for issues outside the author allowlist
- A provider abstraction (`IVcsProvider`) so GitLab can be added in Phase 5 without changing sync logic

---

## Design

### Provider Interface

```typescript
// src/vcs/providers/vcs-provider.interface.ts

export interface VcsIssue {
  number: number;
  title: string;
  body: string | null;
  authorLogin: string;
  url: string;
  labels: string[];
  createdAt: string;
}

export interface IVcsProvider {
  /** Fetch issues created/updated since a given date. */
  fetchIssues(since?: Date): Promise<VcsIssue[]>;

  /** Fetch a single issue by number. */
  fetchIssue(issueNumber: number): Promise<VcsIssue>;

  /** Validate that the token and repo are accessible. */
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}
```

`GitHubProvider` implements this using GitHub REST API (`GET /repos/{owner}/{repo}/issues`). GitLab provider will implement the same interface later.

### Provider Factory

```typescript
// src/vcs/providers/index.ts

export function createVcsProvider(
  provider: 'github' | 'gitlab',
  config: { apiUrl: string; token: string; repoOwner: string; repoName: string },
): IVcsProvider
```

Returns `GitHubProvider` for `'github'`. Throws `ValidationAppException` for unsupported providers.

### Token Encryption

VCS tokens must be stored encrypted at rest because they grant write access to external repos (unlike API key hashes which are one-way). Uses AES-256-GCM with a master key from env.

```typescript
// src/vcs/utils/token-crypto.util.ts

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/** Returns `iv:authTag:ciphertext` as hex. */
export function encryptToken(plaintext: string, masterKey: Buffer): string

/** Accepts `iv:authTag:ciphertext` hex string, returns plaintext. */
export function decryptToken(encrypted: string, masterKey: Buffer): string
```

- `masterKey` is derived from `VCS_ENCRYPTION_KEY` env var (32-byte hex string)
- GCM provides both confidentiality and integrity (tamper detection)
- Each encryption uses a unique random IV

### Prisma Model Changes

```prisma
model VcsConnection {
  id                String    @id @default(cuid())
  projectId         String    @unique          // one connection per project
  provider          String                      // "github" | "gitlab"
  repoOwner         String
  repoName          String
  encryptedToken    String                      // AES-256-GCM encrypted PAT
  syncMode          String    @default("off")   // "off" | "polling" | "webhook"
  allowedAuthors    String    @default("[]")    // JSON string array of GitHub usernames
  pollingIntervalMs Int       @default(600000)  // 10 minutes
  webhookSecret     String?                     // for verifying inbound GitHub webhooks
  lastSyncedAt      DateTime?
  isActive          Boolean   @default(true)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  project  Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  syncLogs VcsSyncLog[]
}

model VcsSyncLog {
  id              String   @id @default(cuid())
  vcsConnectionId String
  syncType        String   // "polling" | "webhook" | "manual"
  issuesSynced    Int      @default(0)
  issuesSkipped   Int      @default(0)
  errorMessage    String?
  startedAt       DateTime @default(now())
  completedAt     DateTime?

  connection VcsConnection @relation(fields: [vcsConnectionId], references: [id], onDelete: Cascade)
}
```

Extend `Ticket`:

```prisma
model Ticket {
  // ... existing fields ...
  externalVcsId   String?   // GitHub issue number as string, e.g. "42"
  externalVcsUrl  String?   // full URL to the GitHub issue
  vcsSyncedAt     DateTime? // when this ticket was last synced from VCS
}
```

Extend `Project`:

```prisma
model Project {
  // ... existing fields ...
  vcsConnection VcsConnection?
}
```

### Sync Logic

All three sync paths (polling, webhook, manual) share the same core:

```typescript
// src/vcs/vcs.service.ts

async syncIssue(
  project: Project,
  issue: VcsIssue,
  syncType: 'polling' | 'webhook' | 'manual',
): Promise<{ action: 'created' | 'skipped'; ticketRef?: string }>
```

1. Check if ticket with `externalVcsId = String(issue.number)` AND `projectId` already exists — if yes, return `skipped`
2. Create ticket via Prisma transaction (reuse existing number allocation pattern: `MAX(number)+1`)
3. Map fields: `title` → `title`, `body` → `description`, `TASK` type, `MEDIUM` priority, `CREATED` status
4. Set `externalVcsId`, `externalVcsUrl`, `vcsSyncedAt`
5. Return `created` with ticket ref

### Polling

`VcsSyncService` uses `SchedulerRegistry` from `@nestjs/schedule`. On module init, it registers an interval for each active connection with `syncMode = 'polling'`. Each tick:

1. Decrypt token, create provider
2. Call `provider.fetchIssues(connection.lastSyncedAt)`
3. Filter by `allowedAuthors` (JSON-parsed from `connection.allowedAuthors`)
4. For each issue, call `syncIssue()`
5. Update `connection.lastSyncedAt`
6. Write `VcsSyncLog`

When a connection is created/updated/deleted, the interval is added/replaced/removed dynamically.

### Webhook

```
POST /projects/:slug/vcs-webhook
```

- `@Public()` — no Bearer auth
- Verify `X-Hub-Signature-256` header against `connection.webhookSecret`
- Handle `issues` event with action `opened` only
- Filter by `allowedAuthors`
- Call `syncIssue()`

### Manual Import

```
POST /projects/:slug/vcs/sync/:issueNumber
```

- Requires Bearer auth
- Fetches single issue via `provider.fetchIssue(issueNumber)`
- Calls `syncIssue()` — does NOT filter by `allowedAuthors`
- Returns created ticket or `409` if already synced

### API Endpoints

| Method | Path | Auth | Purpose |
|:-------|:-----|:-----|:--------|
| `POST` | `/projects/:slug/vcs` | Bearer | Create VCS connection |
| `GET` | `/projects/:slug/vcs` | Bearer | Get VCS connection (token masked) |
| `PATCH` | `/projects/:slug/vcs` | Bearer | Update connection settings |
| `DELETE` | `/projects/:slug/vcs` | Bearer | Remove connection + stop polling |
| `POST` | `/projects/:slug/vcs/test` | Bearer | Test connection (validate token + repo access) |
| `POST` | `/projects/:slug/vcs/sync` | Bearer | Trigger full manual sync (respects author filter) |
| `POST` | `/projects/:slug/vcs/sync/:issueNumber` | Bearer | Import single issue (bypasses author filter) |
| `POST` | `/projects/:slug/vcs-webhook` | Public | Inbound GitHub webhook receiver |

### DTOs

```typescript
export class CreateVcsConnectionDto {
  provider: 'github';           // only github in Phase 1
  repoOwner: string;
  repoName: string;
  token: string;                // plaintext — encrypted before storage
  syncMode: 'off' | 'polling' | 'webhook';
  allowedAuthors?: string[];    // GitHub usernames; defaults to []
  pollingIntervalMs?: number;   // defaults to 600000
}

export class UpdateVcsConnectionDto {
  token?: string;
  syncMode?: 'off' | 'polling' | 'webhook';
  allowedAuthors?: string[];
  pollingIntervalMs?: number;
}

export class VcsConnectionResponseDto {
  id: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  syncMode: string;
  allowedAuthors: string[];
  pollingIntervalMs: number;
  lastSyncedAt: string | null;
  isActive: boolean;
  createdAt: string;
  // NOTE: token is NEVER returned
}

export class SyncResultDto {
  syncType: string;
  issuesSynced: number;
  issuesSkipped: number;
  tickets: Array<{ ref: string; title: string }>;
}

export class TestConnectionResultDto {
  ok: boolean;
  error?: string;
}
```

### Config

```typescript
// src/vcs/vcs.config.ts
export const vcsConfig = registerAs('vcs', () => ({
  encryptionKey: process.env['VCS_ENCRYPTION_KEY'],
  defaultPollingIntervalMs: parseInt(
    process.env['VCS_DEFAULT_POLLING_INTERVAL_MS'] ?? '600000', 10,
  ),
  githubApiUrl: process.env['GITHUB_API_URL'] ?? 'https://api.github.com',
}));
```

Add `VCS_ENCRYPTION_KEY` to env validation — required when any VCS connection exists, optional otherwise (lazy validation on first connection creation).

### CLI Commands

```bash
koda vcs connect --provider github --owner <owner> --repo <repo> --token <pat> --sync-mode polling
koda vcs status                  # show connection config + last sync
koda vcs update --sync-mode webhook --authors user1,user2
koda vcs disconnect
koda vcs test                    # test connection
koda vcs sync                    # trigger full sync
koda vcs import <issue-number>   # import single issue
```

#### CLI Behavior

- Exit 0: command succeeded
- Exit 1: API error (connection failed, server error)
- Exit 2: auth/config error (missing API key, no project context)
- Exit 3: validation error (bad input)
- stdout: result (human-readable by default, JSON with `--json`)
- stderr: errors and warnings

### Web UI

**New page:** `/[project]/settings` with a "VCS Integration" tab.

- Connection form: provider selector (GitHub only for now), repo owner, repo name, token (password field), sync mode radio (off/polling/webhook), polling interval input, allowed authors tag input
- "Test Connection" button that calls `POST .../vcs/test`
- Connection status card: provider, repo, sync mode, last synced time, error indicator
- "Sync Now" button that calls `POST .../vcs/sync`

**Ticket board/detail enhancements:**

- GitHub icon badge on ticket cards synced from VCS (show issue number)
- Ticket detail: "Synced from GitHub #42" link when `externalVcsUrl` is present
- "Import Issue" button/dialog on board page: input issue number, calls `POST .../vcs/sync/:issueNumber`

**Sidebar navigation:** Add "Settings" link under project pages (below KB).

### i18n

New files: `apps/api/src/i18n/{en,zh}/vcs.json` and new keys in `apps/web/i18n/locales/{en,zh}.json`.

### Failure Handling

- **Polling fetch fails** (network error, 401, rate limit): log error, write `VcsSyncLog` with `errorMessage`, do not update `lastSyncedAt`, retry on next interval
- **Webhook signature invalid**: return `401`, do not process
- **Webhook event for unsupported action** (e.g. `issues.closed`): return `200` with `{ ignored: true }`, do not process
- **Manual import for non-existent issue**: return `404` from API
- **Token decryption fails** (corrupted data, wrong key): log error, mark connection as inactive, return `500` on sync attempts
- **GitHub rate limit**: log warning in sync log, retry on next polling interval
- **Provider factory given unsupported provider**: throw `ValidationAppException`

### Module Structure

```
apps/api/src/vcs/
├── vcs.module.ts
├── vcs.controller.ts
├── vcs-webhook.controller.ts
├── vcs.service.ts
├── vcs-sync.service.ts
├── vcs-connection.service.ts
├── vcs.config.ts
├── providers/
│   ├── vcs-provider.interface.ts
│   ├── github.provider.ts
│   └── index.ts
├── dto/
│   ├── create-vcs-connection.dto.ts
│   ├── update-vcs-connection.dto.ts
│   ├── vcs-connection-response.dto.ts
│   ├── sync-result.dto.ts
│   └── test-connection-result.dto.ts
└── utils/
    └── token-crypto.util.ts
```

---

## Stories

| ID | Title | Complexity | Depends On |
|:---|:------|:-----------|:-----------|
| VCS-P1-001 | Prisma schema + token encryption utility + VCS config | Medium | — |
| VCS-P1-002 | Provider interface + GitHub provider | Medium | VCS-P1-001 |
| VCS-P1-003 | VCS connection CRUD (API + service + DTOs) | Medium | VCS-P1-001 |
| VCS-P1-004 | Issue sync core + polling + webhook + manual import (API) | Complex | VCS-P1-002, VCS-P1-003 |
| VCS-P1-005 | CLI `vcs` commands + Web settings page + ticket VCS badges | Complex | VCS-P1-004 |

---

## Acceptance Criteria

### VCS-P1-001 — Schema + Encryption + Config

- `VcsConnection` model exists in `schema.prisma` with fields `id`, `projectId` (unique), `provider`, `repoOwner`, `repoName`, `encryptedToken`, `syncMode`, `allowedAuthors`, `pollingIntervalMs`, `webhookSecret`, `lastSyncedAt`, `isActive`, `createdAt`, `updatedAt`
- `VcsSyncLog` model exists with fields `id`, `vcsConnectionId`, `syncType`, `issuesSynced`, `issuesSkipped`, `errorMessage`, `startedAt`, `completedAt`
- `Ticket` model has new nullable fields `externalVcsId`, `externalVcsUrl`, `vcsSyncedAt`
- `Project` model has a `vcsConnection` relation (one-to-one, optional)
- `encryptToken('my-secret-token', key)` returns a string in `iv:authTag:ciphertext` hex format
- `decryptToken(encryptToken('my-secret-token', key), key)` returns `'my-secret-token'`
- `decryptToken` throws when given a tampered ciphertext (GCM integrity check)
- `decryptToken` throws when given a different master key than was used to encrypt
- `vcsConfig` registers with namespace `'vcs'` and reads `VCS_ENCRYPTION_KEY`, `VCS_DEFAULT_POLLING_INTERVAL_MS`, `GITHUB_API_URL` from env

### Context Files
- `apps/api/prisma/schema.prisma` — existing models (Ticket, Project, Webhook) to follow
- `apps/api/src/config/auth.config.ts` — existing `registerAs` config pattern
- `apps/api/src/config/env.validation.ts` — env validation schema to extend
- `apps/api/src/auth/agents.service.ts` — existing HMAC crypto pattern for reference

### VCS-P1-002 — Provider Interface + GitHub Provider

- `IVcsProvider` interface exports `fetchIssues(since?)`, `fetchIssue(number)`, and `testConnection()` methods
- `GitHubProvider.fetchIssues()` calls `GET /repos/{owner}/{repo}/issues` with `state=open`, `sort=created`, `direction=asc`
- `GitHubProvider.fetchIssues(since)` passes `since` as ISO 8601 query parameter to filter by creation date
- `GitHubProvider.fetchIssues()` filters out pull requests (GitHub API returns PRs in the issues endpoint — skip entries where `pull_request` key is present)
- `GitHubProvider.fetchIssue(42)` calls `GET /repos/{owner}/{repo}/issues/42` and returns a `VcsIssue`
- `GitHubProvider.fetchIssue(99999)` throws `NotFoundAppException` when GitHub returns 404
- `GitHubProvider.testConnection()` returns `{ ok: true }` when the token has read access to the repo
- `GitHubProvider.testConnection()` returns `{ ok: false, error: '...' }` when the token is invalid or repo not found
- `createVcsProvider('github', config)` returns a `GitHubProvider` instance
- `createVcsProvider('gitlab', config)` throws `ValidationAppException` with message indicating GitLab is not yet supported

### Context Files
- `apps/api/src/vcs/providers/vcs-provider.interface.ts` — interface to implement (to be created in VCS-P1-001)
- `apps/api/src/ci-webhook/ci-webhook.service.ts` — existing external API integration pattern
- `apps/api/src/common/utils/git-url.util.ts` — existing GitHub/GitLab URL handling

### VCS-P1-003 — VCS Connection CRUD

- `POST /projects/:slug/vcs` with valid `CreateVcsConnectionDto` returns `201` with `VcsConnectionResponseDto` (token not included in response)
- `POST /projects/:slug/vcs` stores the token encrypted via AES-256-GCM (raw token is not in the database)
- `POST /projects/:slug/vcs` when project already has a connection returns `409`
- `POST /projects/:slug/vcs` with unknown project slug returns `404`
- `GET /projects/:slug/vcs` returns `VcsConnectionResponseDto` with all fields except token
- `GET /projects/:slug/vcs` when no connection exists returns `404`
- `PATCH /projects/:slug/vcs` with `{ syncMode: 'polling' }` updates sync mode and returns updated `VcsConnectionResponseDto`
- `PATCH /projects/:slug/vcs` with `{ token: 'new-token' }` re-encrypts and stores the new token
- `DELETE /projects/:slug/vcs` returns `204` and removes the connection
- `DELETE /projects/:slug/vcs` when no connection exists returns `404`
- `POST /projects/:slug/vcs/test` decrypts the stored token and calls `provider.testConnection()`, returns `TestConnectionResultDto`

### Context Files
- `apps/api/src/webhook/webhook.controller.ts` — existing CRUD controller pattern
- `apps/api/src/webhook/webhook.service.ts` — existing service with Prisma access
- `apps/api/src/tickets/tickets.controller.ts` — `@ApiTags`, `@ApiBearerAuth`, `JsonResponse` pattern
- `apps/api/src/common/enums.ts` — enum constant pattern (add VcsProvider, VcsSyncMode)

### VCS-P1-004 — Issue Sync Core + Polling + Webhook + Manual

- `vcsService.syncIssue()` creates a ticket with `type = 'TASK'`, `status = 'CREATED'`, `priority = 'MEDIUM'` when the issue does not already exist in the project
- `vcsService.syncIssue()` returns `{ action: 'skipped' }` when a ticket with matching `externalVcsId` already exists in the project
- `vcsService.syncIssue()` sets `externalVcsId`, `externalVcsUrl`, and `vcsSyncedAt` on the created ticket
- `vcsService.syncIssue()` allocates ticket number via `MAX(number)+1` in a Prisma transaction (same pattern as existing ticket creation)
- Polling service registers an interval via `SchedulerRegistry` for each connection with `syncMode = 'polling'` on module init
- Polling service filters issues by `allowedAuthors` before calling `syncIssue()`
- Polling service updates `connection.lastSyncedAt` after a successful sync run
- Polling service writes a `VcsSyncLog` entry with `issuesSynced` and `issuesSkipped` counts after each run
- When polling fetch fails, `VcsSyncLog` is written with `errorMessage` and `lastSyncedAt` is not updated
- `POST /projects/:slug/vcs-webhook` with valid `X-Hub-Signature-256` and `issues.opened` event creates a ticket via `syncIssue()`
- `POST /projects/:slug/vcs-webhook` with invalid signature returns `401`
- `POST /projects/:slug/vcs-webhook` with `issues.closed` event returns `200` with `{ ignored: true }`
- `POST /projects/:slug/vcs-webhook` filters by `allowedAuthors` — issues from non-allowed authors return `200` with `{ ignored: true }`
- `POST /projects/:slug/vcs/sync` triggers a full sync run for the project and returns `SyncResultDto`
- `POST /projects/:slug/vcs/sync/42` fetches issue #42 and creates a ticket regardless of `allowedAuthors`
- `POST /projects/:slug/vcs/sync/42` returns `409` when issue #42 is already synced

### Context Files
- `apps/api/src/ci-webhook/ci-webhook.controller.ts` — inbound webhook controller pattern (`@Public()`)
- `apps/api/src/ci-webhook/ci-webhook.service.ts` — ticket creation from external event (number allocation transaction)
- `apps/api/src/rag/strategies/cron-optimize.strategy.ts` — `SchedulerRegistry` interval registration pattern
- `apps/api/src/webhook/webhook-dispatcher.service.ts` — HMAC signature pattern
- `apps/api/src/tickets/tickets.service.ts` — ticket creation with number allocation

### VCS-P1-005 — CLI Commands + Web UI

- `koda vcs connect --provider github --owner o --repo r --token t --sync-mode polling` calls `POST /projects/:slug/vcs` and prints connection info
- `koda vcs connect` with `--json` flag prints raw `VcsConnectionResponseDto` JSON
- `koda vcs status` calls `GET /projects/:slug/vcs` and prints connection config and last sync time
- `koda vcs status` when no connection exists prints `"No VCS connection configured"` and exits 1
- `koda vcs update --sync-mode webhook --authors user1,user2` calls `PATCH /projects/:slug/vcs`
- `koda vcs disconnect` calls `DELETE /projects/:slug/vcs` and prints confirmation
- `koda vcs test` calls `POST /projects/:slug/vcs/test` and prints `"Connection OK"` or error message
- `koda vcs sync` calls `POST /projects/:slug/vcs/sync` and prints `SyncResultDto` summary
- `koda vcs import 42` calls `POST /projects/:slug/vcs/sync/42` and prints created ticket ref
- Web settings page at `/[project]/settings` renders a "VCS Integration" tab with connection form
- Web settings page "Test Connection" button calls `POST .../vcs/test` and shows success/error toast
- Web settings page "Sync Now" button calls `POST .../vcs/sync` and shows sync result toast
- Web ticket cards on the board show a GitHub icon with issue number when `externalVcsUrl` is present
- Web ticket detail page shows `"Synced from GitHub #42"` link when `externalVcsUrl` is present
- Web board page has an "Import Issue" dialog that accepts an issue number and calls `POST .../vcs/sync/:issueNumber`
- Sidebar navigation includes a "Settings" link for project pages
- i18n keys exist in both `en` and `zh` for all VCS-related strings in API and web

### Context Files
- `apps/cli/src/commands/ticket.ts` — existing command structure pattern
- `apps/cli/src/utils/output.ts` — `table()`, `success()`, `error()` output helpers
- `apps/cli/src/config.ts` — `resolveContext()` for project slug resolution
- `apps/cli/src/generated/` — regenerate after API changes (`bun run generate`)
- `apps/web/pages/[project]/labels.vue` — existing project subpage pattern
- `apps/web/components/CreateTicketDialog.vue` — dialog component pattern
- `apps/web/composables/useApi.ts` — `$api.get()`, `$api.post()` pattern
- `apps/web/components/TicketCard.vue` — ticket card component to extend with VCS badge
- `apps/web/pages/[project]/tickets/[ref].vue` — ticket detail page to extend
- `apps/web/i18n/locales/en.json` — existing i18n key structure
- `apps/web/layouts/default.vue` — sidebar navigation to extend
