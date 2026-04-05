# Gemini CLI Context

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/koda-cli`

**Language:** TypeScript

**Key dependencies:** @types/jest, jest, ts-jest, typescript

---
# Koda CLI Context

This is the app-specific source-of-truth context for `apps/cli`.

## Role In The Monorepo

`apps/cli` is a thin terminal client for the Koda API.

It should:
- resolve user/agent context from flags, env vars, global config, and local project config
- call API operations through the generated client
- format output for humans and automation

It should not:
- reimplement API business rules
- fork API response semantics
- manually duplicate endpoint wiring that belongs in generated code

## Stack

- Commander.js 12
- generated client from `@hey-api/openapi-ts` with Axios runtime
- `conf` for persisted user config
- Jest for tests

## Architecture

Entry points and key files:
- `apps/cli/src/index.ts`: program registration and process lifecycle handling
- `apps/cli/src/config.ts`: global config, profiles, local `.koda/config.json`, and context resolution
- `src/commands/`: command modules
- `src/utils/`: output/error/auth helpers
- `src/generated/`: generated API client, source controlled but not hand-edited

Command surface currently includes:
- login
- init
- config
- project
- ticket
- comment
- agent
- label
- kb

## Context Resolution

The CLI resolves context in this order where applicable:
- explicit flags
- local project config from `.koda/config.json`
- selected profile from global config
- top-level global config in `~/.koda/config.json`
- default API URL fallback

Important implementation detail:
- the CLI supports a global `--cwd` option to change the working directory used for project config discovery

## Output And Exit Semantics

General rules:
- commands returning structured data should support `--json`
- machine consumers rely on stable JSON output
- API envelope unwrapping belongs in CLI helpers/utilities, not scattered ad hoc across commands
- keep exit codes intentional and consistent with existing command behavior

## Generated Client Rules

The generated client lives in `apps/cli/src/generated/`.

Rules:
- do not hand-edit files in `src/generated/`
- regenerate from the monorepo root after API contract changes
- prefer generated services and generated types over handwritten HTTP calls

Current generation flow:

```text
bun run api:export-spec
bun run generate
-> apps/cli/src/generated/
```

## Config Files

Global user config:
- `~/.koda/config.json` via `conf`

Project-local config:
- `.koda/config.json` discovered upward from the current working directory or `--cwd`

Current config concepts in code:
- `apiKey`
- `apiUrl`
- named `profiles`
- project-local `projectSlug`

## Testing Rules

- keep command behavior covered with Jest specs
- prefer testing command modules and config resolution over snapshot-heavy tests
- mock generated client boundaries rather than making real network calls

Useful scripts:
- `bun run test`
- `bun run type-check`
- `bun run lint`
