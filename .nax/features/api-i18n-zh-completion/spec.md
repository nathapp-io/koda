# SPEC: API Chinese catalog completion and parity guard

Closes: #468

## Summary

The API's Chinese catalog has the same 386 keys as the English one, but 12 entries in
`apps/api/src/i18n/zh/common.json` still carry the English text. Eight of them are `validation.*`
keys that DTO constraints serve to clients, so after #467 removed the `$t(...)` wrappers a Chinese
client reads English field errors. This feature translates those 12 entries, repairs the two
`validation.json` values that drop a `{value}` placeholder, and adds an API-side catalog parity spec
that fails when a `zh` value is byte-identical to its `en` counterpart outside an explicit allow-list
or loses a placeholder. Two public DTO routes then prove the `zh` answer end to end.

## Motivation

- **#468:** before #467 every DTO constraint message reached the client as the raw
  `$t(common.validation.isEmail)` placeholder, which hid the catalog gap. #467 makes the catalog text
  visible; for these keys that text is English. The issue reproduces it with
  `POST /api/auth/register {"email":"nope",...}` and `Accept-Language: zh`.
- **Verified counts (the issue's numbers are off; these are the measured ones):** 32 namespace files on
  each side, 386 keys on each side, identical keys. Byte-identical values: 12 in `common.json` plus the
  5 `date.*` format patterns — 17, not 13. The user-facing gap is the 8 `common.validation.*` keys, all
  bound in DTOs; the issue says nine, but only eight entries are listed and only eight exist. The four
  `common.errors.*` keys have no reader anywhere in this repository.
- **No API parity guard exists.** `apps/api/test/unit/i18n/*` pins individual feature namespaces; nothing
  compares the two catalogs. The web's `tests/i18n/locale-parity.spec.ts` is a hand-written key-existence
  check, not a byte-identical check, and the web catalog itself carries 49 identical en/zh values, so it
  is not a transferable pattern.
- **The placeholder audit surfaces a second, pre-existing gap:** `zh/validation.json` `min` and `max` drop
  the `{value}` token the English text carries. No DTO addresses the `validation.*` namespace today, so
  nothing renders those two strings at the moment; the parity guard covers every namespace, and leaving
  them would force the guard's first allow-list exception, which is exactly the kind of exception that
  hides the next real gap.

## Design

### Catalog translations

`apps/api/src/i18n/zh/common.json`, `validation` (eight entries, all reachable from DTO constraints):

| Key | zh |
|:--|:--|
| `validation.required` | `此字段为必填项` |
| `validation.isEmail` | `必须是有效的邮箱地址` |
| `validation.minLength` | `长度至少为 {min} 个字符` |
| `validation.maxLength` | `长度不能超过 {max} 个字符` |
| `validation.isString` | `必须是字符串` |
| `validation.isEnum` | `无效的值` |
| `validation.isUrl` | `必须是有效的 URL` |
| `validation.isBoolean` | `必须是布尔值` |

`apps/api/src/i18n/zh/common.json`, `errors` (four entries, no reader in this repo):

| Key | zh |
|:--|:--|
| `errors.notFound` | `未找到资源` |
| `errors.forbidden` | `访问被拒绝` |
| `errors.unauthorized` | `未授权操作` |
| `errors.invalidTransition` | `无效的工单状态转换` |

Wording follows the neighbouring catalogs: `tickets.invalidTransition` is already
`无效的工单状态转换`, `tickets`' `40003` is `访问被拒绝`, and `auth`/`exception` `40000` is `未授权操作`.
The four `errors.*` keys are translated rather than deleted so the key set stays at 386 = 386 (see Out of
Scope) and because the `@nathapp/nestjs-common` exception convention that may look them up is outside
this repository.

The `en` catalogs do not change.

### Placeholder repair

`apps/api/src/i18n/zh/validation.json` (class-validator defaults this repo ships; no DTO references the
`validation.*` namespace today):

| Key | zh (before) | zh (after) |
|:--|:--|:--|
| `min` | `{property}的值必须至少为{constraints.0}` | `{property} 的值 "{value}" 必须至少为 {constraints.0}` |
| `max` | `{property}的值必须小于或等于{constraints.0}` | `{property} 的值 "{value}" 必须小于或等于 {constraints.0}` |

These are the only two placeholder mismatches in either catalog today; repairing them lets the parity
check compare placeholder sets across every namespace with no exception. The other entries in that file
are unchanged.

### Parity helper

New `apps/api/test/helpers/catalog-parity.ts`, pure and database-free:

```ts
export interface CatalogSet { [namespace: string]: Record<string, string> }
export interface CatalogDiff {
  missingFiles: string[];        // a namespace file in en with no zh file
  extraFiles: string[];          // a namespace file in zh with no en file
  missingKeys: string[];         // `${namespace}.${key}` in en, absent in zh
  extraKeys: string[];           // `${namespace}.${key}` in zh, absent in en
  untranslated: string[];        // `${namespace}.${key}` byte-identical outside the allow-list
  placeholderMismatches: string[]; // `${namespace}.${key}` whose placeholder multisets differ
}
export function flattenCatalog(value: unknown): Record<string, string>
export function placeholders(value: string): string[]
export function diffCatalogs(en: CatalogSet, zh: CatalogSet, allowedIdentical: readonly string[]): CatalogDiff
```

- A `CatalogSet` key is a namespace file name without `.json` (`common`, `date`, …); its value is that
  file flattened to dotted keys (`validation.minLength`).
- `flattenCatalog` walks nested objects into dotted keys. Every leaf in the catalogs is a string. A
  non-object root, an array, or a non-string leaf throws with the offending key/path, so a future shape
  change fails loudly instead of being skipped.
- `placeholders` returns the `{...}` tokens of a value, in order (the catalogs use single-brace tokens;
  no other style appears in either locale).
- `diffCatalogs` receives already-flattened catalogs and compares file sets, key sets, untranslated
  values (only for keys both sides share) and placeholder multisets (sorted arrays). `allowedIdentical`
  entries use the same `${namespace}.${key}` form and are exempt from the untranslated check only.

### Parity spec

New `apps/api/test/unit/i18n/catalog-parity.spec.ts`:

- Loads every `*.json` under `apps/api/src/i18n/en` and `apps/api/src/i18n/zh` at test time, resolving
  the directory from `__dirname` as the existing i18n specs do (`join(__dirname,
  '../../../src/i18n')`).
- Asserts that `diffCatalogs(en, zh, ALLOWED_IDENTICAL)` returns six empty arrays — the composition
  flattens every namespace first. A failure names the namespace and key, so the fix is mechanical.
- Declares `ALLOWED_IDENTICAL` as a local constant in this spec file: exactly the five `date.*` keys —
  `date.dateFormat`, `date.dateTimeFormat`, `date.queryDateFormat`, `date.dateFormatWithDay`,
  `date.dateTimeFromatWithDay` (the key's spelling is part of the contract) — with a comment saying a
  date format pattern is not language-specific.
- Drives `flattenCatalog`, `placeholders` and `diffCatalogs` with synthetic fixtures to prove each gap
  class is reported: missing/extra file, missing/extra key, untranslated value, allow-listed identical
  value (not reported), dropped placeholder, renamed placeholder, extra placeholder.

### End-to-end `zh` answers

Two public DTO routes already have DB-backed integration specs and need no auth:

- `apps/api/test/integration/auth/password-reset-request.integration.spec.ts`, AC-15: add a request with
  `Accept-Language: zh-CN` and `email: 'not-an-address'`; assert `message` and `errors.email` are
  `必须是有效的邮箱地址`, while the existing en assertion of AC-15 stays.
- `apps/api/test/integration/auth/password-reset-confirm.integration.spec.ts`, AC-11: extend the local
  `confirm` helper with an optional `acceptLanguage` (mirroring `requestReset` in the sibling spec) and
  send `newPassword: 'aB1!'` with `Accept-Language: zh-CN`; `aB1!` passes the complexity rule and fails
  only `MinLength(8)`, so the body is the Chinese bound `长度至少为 8 个字符`. Validation runs before the
  token lookup, so any non-empty token string is enough. The existing en assertions are unchanged.

Both specs keep their shared DB gate (`canRunDbTests()`); they run under `test:scoped` outside the nax
sandbox.

## Out of Scope

- The `apps/web` catalogs; the web catalog is complete and is not changed here.
- The web-side parity specs, including `apps/web/tests/i18n/locale-parity.spec.ts`.
- Deleting the four `common.errors.*` keys. They have no reader in this repository, but the
  `@nathapp/nestjs-common` convention that may read them is not source-available here and translation is
  behaviour-neutral; deletion can be a separate decision.
- The `date.*` format patterns: identical by design and allow-listed, not translated.
- Any change to the validation filter; #467 owns that path.
- Any change to the `key|{"args"}` message format; #467 defines it.
- Re-introducing or removing `$t(...)` wrappers; #467 removed them.
- The other 14 entries in `zh/validation.json`; only the two placeholder repairs change.
- Translating the en side.
- Adding a third locale.
- Detecting a `zh` value that is English but not byte-identical to its `en` counterpart (for example a
  stray punctuation change); the guard checks byte identity and review covers the rest.
- Runtime verification against a deployed instance; the acceptance is the specs above.

## Stories

### US-001: Translate the Chinese common catalog and repair the two placeholders

**No-test:** catalog text only; the parity spec in US-002 is the automated guard.

No dependencies. Workdir: `apps/api`.

Change exactly the 12 values in `apps/api/src/i18n/zh/common.json` and the two `validation.min` /
`validation.max` values in `apps/api/src/i18n/zh/validation.json` to the strings in Design. Keep the
existing JSON shape, nesting and key order; do not touch `en` or any other zh entry.

### US-002: Add the catalog parity helper and spec

Depends on US-001 (the repository-level assertion is green only after the translations). Workdir:
`apps/api`.

Add `apps/api/test/helpers/catalog-parity.ts` and
`apps/api/test/unit/i18n/catalog-parity.spec.ts` as designed. The spec reads the real catalogs and pins
the allow-list, then exercises the pure functions with fixtures. It lives under `test/unit`, so the
default `bun run test` executes it without a database or app bootstrap.

### US-003: Prove the Chinese DTO answer on two public routes

Depends on US-001. Workdir: `apps/api`.

Extend AC-15 of `password-reset-request.integration.spec.ts` with a `zh-CN` request and AC-11 of
`password-reset-confirm.integration.spec.ts` with a `zh-CN` request, as designed. Keep every existing
assertion in both cases.

### Context Files

**US-001**

- `apps/api/src/i18n/zh/common.json`
- `apps/api/src/i18n/zh/validation.json`
- `apps/api/src/i18n/en/common.json`

**US-002**

- `apps/api/src/i18n/en/common.json`
- `apps/api/src/i18n/zh/common.json`
- `apps/api/src/i18n/en/date.json`
- `apps/api/src/i18n/zh/date.json`
- `apps/api/src/i18n/zh/validation.json`
- `apps/api/test/unit/i18n/webhooks-translation-keys.spec.ts` (style of an existing i18n unit spec)

**US-003**

- `apps/api/test/integration/auth/password-reset-request.integration.spec.ts`
- `apps/api/test/integration/auth/password-reset-confirm.integration.spec.ts`
- `apps/api/src/auth/dto/password-reset-request.dto.ts`
- `apps/api/src/auth/dto/password-reset-confirm.dto.ts`
- `apps/api/src/i18n/zh/common.json` (the translated text the assertions name)

### Creates

**US-002**

- `apps/api/test/helpers/catalog-parity.ts`
- `apps/api/test/unit/i18n/catalog-parity.spec.ts`

### Modifies

**US-001**

- `apps/api/src/i18n/zh/common.json` — the 12 values in Design; every other value and the key order stay.
- `apps/api/src/i18n/zh/validation.json` — `min` and `max` only.

**US-003**

- `apps/api/test/integration/auth/password-reset-request.integration.spec.ts` — AC-15 gains the `zh-CN`
  request; the existing en assertions stay.
- `apps/api/test/integration/auth/password-reset-confirm.integration.spec.ts` — the `confirm` helper
  gains an optional `acceptLanguage` parameter, defaulting to no header, and AC-11 gains the `zh-CN`
  request.

### Seams

- US-002's repository assertion depends on US-001's translations; the fixture assertions do not.
- US-003's assertions depend on US-001's zh text; they reach the real validation pipe, so a failed
  interpolation (a dropped `{min}`) fails an assertion.
- The parity spec and US-003 cover different failure modes: the spec pins catalog text and placeholders,
  the integration cases pin that the filter resolves the key and interpolates its arguments in `zh`.

## Acceptance Criteria

### US-001

1. [review] `apps/api/src/i18n/zh/common.json` `validation.required`, `isEmail`, `minLength`, `maxLength`, `isString`, `isEnum`, `isUrl`, `isBoolean` read exactly as the Design table, placeholders included.
2. [review] `apps/api/src/i18n/zh/common.json` `errors.notFound`, `forbidden`, `unauthorized`, `invalidTransition` read exactly as the Design table.
3. [review] `apps/api/src/i18n/zh/validation.json` `min` and `max` carry the Design's placeholder-bearing text; no other entry in that file changes.
4. [review] The diff of the change contains only those 14 string values; `en` is untouched and both catalogs still have 386 keys.

### US-002

1. [unit] `catalog-parity.spec.ts` passes on the repository's catalogs: `diffCatalogs(en, zh, ALLOWED_IDENTICAL)` returns `missingFiles`, `extraFiles`, `missingKeys`, `extraKeys`, `untranslated` and `placeholderMismatches` all empty.
2. [unit] `flattenCatalog({ a: { b: 'x' }, c: 'y' })` returns `{ 'a.b': 'x', c: 'y' }`.
3. [unit] `flattenCatalog` throws, naming the dotted key, for a non-string leaf such as `{ a: { b: 1 } }`.
4. [unit] `flattenCatalog` throws for a non-object root (`null`, `'x'`) and for an array (`['x']`).
5. [unit] `placeholders('长度至少为 {min} 个字符')` returns `['{min}']`; `placeholders('无占位符')` returns `[]`.
6. [unit] `diffCatalogs` reports `namespace.key` in `missingKeys` when en has a key zh lacks, and in `extraKeys` for the reverse.
7. [unit] `diffCatalogs` reports `untranslated` for an identical value whose key is not allow-listed, and does not report it when the key is allow-listed.
8. [unit] `diffCatalogs` reports `placeholderMismatches` for a dropped token (`{value}`), a renamed token (`{min}` vs `{max}`) and an extra token.
9. [unit] `diffCatalogs` reports a namespace file present on one side only in `missingFiles` / `extraFiles`.
10. [unit] `ALLOWED_IDENTICAL` is exactly the five `date.*` keys listed in Design.

### US-003

1. [integration] `POST /api/auth/password-reset` with `{email: 'not-an-address'}` and `Accept-Language: zh-CN` answers 400 whose `message` is `必须是有效的邮箱地址` and whose `errors.email` is `['必须是有效的邮箱地址']`.
2. [integration] The same request without `Accept-Language` keeps answering the English `Must be a valid email address`.
3. [integration] `POST /api/auth/password-reset/confirm` with a non-empty token and `newPassword: 'aB1!'` under `Accept-Language: zh-CN` answers 400 whose `message` is `长度至少为 8 个字符` and whose `errors.newPassword` is `['长度至少为 8 个字符']`.
4. [integration] The same confirm without `Accept-Language` keeps answering `Must be at least 8 characters long`.
5. [integration] Neither `zh-CN` body contains `$t(`.
