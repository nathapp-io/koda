# Phase 3 — CLI Refactor to Match Phase 2R API

**Branch:** `feat/refactor-cli-standard`  
**Working directory:** `apps/cli`  
**Created:** 2026-03-21  
**Status:** 🟡 Ready to implement  
**Depends on:** Phase 2R ✅ (`feat/refactor-standard`, commit `24c44d9`)

---

## Context

The CLI (`apps/cli`) was written against the **pre-Phase 2R** API. Phase 2R changed:

1. All API responses are now wrapped in `JsonResponse.Ok({ ret: 0, data: T })`.
2. Auth uses `@nathapp/nestjs-auth` JWT-based flow.
3. Enum values are uppercase (`BUG`, not `bug`; `GENERAL`, not `general`).
4. Ticket `ref` field (`KODA-1`) is now returned in the create response.
5. `CreateProjectDto` now requires a `key` field (`^[A-Z]{2,6}$`).
6. `CREATED → IN_PROGRESS` is a valid `start` transition (not only `VERIFIED → IN_PROGRESS`).
7. `ticket fix` and `ticket verify` transitions require a `body` comment string.
8. Comment DELETE returns `200` + `JsonResponse.Ok` (was `204 No Content`).
9. OpenAPI spec was regenerated after Phase 2R changes — `src/generated/` is stale.

The CLI also has several **missing commands** that now have API coverage.

---

## Architecture Constraints

1. **Generated client only** — never write raw `axios.get('/api/...')` calls manually.
2. **Regenerate before any work** — run `bun run generate` from monorepo root first.
3. **`--json` flag is mandatory** on all data-returning commands.
4. **Exit codes must be correct** — `0` success, `1` API error, `2` config/auth, `3` validation.
5. **Auth resolution** — `--api-key` flag → `KODA_API_KEY` env → `~/.koda/config.json`.
6. **No business logic in CLI** — all validation lives in the API; CLI validates only presence of required flags.
7. **Test coverage ≥ 80%** on all modified/new command files.

---

## US-301 — Regenerate OpenAPI client

### Problem

`src/generated/` was last generated before Phase 2R. The response types are wrong (missing `JsonResponse` wrapper). All commands are broken at runtime because `response.data` is `{ ret: 0, data: T }` but commands treat it as `T` directly.

### Tasks

- [ ] From monorepo root, run: `bun run generate`  
  This runs `api:export-spec` → `generate:cli` → generates `src/generated/`
- [ ] Verify `src/generated/types.gen.ts` now has correct response types reflecting `JsonResponse` wrapper
- [ ] Check that `services.gen.ts` exports match new API endpoints and operation names

### Notes

- If `api:export-spec` fails (requires running API), export the spec manually:
  ```bash
  cd apps/api && bun run build && node scripts/export-spec.cjs
  # outputs openapi.json at monorepo root
  ```
- After regeneration, ALL existing commands will have TypeScript errors due to type changes — expected and fixed in subsequent user stories.

### Acceptance Criteria

- `src/generated/` reflects Phase 2R API surface (all new endpoints, correct types).
- `bun run type-check` passes in `apps/cli`.

---

## US-302 — Fix response unwrapping in all commands

### Problem

All API responses are now `{ ret: number, data: T }` (via `JsonResponse.Ok`). The current commands access `response.data` as if it's the payload directly. After regeneration, the correct payload is at `response.data.data`.

### Tasks

- [ ] Add helper `unwrap<T>(response: { data: { ret: number; data: T } }): T` in `utils/output.ts` (or a new `utils/api.ts`)
  ```typescript
  export function unwrap<T>(response: { data: { ret: number; data: T } }): T {
    return response.data.data;
  }
  ```
- [ ] Update all commands to use `unwrap(response)` instead of `response.data`:

  | File | Lines to update |
  |:-----|:----------------|
  | `commands/project.ts` | `ProjectsService.list` → `ProjectsService.show` responses |
  | `commands/ticket.ts` | All `TicketsService.*` responses |
  | `commands/comment.ts` | `CommentsService.add` response |
  | `commands/agent.ts` | All `AgentsService.*` responses |
  | `commands/login.ts` | Validation call response (if using `/agents/me`) |

- [ ] For `--json` output: serialize the unwrapped payload (not the wrapper):
  ```typescript
  // Before:
  console.log(JSON.stringify(response.data, null, 2));
  // After:
  const data = unwrap(response);
  console.log(JSON.stringify(data, null, 2));
  ```

### Acceptance Criteria

- `koda project list --json` returns array of projects (not `{ ret: 0, data: [...] }`).
- `koda ticket show KODA-1 --json` returns the ticket object directly.
- All commands pass `bun run test`.

---

## US-303 — Fix enum value casing

### Problem

The CLI documents and passes lowercase enum values (e.g., `--type bug`, `--comment-type general`) but the API expects uppercase (`BUG`, `GENERAL`). This causes 400 validation errors at runtime.

### Tasks

- [ ] **`ticket create --type`**: change valid values from `bug|enhancement` to `BUG|ENHANCEMENT|TASK|QUESTION`
  ```
  .option('--type <type>', 'Ticket type (BUG|ENHANCEMENT|TASK|QUESTION)')
  ```
- [ ] **`ticket create --priority`**: change valid values from `low|medium|high|critical` to `LOW|MEDIUM|HIGH|CRITICAL`
- [ ] **`comment add --type`**: change valid values from `general|verification|fix_report|review` to `GENERAL|VERIFICATION|FIX_REPORT|REVIEW`
- [ ] **`ticket fix`**: change hardcoded `type: 'fix_report'` payload to `type: 'FIX_REPORT'`
- [ ] **`ticket verify`**: change hardcoded `type: 'verification'` to `type: 'VERIFICATION'`
- [ ] **`ticket reject`**: change hardcoded `type: 'general'` to `type: 'GENERAL'`
- [ ] **`ticket verify-fix`**: change hardcoded `type: 'review'` to `type: 'REVIEW'`
- [ ] Add client-side validation for enum values in CLI with clear error message:
  ```
  Invalid type: 'bug'. Valid values: BUG, ENHANCEMENT, TASK, QUESTION
  ```

### Acceptance Criteria

- `koda ticket create --project koda --type BUG --title "Test"` creates successfully.
- `koda comment add KODA-1 --body "..." --type GENERAL` creates successfully.
- Passing an invalid lowercase value produces a clear error (exit 3).

---

## US-304 — Fix `project create` command (missing)

### Problem

`apps/cli/src/commands/project.ts` only has `list` and `show`. `POST /api/projects` exists and requires `name`, `slug`, and `key`.

### Tasks

- [ ] Add `project create` command:
  ```
  koda project create --name <name> --slug <slug> --key <key> [--desc <desc>] [--git-url <url>] [--json]
  ```
  - `--key`: 2–6 uppercase letters (e.g., `KODA`). Validate format client-side.
  - `--slug`: lowercase alphanumeric with hyphens. Validate format client-side.
  - Call `ProjectsService.create` from generated client.

- [ ] Add `project delete <slug>` command:
  ```
  koda project delete <slug> [--confirm]
  ```
  - Require `--confirm` flag or prompt before delete (destructive action).
  - Call `ProjectsService.remove`.

- [ ] Update `project show` table output to include `description` and `gitRemoteUrl` if present.

### Acceptance Criteria

- `koda project create --name "My Project" --slug my-project --key MYPR` creates project.
- `koda project delete my-project --confirm` deletes the project.
- Invalid `--key` format (e.g., `my-key`) exits with code 3 and a useful error.

---

## US-305 — Fix `ticket` command gaps

### Problem

Several ticket operations exist in the API but are missing or broken in the CLI.

### Tasks

- [ ] **`ticket update <ref>`** (new):
  ```
  koda ticket update <ref> [--title <t>] [--desc <d>] [--priority <p>] [--json]
  ```
  Calls `PATCH /api/projects/:slug/tickets/:ref`. Requires `--project <slug>` since the API path includes the project slug.
  > **Note:** The CLI needs to resolve the project slug from the ref. Options:
  > - Require `--project <slug>` flag explicitly, OR
  > - Call `GET /api/projects/:slug/tickets/:ref` with `ref` parsed (e.g., `KODA-1`) and use the returned `projectId` to resolve slug via a second call. The simpler approach is `--project <slug>` required.

- [ ] **`ticket delete <ref>`** (new):
  ```
  koda ticket delete <ref> --project <slug> [--confirm]
  ```
  Soft-delete via `DELETE /api/projects/:slug/tickets/:ref`.

- [ ] **`ticket show <ref>`**: Update to use `ticket.ref` instead of `KODA-${ticket.number}`:
  ```typescript
  // Before:
  console.log(`Reference: KODA-${ticket.number}`);
  // After:
  console.log(`Reference: ${ticket.ref}`);
  ```

- [ ] **`ticket start`**: Update description: `CREATED or VERIFIED → IN_PROGRESS` (not only `VERIFIED → IN_PROGRESS`).

- [ ] **`ticket fix` + `ticket verify`**: Add `--comment <text>` body to the request payload (already required by `TransitionWithCommentDto`):
  - `fix`: sends `{ body: options.comment }` to `/tickets/:ref/fix`
  - `verify` (the end-state review): the CLI currently has two verify-like commands (`verify` and `verify-fix`). Clarify:
    - `ticket verify <ref> --comment "..."` → `POST /tickets/:ref/verify` (CREATED → VERIFIED)
    - `ticket fix <ref> --comment "..."` → `POST /tickets/:ref/fix` (IN_PROGRESS → VERIFY_FIX)
    - `ticket verify-fix <ref> --comment "..." [--pass|--fail]` → resolved by API's `close`/`reject` transitions

- [ ] **`ticket verify` body requirement**: The `/verify` endpoint in the transition controller requires a body comment. Add `--comment` as required for `ticket verify`:
  ```typescript
  .requiredOption('--comment <text>', 'Verification comment')
  ```
  Send as `{ body: options.comment }`.

### Acceptance Criteria

- `koda ticket update KODA-1 --project koda --title "New title"` updates title.
- `koda ticket show KODA-1` displays `Reference: KODA-1` (from `ticket.ref`).
- `koda ticket start KODA-1` works from both `CREATED` and `VERIFIED` status.
- `koda ticket fix KODA-1 --comment "Fixed in v1.2"` succeeds.

---

## US-306 — Add label commands (new)

### Problem

The API has full label CRUD and ticket label assignment, but the CLI has no label commands.

### Tasks

- [ ] Add `koda label` command group in new file `commands/label.ts`:

  ```
  koda label create --project <slug> --name <name> [--color <hex>] [--json]
  koda label list --project <slug> [--json]
  koda label delete --project <slug> --id <labelId>
  ```

- [ ] Add label sub-commands under `ticket`:

  ```
  koda ticket label add <ref> --project <slug> --label <labelId> [--json]
  koda ticket label remove <ref> --project <slug> --label <labelId>
  ```

- [ ] Register `labelCommand` in `index.ts`.

### Acceptance Criteria

- `koda label create --project koda --name "Bug" --color "#FF0000"` creates label.
- `koda label list --project koda --json` returns array of labels.
- `koda ticket label add KODA-1 --project koda --label <id>` assigns label to ticket.

---

## US-307 — Refactor error handling utility

### Problem

Every command repeats the same error-handling boilerplate:

```typescript
const apiError = err as { response?: { status?: number }; message?: string };
const statusCode = apiError.response?.status;
if (statusCode === 401 || statusCode === 403) { ... }
```

`utils/error.ts` exists but is not used by commands.

### Tasks

- [ ] Update `utils/error.ts` to export `handleApiError(err: unknown): never`:
  ```typescript
  export function handleApiError(err: unknown): never {
    const apiError = err as { response?: { status?: number; data?: { message?: string } }; message?: string };
    const statusCode = apiError.response?.status;
    const message = apiError.response?.data?.message || apiError.message;

    if (statusCode === 401 || statusCode === 403) {
      error('Unauthorized. Please check your API key or login again.');
      process.exit(2);
    }
    if (statusCode === 404) {
      error(`Not found: ${message || 'resource not found'}`);
      process.exit(1);
    }
    if (statusCode === 400) {
      error(`Bad request: ${message || 'validation error'}`);
      process.exit(3);
    }
    error(message || 'Unexpected error');
    process.exit(1);
  }
  ```

- [ ] Replace all inline `catch` blocks in `project.ts`, `ticket.ts`, `comment.ts`, `agent.ts` with `handleApiError(err)`.
- [ ] Keep the `404` special case messages per-command (pass `resourceName` to `handleApiError`):
  ```typescript
  } catch (err) {
    handleApiError(err, { notFoundMessage: `Ticket not found: ${ref}` });
  }
  ```

### Acceptance Criteria

- All commands use `handleApiError` in their catch blocks.
- Error messages remain as clear as before.
- Error handling code duplication reduced by ≥ 50%.

---

## US-308 — Update CLAUDE.md

### Tasks

- [ ] Update command reference table with new commands (project create/delete, ticket update/delete, label commands).
- [ ] Fix enum value documentation: `BUG|ENHANCEMENT|TASK|QUESTION`, `LOW|MEDIUM|HIGH|CRITICAL`, `GENERAL|VERIFICATION|FIX_REPORT|REVIEW`.
- [ ] Update `koda ticket start` description: `CREATED or VERIFIED → IN_PROGRESS`.
- [ ] Add section on response unwrapping pattern.
- [ ] Add `bun run generate` to "Commands" section, with note: run from monorepo root after any API change.

---

## Implementation Order

```
US-301 → US-302 → US-303 → US-307 → US-304 → US-305 → US-306 → US-308
```

**Rationale:** Regenerate first (US-301) so types are correct. Fix response unwrapping (US-302) so all commands work. Fix enum casing (US-303) so commands send valid data. Refactor error handling (US-307) before adding new commands. Then add missing commands (US-304, US-305, US-306). Document last (US-308).

---

## Testing Strategy

- Each command file has a corresponding `*.spec.ts` with unit tests using mocked generated client.
- Run: `cd apps/cli && bun run test` (Jest, not `bun test`).
- Coverage target: ≥ 80% per modified file.
- End-to-end validation: run smoke test after implementation with the dev server running:
  ```bash
  # Start server
  cd apps/api && bun run dev
  # Run CLI manually against real server
  koda login --api-key <agent-key>
  koda project list
  koda ticket create --project koda --type BUG --title "Test ticket"
  ```

---

## File Changeset Summary

| File | Action | US |
|:-----|:-------|:---|
| `src/generated/` | Regenerated | US-301 |
| `src/utils/api.ts` | New (`unwrap` helper) | US-302 |
| `src/utils/error.ts` | Updated (`handleApiError`) | US-307 |
| `src/commands/project.ts` | Updated (unwrap, add create/delete) | US-302, US-304 |
| `src/commands/ticket.ts` | Updated (unwrap, enum casing, update/delete, fixes) | US-302, US-303, US-305 |
| `src/commands/comment.ts` | Updated (unwrap, enum casing) | US-302, US-303 |
| `src/commands/agent.ts` | Updated (unwrap) | US-302 |
| `src/commands/label.ts` | New (label CRUD, ticket label assign/remove) | US-306 |
| `src/index.ts` | Register `labelCommand` | US-306 |
| `CLAUDE.md` | Updated (commands, enums, generate script) | US-308 |
| All `*.spec.ts` | Updated for new shapes and new commands | All |

---

## Key Decisions

1. **`unwrap()` utility over generated wrapper** — simpler than fighting with `@hey-api` config to auto-unwrap; explicit is better.
2. **`--project <slug>` required for ticket update/delete** — avoids an extra API call to resolve project from ref; agents always know the project context.
3. **No token refresh in CLI** — CLI uses API key auth (agent-scoped), not JWT. JWT refresh is irrelevant here. If a user-facing JWT login is needed in future, it's Phase 4.
4. **Uppercase enum values in CLI** — match API exactly; no client-side lowercasing or mapping. "GIGO" principle — wrong input gets a clear error.
