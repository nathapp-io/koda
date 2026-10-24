---
description: "API persistence tests: official Prisma mocks, transaction callbacks, IRepository providers"
paths:
  - "apps/api/*"
appliesTo:
  - "**/*.spec.ts"
  - "**/*.test.ts"
  - "**/test/**"
  - "**/test-helpers/**"
priority: 80
---

# API Persistence Testing — apps/api

## Testing
- In tests, prefer `createMockPrismaService()` / `createMockPrismaClient()` from `@nathapp/nestjs-prisma`
- Mock `TRANSACTION_MANAGER` as `{ run: vi.fn(fn => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false) }`
- The `run` mock MUST call the callback immediately — this makes the transaction a no-op in unit tests while still exercising the service logic
- Mock `IRepository<TDomain>` by providing a plain object with vi.fn() on all methods, or use `createMock<IRepository<TDomain>>()` from `@golevelup/ts-vitest`
- Provide `TRANSACTION_MANAGER` in every test module that uses a service which injects it

```typescript
// Standard txManager mock:
const mockTxManager = {
  run: vi.fn((fn: () => Promise<unknown>) => fn()),
  getClient: vi.fn(),
  isInTransaction: vi.fn(() => false),
};

// In beforeEach providers:
{ provide: TRANSACTION_MANAGER, useValue: mockTxManager },
```

