# Agent Instructions

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

These instructions apply to all AI coding agents in this project.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/koda-cli`

**Language:** TypeScript

**Key dependencies:** @types/jest, jest, ts-jest, typescript

---
# CLAUDE.md — Koda CLI (apps/cli)

## Project: Koda CLI

Commander.js CLI for agents to interact with the Koda API. The CLI is a **thin shell** — all business logic stays in the API.

### Stack
- **CLI framework:** Commander.js 12
- **HTTP client:** Generated from OpenAPI spec via `@hey-api/client-axios`
- **Config store:** `conf` — stores `apiUrl` + `apiKey` in `~/.koda/config.json`
- **Output:** `chalk` for human output, `--json` flag for machine output
- **Build:** TypeScript → `dist/`
- **Bin:** `koda` → `dist/index.js`

### Key Constraints

1. **Never write HTTP calls manually** — always use generated client in `src/generated/`
2. **`--json` flag is mandatory** on all commands that return data — agents depend on it
3. **Exit codes must be correct:**
   - `0` = success
   - `1` = API error
   - `2` = config/auth error
   - `3` = validation error
4. **Auth resolution order:** `--api-key` flag → `KODA_API_KEY` env → `~/.koda/config.json`
5. **`koda ticket mine`** — shorthand for `ticket list --assigned-to self` — must work without `--project` if default project is set

### Project Structure
```
src/
├── index.ts             # Commander program entry, registers all commands, shebang
├── config.ts            # conf store — read/write ~/.koda/config.json + resolveContext()
├── client.ts            # Configure hey-api Axios client with baseUrl + Bearer token
├── conf.d.ts            # Type declaration for `conf` package
├── generated.ts         # Barrel export for generated client
├── generated/           # Auto-generated from OpenAPI (do NOT edit)
│   ├── core/
│   ├── index.ts
│   ├── schemas.gen.ts
│   ├── services.gen.ts
│   └── types.gen.ts
├── commands/
│   ├── login.ts         # koda login --api-key <key> [--api-url <url>]
│   ├── init.ts          # koda init --project <slug> [--default-type] [--default-priority]
│   ├── config.ts        # koda config show|set
│   ├── project.ts       # koda project list|show
│   ├── ticket.ts        # Ticket CRUD + state transitions + link/unlink + label add/remove
│   ├── comment.ts       # koda comment add
│   ├── agent.ts         # koda agent me|pickup
│   ├── label.ts         # koda label list|create|delete
│   └── kb.ts            # koda kb search|list|add
└── utils/
    ├── output.ts        # output(data, {json}) — table for humans, JSON.stringify for agents
    ├── error.ts         # handleApiError(err) → exit with correct code
    ├── auth.ts          # resolveAuth(options) — flag → env → config fallback
    └── api.ts           # unwrap<T>(response) — extracts data from JsonResponse envelope
```

### Auth Resolution
```typescript
export function resolveAuth(options: { apiKey?: string; apiUrl?: string }) {
  const config = getConfig();
  return {
    apiKey: options.apiKey ?? process.env.KODA_API_KEY ?? config.apiKey,
    apiUrl: options.apiUrl ?? process.env.KODA_API_URL ?? config.apiUrl ?? 'http://localhost:3100/api',
  };
}
```

### API Response Unwrapping
All API responses are wrapped in `JsonResponse` envelopes (`{ ret: 0, data: T }`). Use `unwrap()`:
```typescript
import { unwrap } from '../utils/api';

const response = await TicketsService.findAll({ projectSlug });
const tickets = unwrap(response);  // extracts .data, throws on non-zero ret
```

### Output Pattern
```typescript
// Every command that returns data:
if (options.json) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}
// Human output: chalk-formatted table
```

### Command Reference

**Setup & Config:**
```bash
koda login --api-key <key> [--api-url <url>]
koda init --project <slug> [--default-type bug] [--default-priority medium]
koda config show
koda config set --api-key <key> --api-url <url>
```

**Projects:**
```bash
koda project list [--json]
koda project show <slug> [--json]
```

**Tickets:**
```bash
koda ticket create --project <slug> --type bug|enhancement --title "..." [--priority low|medium|high|critical]
koda ticket list --project <slug> [--status <s>] [--type <t>] [--unassigned] [--json]
koda ticket mine [--project <slug>] [--status verified] [--json]
koda ticket show <ref>                          # ref = KODA-42 or CUID
koda ticket verify <ref> --comment "..."
koda ticket assign <ref> [--to <agent-slug>]    # omit --to = self-assign
koda ticket start <ref>
koda ticket fix <ref> --comment "..."
koda ticket verify-fix <ref> --comment "..." [--pass|--fail]
koda ticket close <ref>
koda ticket reject <ref> --comment "..."
koda ticket update <ref> [--title "..."] [--desc "..."] [--priority <p>] [--type <t>]
koda ticket delete <ref>
koda ticket link <ref> --url <url>              # Link external PR/issue URL
koda ticket unlink <ref> --url <url>            # Remove external link
koda ticket label add <ref> --label <name>      # Attach label to ticket
koda ticket label remove <ref> --label <name>   # Detach label from ticket
```

**Comments:**
```bash
koda comment add --ticket <ref> --body "..." [--type general|verification|fix_report|review]
```

**Agents:**
```bash
koda agent me [--json]                          # Show current agent info
koda agent pickup [--project <slug>] [--json]   # Pick up next available ticket
```

**Labels:**
```bash
koda label list --project <slug> [--json]
koda label create --project <slug> --name "..." [--color "#hex"]
koda label delete --project <slug> --name "..."
```

**Knowledge Base:**
```bash
koda kb search --project <slug> --query "..." [--json]
koda kb list --project <slug> [--json]
koda kb add --project <slug> --file <path>      # Add document to KB
```

### Generated Client
The `src/generated/` directory is gitignored — regenerate with:
```bash
bun run generate   # from monorepo root — exports spec + regenerates client
```
Import pattern:
```typescript
import { TicketsService } from '../generated';
```

### Commands
```bash
bun run build        # tsc compile
bun run dev          # ts-node src/index.ts
bun run test         # jest
bun run type-check   # tsc --noEmit
bun run lint         # eslint src
```
