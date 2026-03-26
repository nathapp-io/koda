# SPEC: Project-Level CLI Config

## Summary

Add `koda init` and project-level `.koda/config.json` so CLI commands auto-detect project context without requiring `--project <slug>` on every invocation. The CLI walks up from `cwd` to find `.koda/config.json`, merges it with the global `~/.config/koda/config.json`, and injects `projectSlug` and `apiUrl` automatically. A `koda config profile` sub-command manages named auth profiles for multi-environment support.

## Motivation

Every CLI command today requires `--project <slug>`. This is repetitive, error-prone for agents, and breaks muscle memory for humans. There is no way to scope a working directory to a project. Multi-environment workflows (local / staging / production) have no first-class support — users must re-login or manually swap config files.

**Before:**
```bash
koda ticket list --project koda
koda ticket create --project koda --title "fix auth"
koda ticket link KDA-42 --url https://github.com/... --project koda
```

**After (from any subdirectory of the project):**
```bash
koda ticket list
koda ticket create --title "fix auth"
koda ticket link KDA-42 --url https://github.com/...
```

## Design

### Config Files

**Project-level** — `.koda/config.json` (git-tracked, no secrets)
```json
{
  "projectSlug": "koda",
  "apiUrl": "https://custom-instance/api",
  "profile": "staging",
  "defaults": {
    "type": "TASK",
    "priority": "MEDIUM"
  }
}
```

**Global** — `~/.config/koda/config.json` (managed by `koda login` / `koda config`)
```json
{
  "apiUrl": "http://localhost:3100/api",
  "apiKey": "sk-xxxx",
  "profiles": {
    "staging": {
      "apiUrl": "https://staging.koda.io/api",
      "apiKey": "stg-xxxx"
    }
  }
}
```

### Resolution Priority (highest wins)

```
CLI flags  >  .koda/config.json  >  active profile  >  global config  >  defaults
```

1. CLI walks up from `cwd` until it finds `.koda/config.json` or hits filesystem root.
2. `projectSlug` from `.koda/config.json` is used when `--project` is not passed.
3. If `.koda/config.json` has `"profile": "<name>"`, that profile's `apiUrl`+`apiKey` override the global defaults.
4. CLI flags (`--project`, `--api-url`) always win.

### TypeScript Interfaces

```ts
// src/config.ts additions

export interface ProjectConfig {
  projectSlug?: string;
  apiUrl?: string;
  profile?: string;
  defaults?: {
    type?: string;
    priority?: string;
  };
}

export interface Profile {
  apiUrl: string;
  apiKey: string;
}

// Walk up from dir, return ProjectConfig or null
export function findProjectConfig(dir?: string): ProjectConfig | null;

// Merge resolution: flags > .koda/ > profile > global > defaults
export function resolveContext(flags: Partial<ResolvedContext>): ResolvedContext;

export interface ResolvedContext {
  projectSlug: string;
  apiUrl: string;
  apiKey: string;
}
```

### `koda init` UX

```bash
# Interactive (lists projects from API, arrow-key select)
koda init

# Non-interactive
koda init --project koda

# With defaults
koda init --project koda --default-type BUG --default-priority HIGH

# Output
✓ Created .koda/config.json
  projectSlug: koda
  apiUrl: http://localhost:3100/api
```

`.koda/config.json` is **always git-tracked**. The command prints a reminder that it must not contain tokens.

### `koda config profile` UX

```bash
koda config profile list
koda config profile add staging --api-url https://staging.koda.io/api --api-key stg-xxx
koda config profile remove staging
```

---

## Stories

### CLI-001: `findProjectConfig` walk-up utility
**No dependencies**

Implement `findProjectConfig(dir?)` in `src/config.ts`.
Walks up from `dir` (defaults to `process.cwd()`) looking for `.koda/config.json`. Returns parsed `ProjectConfig` or `null` if not found.

#### Context Files
- `apps/cli/src/config.ts` — existing config module; add `findProjectConfig` here
- `apps/cli/src/utils/` — existing utility patterns

#### Acceptance Criteria
- `findProjectConfig('/a/b/c')` returns `ProjectConfig` when `.koda/config.json` exists at `/a/b/c/.koda/config.json`
- `findProjectConfig('/a/b/c')` returns `ProjectConfig` when `.koda/config.json` exists at `/a/.koda/config.json` (walk-up finds ancestor)
- `findProjectConfig('/a/b/c')` returns `null` when no `.koda/config.json` exists anywhere up to filesystem root
- `findProjectConfig()` defaults `dir` to `process.cwd()` when called with no argument
- `findProjectConfig` returns `null` and does not throw when `.koda/config.json` exists but contains invalid JSON

---

### CLI-002: `resolveContext` merge logic
**Depends on CLI-001**

Implement `resolveContext(flags)` in `src/config.ts`. Merges flags, project config, active profile, and global config according to resolution priority.

#### Context Files
- `apps/cli/src/config.ts` — extend with `resolveContext`
- `apps/cli/src/commands/ticket.ts` — example consumer (`resolveAuth` pattern to replace)

#### Acceptance Criteria
- `resolveContext({ projectSlug: 'override' })` returns `projectSlug: 'override'` even when `.koda/config.json` has a different `projectSlug`
- `resolveContext({})` returns `projectSlug` from `.koda/config.json` when no flag is passed and project config exists
- `resolveContext({})` returns `apiUrl` and `apiKey` from the named profile when `.koda/config.json` has `"profile": "staging"` and that profile exists in global config
- `resolveContext({})` returns `apiUrl` from `.koda/config.json` when it overrides the global `apiUrl` and no CLI flag is passed
- `resolveContext({})` returns `apiKey` from global config when `.koda/config.json` has no `profile` field
- `resolveContext({})` returns `apiUrl: 'http://localhost:3100/api'` and `apiKey: ''` when no config files exist (pure defaults)

---

### CLI-003: Wire `resolveContext` into all commands
**Depends on CLI-002**

Replace `const projectSlug = options.project || process.env['GLOBAL_PROJECT_SLUG'] || 'koda'` with `resolveContext(options).projectSlug` in all commands that accept `--project`. Remove the `GLOBAL_PROJECT_SLUG` env var fallback.

#### Context Files
- `apps/cli/src/commands/ticket.ts` — primary consumer; contains most occurrences
- `apps/cli/src/commands/comment.ts`
- `apps/cli/src/commands/label.ts`
- `apps/cli/src/commands/kb.ts`
- `apps/cli/src/commands/agent.ts`

#### Acceptance Criteria
- When `.koda/config.json` has `projectSlug: "koda"` and `koda ticket list` is run without `--project`, the API call uses `projectSlug: "koda"`
- When `--project foo` is passed explicitly, the API call uses `projectSlug: "foo"` regardless of what `.koda/config.json` contains
- When no `.koda/config.json` exists and no `--project` flag is passed, `koda ticket list` exits with code `2` and prints `"Project not configured. Run: koda init"`
- `GLOBAL_PROJECT_SLUG` env var is no longer used as a fallback (removed from codebase)

---

### CLI-004: `koda init` command
**Depends on CLI-002**

Implement `koda init` command in `src/commands/init.ts`. Fetches projects from API, allows selection, writes `.koda/config.json`.

#### Context Files
- `apps/cli/src/commands/ticket.ts` — existing command pattern (action, error handling, API calls)
- `apps/cli/src/commands/login.ts` — credential-requiring command pattern
- `apps/cli/src/config.ts` — `findProjectConfig`, `resolveContext`

#### Acceptance Criteria
- `koda init --project koda` creates `.koda/config.json` with `{ "projectSlug": "koda" }` in the current directory without prompting
- `koda init --project koda` exits with code `0` and prints `✓ Created .koda/config.json`
- `koda init --project koda` run a second time in the same directory overwrites `.koda/config.json` with updated values (idempotent)
- `koda init --project nonexistent` exits with code `1` and prints `"Project not found: nonexistent"` when the API returns 404
- `koda init --project koda --default-type BUG --default-priority HIGH` writes `{ "projectSlug": "koda", "defaults": { "type": "BUG", "priority": "HIGH" } }` to `.koda/config.json`
- `koda init` without `--project` when no auth is configured exits with code `2` and prints `"Not logged in. Run: koda login --api-key <key>"`

---

### CLI-005: `koda config profile` sub-commands
**Depends on CLI-002**

Implement `koda config profile list`, `koda config profile add`, and `koda config profile remove` in `src/commands/config.ts`.

#### Context Files
- `apps/cli/src/commands/config.ts` — existing config command; add `profile` sub-command here
- `apps/cli/src/config.ts` — extend with `getProfiles`, `setProfile`, `removeProfile`

#### Acceptance Criteria
- `koda config profile add staging --api-url https://staging.koda.io/api --api-key stg-xxx` writes `{ apiUrl, apiKey }` under `profiles.staging` in `~/.config/koda/config.json`
- `koda config profile list` prints a table with `Name`, `ApiUrl` columns for each stored profile
- `koda config profile list` prints `"No profiles configured"` when `profiles` is empty or absent
- `koda config profile remove staging` deletes `profiles.staging` from `~/.config/koda/config.json` and exits with code `0`
- `koda config profile remove nonexistent` exits with code `1` and prints `"Profile not found: nonexistent"`
- `koda config profile add staging ...` called twice with different `--api-key` values overwrites the existing profile entry (idempotent upsert)

---

## Acceptance Criteria (Integration)

- Running `koda init --project koda` followed by `koda ticket list` (no flags) in the same directory resolves to the correct project and returns tickets without error
- A `.koda/config.json` with `"profile": "staging"` causes all commands to use that profile's `apiUrl` and `apiKey` from global config
- A `.koda/config.json` in a parent directory is discovered and used when CLI is run from a subdirectory
