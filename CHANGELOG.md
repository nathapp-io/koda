# Changelog

All notable changes to this project will be documented in this file.

## 0.2.0 — Phase 10: Project-Level CLI Config

**Released:** 2026-03-27

### @nathapp/koda-cli

#### New features
- **`koda init`** — Project-level initialization with `--api-url` and `--api-key` flags. Creates config at `~/.config/koda/projects/<slug>.json`. Interactive select skipped.
- **`koda config profile`** — Full CRUD for named profiles: `list`, `get`, `set`, `add`, `remove`. Uses `apiUrl` only (no `apiKey` stored).
- **`resolveContext` wired into all commands** — All ticket, label, comment, agent, and kb sub-commands now use `resolveContext` for project-level context instead of `resolveAuth`.

#### Bug fixes
- Fixed `meCmd?.parse()` → `meCmd?.parseAsync()` for async action support across all agent command tests
- Fixed 46 `parse()` → `parseAsync()` calls in `ticket.spec.ts`
- Added missing `resolveContext` mock in `ticket-link.spec.ts`
- Improved error message when no project is configured

#### Internal
- Migration to async parse pattern throughout CLI commands
- Comprehensive test coverage for project-level context resolution

### @nathapp/koda-api
### @nathapp/koda-web

_No changes in this release._
