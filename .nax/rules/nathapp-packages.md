---
priority: 45
description: "Use the @nathapp platform packages instead of hand-rolling: capability catalog for bootstrap, auth, tenancy, data, messaging and cross-cutting concerns"
paths:
  - "apps/api/*"
---

# Use the nathapp platform packages — do not hand-roll

The `@nathapp/nestjs-*` packages already ship tenancy, auth/RBAC, IAM, accounts, OAuth,
notifications (email/SMS/WhatsApp/push), outbox, idempotency, caching, queues, storage,
pagination, rate limiting, audit, CSRF, health and observability. Before implementing any
of these, ask the `nathapp-nestjs-docs` MCP server — hand-rolled duplicates are review
findings.

Call sequence:

1. `find_package(need)` — which package covers the capability (match on the Aliases column).
2. `get_usage(package)` — install, module registration, config keys, DI tokens, ordering, pitfalls.
3. `get_example(package)` — a real, type-checked example.
4. `get_api(package)` — confirm the exports of the version installed in this repo before importing.

The tables below are the capability catalog, shared with the `nathapp-nestjs-patterns` skill.

## Capability catalog

### Bootstrap & foundation

| Need | Aliases | Package(s) |
|---|---|---|
| App bootstrap, HTTP adapter, global setup | bootstrap, main.ts, fastify, AppFactory, global prefix, graceful shutdown | `@nathapp/nestjs-app` |
| Response envelope, business exceptions, module builder | JsonResponse, response envelope, AppException, error handling, ret code, ConfigurableModuleBuilder | `@nathapp/nestjs-common` |
| i18n / localized messages | i18n, translation, locale, localization, messages | `@nathapp/nestjs-common` |
| Pagination / paged results | pagination, page, pageSize, offset, IPageOption, IPageResult, Paginate | `@nathapp/nestjs-common`, `@nathapp/nestjs-data`, `@nathapp/nestjs-prisma` |

### Auth & identity

| Need | Aliases | Package(s) |
|---|---|---|
| Authentication, JWT, RBAC guards | auth, authentication, login, JWT, bearer token, refresh token, guard, RBAC, roles, permissions, Principal, Public, RequiredPermission, JWKS | `@nathapp/nestjs-auth` |
| Two-factor auth / TOTP / OTP | 2FA, two-factor, MFA, TOTP, OTP, one-time password, authenticator | `@nathapp/nestjs-auth-2fa` |
| IAM: roles, permissions, policies | IAM, authorization, RBAC, role, permission, policy, resource, access control, ability | `@nathapp/nestjs-iam`, `@nathapp/nestjs-iam-prisma` |
| IAM OAuth integration | IAM OAuth, client credentials, service account, delegated auth | `@nathapp/nestjs-iam-oauth` |
| Accounts / user profiles / account types | account, user, profile, signup, registration, account type, membership | `@nathapp/nestjs-account`, `@nathapp/nestjs-account-prisma` |
| OAuth2 / OIDC authorization server | OAuth, OAuth2, OIDC, OpenID Connect, authorization server, identity provider, authorization code, PKCE, consent | `@nathapp/nestjs-oauth`, `@nathapp/nestjs-oauth-prisma` |
| CSRF protection | CSRF, cross-site request forgery, csrf token, SkipCsrf | `@nathapp/nestjs-csrf` |
| Captcha / bot protection | captcha, recaptcha, hcaptcha, bot protection, human verification | `@nathapp/nestjs-captcha` |
| Rate limiting / throttling | rate limit, throttling, throttle, quota, brute force, ThrottlerGuard | `@nathapp/nestjs-throttler` |

### Tenancy & platform

| Need | Aliases | Package(s) |
|---|---|---|
| Multi-tenant request isolation | tenancy, multi-tenant, tenant, tenant_id, X-Tenant-Id, row-level isolation, CurrentTenant, SkipTenant | `@nathapp/nestjs-tenant`, `@nathapp/nestjs-tenant-prisma` |
| In-process event bus / domain events | event bus, domain event, publish, subscribe, event handler, emitter | `@nathapp/nestjs-event-bus` |
| Record domain events to the outbox | outbox recorder, integration event, transactional event, record event | `@nathapp/nestjs-outbox-recorder` |

### Data & persistence

| Need | Aliases | Package(s) |
|---|---|---|
| Repository abstraction / transactions (ORM-agnostic) | repository, data access, IRepository, transaction, TRANSACTION_MANAGER, unit of work | `@nathapp/nestjs-data` |
| TypeORM repositories | TypeORM, entity, data source, migration, AbstractTypeOrmRepository | `@nathapp/nestjs-typeorm` |
| Prisma repositories / PrismaService | Prisma, PrismaService, schema, database client, AbstractPrismaRepository | `@nathapp/nestjs-prisma` |
| Caching / cache manager | cache, caching, cache manager, TTL, memoization | `@nathapp/nestjs-cache` |
| Redis / distributed locks | redis, distributed lock, mutex, RedisLockService, key-value | `@nathapp/nestjs-redis` |
| File / object storage | storage, file upload, S3, object storage, bucket, attachment | `@nathapp/nestjs-storage` |

### Messaging & delivery

| Need | Aliases | Package(s) |
|---|---|---|
| Notification orchestration (core) | notification, notify, alert, message, channel, template, in-app, send, email, sms, push, whatsapp, multi-channel, fallback | `@nathapp/nestjs-notification` |
| Notification management: templates, preferences, delivery tracking | notification templates, preferences, opt-out, delivery log, delivery tracking, notification channel | `@nathapp/nestjs-notify`, `@nathapp/nestjs-notify-prisma` |
| Transactional outbox / at-least-once delivery | outbox, transactional outbox, at-least-once, relay, publisher, dedup | `@nathapp/nestjs-outbox` |
| Outbox store (Prisma) | outbox store, prisma outbox, persistence, delivery record | `@nathapp/nestjs-outbox-prisma` |
| Outbox store (TypeORM) | outbox store, typeorm outbox, persistence | `@nathapp/nestjs-outbox-typeorm` |
| Outbox queue / broker publisher | outbox queue, broker, publish, worker, relay | `@nathapp/nestjs-outbox-queue` |
| Job queue / background jobs | queue, jobs, worker, background job, retry, delayed job, BullMQ | `@nathapp/nestjs-queue` |
| Microservice clients / message patterns | microservice, client, message pattern, RPC, ServiceClientFactory | `@nathapp/nestjs-microservices` |
| Email delivery (Brevo/Sendinblue) — requires core @nathapp/nestjs-notification | email, SMTP, transactional email, brevo, sendinblue | `@nathapp/nestjs-notification-brevo` |
| Email delivery (AWS SES) — requires core @nathapp/nestjs-notification | email, SES, AWS email, transactional email | `@nathapp/nestjs-notification-ses` |
| SMS/push delivery (AWS SNS) — requires core @nathapp/nestjs-notification | SMS, text message, SNS, push notification, AWS | `@nathapp/nestjs-notification-sns` |
| SMS/OTP delivery (Twilio) — requires core @nathapp/nestjs-notification | SMS, text message, OTP, Twilio, phone verification | `@nathapp/nestjs-notification-twilio` |
| WhatsApp delivery (Twilio) — requires core @nathapp/nestjs-notification | WhatsApp, WhatsApp message, Twilio WhatsApp, business message | `@nathapp/nestjs-notification-twilio-whatsapp` |

### Cross-cutting

| Need | Aliases | Package(s) |
|---|---|---|
| Logging | logging, logger, structured logs, app logger | `@nathapp/nestjs-logging` |
| Idempotency / duplicate request protection | idempotency, idempotent, duplicate request, dedup, replay, IdempotencyKey | `@nathapp/nestjs-idempotency` |
| Health checks / readiness | health, health check, readiness, liveness, probe | `@nathapp/nestjs-health` |
| Audit trail | audit, audit log, audit trail, who-did-what, compliance | `@nathapp/nestjs-audit` |
| Observability: tracing, metrics, logs | observability, tracing, OpenTelemetry, metrics, Prometheus, spans | `@nathapp/nestjs-observability` |
