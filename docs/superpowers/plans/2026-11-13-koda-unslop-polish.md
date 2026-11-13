# Koda focused polish implementation plan

**Goal:** Apply the focused unslop audit approved in chat on 2026-11-13.
**Architecture:** Retain the Nuxt shell, existing routes, system font and indigo accent. Adjust shared tokens and component classes; preserve workflow behavior, translations, permissions and chart semantics.
**Tech stack:** Nuxt 4, Vue, Tailwind, Lucide.
**Design:** Exact, calm, workmanlike engineering workbench. Ticket references anchor work; status and fleet progress carry meaningful color. Preserve features and section order.

## Tasks
- [x] Spacing: sidebar labels 24px above/8px below; nav 32px rows; board padding 12px, cards 12px, gaps 8px.
- [x] Color: lower dark neutral saturation, neutral hover/selection with an indigo inset marker; neutral ticket type chips, preserve priority/status meaning and PR state labels.
- [x] Icons/copy/type: Lucide stroke 1.5; existing sentence-case translations; shared page title 28px/500, sidebar labels 12px/500, preserve system font.
- [x] Layout/details: retain shell dimensions and mobile drawer; plain tabular board counts; remove duplicate priority dot on board cards; no new imagery or motion.
- [x] Verify: existing token contrast, layout, ticket/component and full Jest suites; lint and typecheck. Browser-check light/dark and mobile with local fixture data. Full API-backed Playwright suite only against a verified disposable database (its setup resets the database).
- [x] Update UX master plan and token documentation, inspect final diff.

## Constraints and review
No commit, push, new dependencies, API/auth changes, fabricated production data or changes to business logic. Keep nav source order pinned by tests. Update existing tests whose design assertions intentionally change. Styling-only changes use existing checks rather than new implementation-mirroring tests.

## Attribution
Uses unslop by Damir Sokolovsky (https://x.com/heydamir), CC BY 4.0.

## Implementation record

| Pass | Result |
| --- | --- |
| Spacing | Navigation groups 24/8px; nav rows 32px minimum; board padding 12px |
| Color | Low-saturation dark slate; neutral hover/selection; neutral ticket types; PR indicators use semantic tokens |
| Icons | Existing Lucide family and contextual sizes retained; global 1.5 stroke rule outside Tailwind layers |
| Copy | Existing sentence-case locale strings retained; removed CSS uppercasing |
| Type | Shared page titles 28px/500, subtitles 14px; group labels 12px/500 |
| Layout | Existing routes, section order, shell widths, drawer and board scrolling retained |
| Details | Plain tabular column counts; priority stripe and label without duplicate dot; hover preserves stripe |
| Visuals | Product tickets and workflow states carry visual detail; no generated images or image prompt needed |
| Motion | Existing restrained feedback and reduced-motion handling retained; no new animation |

## Verification record

- Full Jest: 469 suites, 5,587 tests passed.
- Changed-file ESLint and Nuxt typecheck passed.
- Real sanitizer harness: 17 checks passed; FlowAnswerForm DOM check passed.
- Existing Playwright accessibility and board-filter checks: 16 passed across initial run and interrupted-dashboard rerun. Initial dashboard attempt was interrupted by navigation, with no accessibility violation reported; rerun passed.
- Independent code review: sole hover-stripe finding fixed and confirmed; no outstanding findings.
- Browser harness used temporary config, dedicated ports 3192/3193 and disposable test databases, migrate deploy, explicit Nuxt host; no production/dev data reset.
- Fresh disposable databases remain in the test Postgres; no destructive cleanup performed.
- Execution stayed on a dedicated branch in the existing clean checkout, with no commit or push.

- Final populated-board browser check passed: 28px/500 title and 1.5px Lucide stroke in both themes, no document overflow at 1440px or 390px, priority stripe survives hover, mobile drawer closes with Escape. Screenshot: `/tmp/koda-unslop-after.png`. Temporary browser check moved outside repository after verification.
- After final CSS placement correction: token contrast and ticket component/helper checks passed (64 tests).

## Authorized commit and follow-up audit

On 2026-11-13 the user requested a new branch and commit, superseding the earlier no-commit constraint. Created `style/koda-unslop-page-audit` and committed the polish as `ddfb7b4`. Fresh pre-commit verification passed: 25 targeted Jest suites / 224 tests and changed-file lint. The subsequent [page-by-page audit](../../ux/redesign/UNSLOP-AUDIT-2026-11-13.md) records new pending follow-ups; no product changes from that audit have been applied. No push was requested or performed.
