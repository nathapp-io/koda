# CLI Rules — apps/cli

## HTTP Client
- **Never write HTTP calls manually** — always use the generated client in `src/generated/`
- Use `unwrap<T>(response)` from `utils/api.ts` to extract data from `JsonResponse` envelopes

## Output
- **`--json` flag is mandatory** on all commands that return data — agents depend on it
- Human output uses `chalk` formatting; `--json` outputs `JSON.stringify(data, null, 2)`

## Exit Codes
- `0` = success
- `1` = API error
- `2` = config/auth error
- `3` = validation error

## Auth Resolution Order
1. `--api-key` / `--api-url` flags (highest priority)
2. `KODA_API_KEY` / `KODA_API_URL` environment variables
3. `~/.koda/config.json` via `conf` store (lowest priority)

## Config
- `koda init` creates `.koda/config.json` in the current directory for project-level defaults
- Global config at `~/.koda/config.json` for API credentials
- `resolveContext()` merges project-local + global config

## Generated Client
- `src/generated/` is gitignored — regenerate with `bun run generate` from monorepo root
- Import pattern: `import { TicketsService } from '../generated';`
- Never edit generated files
