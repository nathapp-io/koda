# Koda unslop follow-up implementation plan

**Goal:** Resolve U01–U09 from the approved page-by-page audit.
**Architecture:** Scoped Vue/client changes; preserve API contracts, permissions, routes, slate/indigo tokens and system font. Work inline on the existing dedicated `style/koda-unslop-page-audit` branch.
**Spec:** `docs/ux/redesign/UNSLOP-AUDIT-2026-11-13.md` (user authorized all nine fixes).

- [x] U01: Add explicit IDs/label associations to Dispatch fields and use native placement radios; cover RUN/PLAN/REVIEW/FIX and keyboard/axe checks.
- [x] U02: Stack Labels create controls on mobile; keep usable input widths; verify 320/390/768px and inline edit.
- [x] U03: Handle normalized invitation API errors at the page boundary; persistent invalid/load-failed states, retry, no form without preview; regression tests for 404/410/409/network errors and valid/signed-in/loading states.
- [x] U04–U06: 12px/500 sentence-case section labels; token-based comment type pills; shared 28px/500 auth headings, consistent spacing and translated page titles.
- [x] U07: Neutral outline for passed story/pipeline badges; retain active/failure meaning and graph layout.
- [x] U08–U09: Static pending approval chip; localized semantic knowledge result/verdict treatments. Render populated conditional states in both themes.
- [x] Verify: existing + new meaningful behavioral tests, full web Jest/sanitizer command, changed-file lint, Nuxt typecheck, focused API-backed browser checks. Do not use default Playwright database reset setup.
- [x] Review final diff, update audit resolution record and UX master status/decisions, commit and push on the authorized branch (user subsequently requested push).

**Review focus:** Submission must stay blocked when invitation preview fails; native radios preserve form placement behavior and keyboard navigation; actual permission keys stay intact; localized labels update reactively; semantic status colors keep contrast in both themes. Styling-only changes use existing checks and browser evidence, without new implementation-mirroring tests.

Uses unslop by Damir Sokolovsky (https://x.com/heydamir), CC BY 4.0.

Verification and review results are recorded in `docs/ux/redesign/UNSLOP-FIXES-2026-11-13.md`. Independent review found no blocking defects; added the suggested HTTP 409 and post-preview 404/410 acceptance coverage.
