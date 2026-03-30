# Web Rules — apps/web

## Components
- Install Shadcn components via CLI (`bunx shadcn-vue@latest add <name>`) — never hand-write UI primitives
- Custom components use PascalCase: `components/TicketCard.vue`
- Shadcn components live in `components/ui/` — auto-generated, editable but don't create manually

## Forms
- **Always** use `vee-validate` + `zod` for form validation
- Never use raw `v-model` on form inputs without validation schema

## API Client
- Use `useApi()` composable for all API calls — never use raw `$fetch` or `useFetch`
- `useAuth()` for login/logout/register/token management
- `useAppToast()` for success/error notifications

## Styling
- Use semantic Tailwind colors: `text-muted-foreground`, `bg-background`, `border-border`
- **Never** use hardcoded colors like `text-gray-500` — use Shadcn CSS variables
- Dark mode works via CSS variables — do not add manual `dark:` classes to Shadcn internals
- Use `space-y-*` for vertical stacking, `gap-*` for flex/grid

## i18n
- Use `const { t } = useI18n()` in all components
- All UI text must use `t('key.path')` — no hardcoded strings in templates
- Translation files: `i18n/locales/{en,zh}.json` — nested, single file per locale
- Top-level keys match feature areas: `common`, `auth`, `nav`, `projects`, `tickets`, `comments`, `agents`, `kb`, `labels`, `toast`
- Browser detection via cookie (`koda_locale`), fallback: `en`

## Anti-Patterns
- **No hardcoded strings in templates** — always use `t('key')`, never raw text like `"Cancel"` or `"Deleting..."`
  ```vue
  <!-- ❌ Wrong -->
  <Button>Cancel</Button>
  <p>Are you sure you want to delete agent "{{ agent.name }}"?</p>

  <!-- ✅ Correct -->
  <Button>{{ t('common.cancel') }}</Button>
  <p>{{ t('agents.deleteConfirm', { name: agent.name }) }}</p>
  ```
- **No native HTML form elements** — use Shadcn components instead
  ```vue
  <!-- ❌ Wrong -->
  <input type="text" />
  <textarea />
  <select>...</select>
  <button>Save</button>

  <!-- ✅ Correct -->
  <Input />
  <Textarea />
  <Select>...</Select>
  <Button>{{ t('common.save') }}</Button>
  ```

## Middleware
- `auth.global.ts` handles route protection — no per-page auth checks needed
- Guest-only routes (`/login`, `/register`) redirect authenticated users to `/`

## Generated Client
- `generated/` is gitignored — regenerate with `bun run generate` from monorepo root
- Never edit generated files

## Testing
- Unit/component tests: Jest — `tests/` directory
- E2E tests: Playwright — `playwright.config.ts`
- Run `bun run test` for unit, `bun run test:e2e` for E2E
