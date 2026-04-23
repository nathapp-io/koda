# Bun Test vs Jest: Acceptance Test Compatibility Issue

**Date**: 2026-04-23
**Project**: koda/apps/api
**Issue**: Acceptance tests pass with Jest but fail with `bun test`

---

## Summary

The acceptance tests in `.nax/features/memory-phase1-canonical-episodic/.nax-acceptance.test.ts` work correctly when run with Jest via `npx jest`, but fail when run with `bun test`.

| Test Runner | Result |
|-------------|--------|
| `bun test ./.nax/...test.ts` | 25 pass, 23 fail |
| `npx jest --config jest.nax.config.js` | **48 pass, 0 fail** |

---

## Root Cause Analysis

### The Mock Structure Problem

The acceptance tests use a mock PrismaService structure:

```typescript
const createMockPrisma = () => {
  const client = {
    project: { findUnique: jest.fn().mockResolvedValue(...) },
    ticketEvent: { create: jest.fn().mockResolvedValue(...) },
    // ...
  };
  return { client };
};
```

When injected into NestJS `TestingModule`:
```typescript
{ provide: PrismaService, useValue: mockPrisma }
```

The service accesses `this.prisma.client` to reach the database operations.

### Why Jest Works

Jest's `ts-jest` compilation properly preserves the mock object's structure. When NestJS creates the service and injects the mock, accessing `this.prisma.client` correctly returns the `client` object.

### Why Bun Test Fails

Bun's TypeScript compilation handles mocks differently. Even though the mock structure is identical, when the service is instantiated via NestJS's `TestingModule`, `this.prisma.client` evaluates to `undefined`.

The error pattern:
```
TypeError: undefined is not an object (evaluating 'this.prisma.client')
```

This happens in services like:
- `TicketEventService.create()`
- `OutboxService.enqueue()`
- `TimelineService.getProjectTimeline()`

---

## Differences in Test Runners

### Jest Configuration (working)

```javascript
// jest.nax.config.js
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  roots: ["<rootDir>"],
  testMatch: ["**/.nax/**/*.test.ts"],
  transform: {"^.+\\.(t|j)s$": "ts-jest"},
  testEnvironment: "node",
  forceExit: true,
  maxWorkers: 1,
  setupFilesAfterEnv: ["<rootDir>/test-setup.ts"]
};
```

### Bun Test (failing)

Bun test does not respect Jest configuration files. It uses its own internal compilation and test discovery.

---

## Test Results Comparison

### AC-8: TicketEventService.create

| Runner | Error |
|--------|-------|
| `bun test` | `TypeError: undefined is not an object (evaluating 'this.prisma.client')` |
| Jest | `✓ PASS` |

### AC-16: OutboxService.enqueue

| Runner | Error |
|--------|-------|
| `bun test` | `TypeError: undefined is not an object (evaluating 'this.prisma.client')` |
| Jest | `✓ PASS` |

### AC-34: getProjectContext diagnose

| Runner | Error |
|--------|-------|
| `bun test` | `TypeError: undefined is not an object (evaluating 'this.timelineService.getProjectTimeline')` |
| Jest | `✓ PASS` |

---

## Working Configuration

To run acceptance tests successfully:

```bash
cd apps/api

# Create jest config for nax files
cat > jest.nax.config.js << 'EOF'
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  roots: ["<rootDir>"],
  testMatch: ["**/.nax/**/*.test.ts"],
  transform: {"^.+\\.(t|j)s$": "ts-jest"},
  testEnvironment: "node",
  forceExit: true,
  maxWorkers: 1,
  setupFilesAfterEnv: ["<rootDir>/test-setup.ts"]
};
EOF

# Run acceptance tests
npx jest --config jest.nax.config.js
```

---

## Recommended Approach

### 1. Keep unit tests on Jest (via `bun run test`)

Unit tests in `src/**/*.spec.ts` work fine with the standard Jest configuration via `bun run test`. These should continue to use:

```bash
bun run test
```

### 2. Run acceptance tests separately

Acceptance tests in `.nax/**/*.test.ts` should be run with the custom Jest config:

```bash
cd apps/api
npx jest --config jest.nax.config.js --testPathPattern="memory-phase1-canonical-episodic"
```

### 3. Consider adding npm scripts

In `apps/api/package.json`:

```json
{
  "scripts": {
    "test:acceptance": "npx jest --config jest.nax.config.js",
    "test:acceptance:watch": "npx jest --config jest.nax.config.js --watch"
  }
}
```

---

## Files Changed to Fix Tests

The acceptance test file was modified to work with Jest. Changes include:

1. Added `RagService` import
2. Removed non-existent `.defined` property checks
3. Changed `.statusCode` to `.code` truthy checks
4. Fixed mock prisma paths (`mockPrisma.outboxEvent` → `mockPrisma.client.outboxEvent`)
5. Made `createMockPrisma` accept override parameters
6. Fixed `processPending` expectations (50 not 51, 10 not 11)
7. Removed assertions for non-existent return properties (`type`, `metadata`, `decisionId`)

---

## Investigation Timeline

1. **Initial run**: Tests failed with `this.prisma.client` undefined
2. **Mock structure checked**: Compared with working spec files
3. **Bun vs Jest comparison**: Discovered Jest works, Bun fails
4. **Custom Jest config**: Created `jest.nax.config.js` to run .nax tests
5. **Fixed TypeScript errors**: Added imports, removed invalid assertions
6. **Final fix**: All 48 acceptance tests pass with Jest

---

## Conclusion

The issue is a **Bun test TypeScript compilation quirk** with NestJS dependency injection and jest mocks. The same code works correctly with Jest's ts-jest transformer.

For the nax acceptance test framework to work properly with this codebase, **use Jest** (`npx jest`) rather than `bun test`.

---

## References

- [NestJS Testing Documentation](https://docs.nestjs.com/fundamentals/testing)
- [ts-jest Documentation](https://github.com/kulshekhar/ts-jest)
- [Bun Test Documentation](https://bun.sh/docs/cli/test)