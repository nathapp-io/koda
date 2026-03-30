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

## Output Anti-Patterns
- **`--json` flag must be on ALL data-returning commands** — inconsistency breaks agent workflows
- **`warn()` outputs to stderr** — not stdout
  ```ts
  // ❌ Wrong
  console.warn('message')  // pollutes stdout

  // ✅ Correct
  console.error('message')
  ```
- **No hardcoded URLs** — use resolved API URL from config

## Validation Anti-Patterns
- **Exit code 3 for validation errors** — exit code 1 is for API/network errors only
  ```ts
  // ❌ Wrong
  if (!input) { error('Invalid'); process.exit(1) }

  // ✅ Correct
  if (!input) { error('Invalid'); process.exit(3) }
  ```
- **Use shared validation utilities** — don't scatter inline manual checks across commands
- **Consistent error messaging** — pick one pattern and stick to it

## File System Anti-Patterns
- **Use async file operations** — never `readFileSync` in production code
  ```ts
  // ❌ Wrong
  const data = JSON.parse(readFileSync(path, 'utf-8'))

  // ✅ Correct
  const data = JSON.parse(await readFile(path, 'utf-8'))
  ```

## Network Anti-Patterns
- **Retry transient failures** — HTTP calls should retry on 5xx with backoff
- **Extract shared utilities** — don't duplicate `maskApiKey()` across files; put in `utils/`
