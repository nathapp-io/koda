---
paths:
  - "apps/api/*"
appliesTo:
  - "**/i18n/**"
  - "**/*.controller.ts"
  - "**/*.service.ts"
priority: 90
---

# API i18n — apps/api

## i18n
- API translation files: `src/i18n/{en,zh}/*.json`
- Keep one file per module; create in both locales for new modules
- Use keys (for example `this.i18n.t('tickets.notFound')`) instead of hardcoded text
