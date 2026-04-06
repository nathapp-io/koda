# VCS Foundation Tests

Comprehensive test suite for the VCS Phase 1 foundation feature covering all acceptance criteria.

## Test Files

### 1. `prisma-models.integration.spec.ts`
**Acceptance Criteria Covered:** AC1, AC2, AC3, AC4

Tests Prisma schema for VCS models:
- VcsConnection model creation with all fields
- VcsSyncLog model creation with all fields
- Ticket model extensions (externalVcsId, externalVcsUrl, vcsSyncedAt)
- Project model extensions (vcsConnection one-to-one relation)
- Cascade delete behavior
- Unique constraints (projectId unique on VcsConnection)

**Run:** `DATABASE_URL=file:./koda-test.db npx jest test/integration/vcs/prisma-models.integration.spec.ts`

### 2. `encryption.util.spec.ts` (in src/common/utils/)
**Acceptance Criteria Covered:** AC5, AC6, AC7, AC8

Unit tests for token encryption utility:
- encryptToken format validation (iv:authTag:ciphertext)
- Hex encoding validation (32-char IV, 32-char authTag)
- Round-trip encryption/decryption
- Tampered ciphertext detection (GCM integrity check)
- Wrong key detection
- Various input types (empty, long, special chars, unicode)

**Run:** `npx jest src/common/utils/encryption.util.spec.ts`

### 3. `vcs.config.spec.ts` (in src/config/)
**Acceptance Criteria Covered:** AC9

Unit tests for vcsConfig registration:
- Namespace registration ("vcs")
- Environment variable mapping:
  - VCS_ENCRYPTION_KEY → encryptionKey
  - VCS_DEFAULT_POLLING_INTERVAL_MS → defaultPollingIntervalMs (default: 3600000ms)
  - VCS_GITHUB_API_URL → githubApiUrl (default: https://api.github.com)
- Type validation
- Configuration object shape

**Run:** `npx jest src/config/vcs.config.spec.ts`

### 4. `vcs-config-registration.integration.spec.ts` (NEW)
**Acceptance Criteria Covered:** AC9

Integration tests for vcsConfig in NestJS application context:
- ConfigModule integration
- Injection via ConfigService
- ConfigService.get() access patterns
- Environment variable isolation
- Consistency across multiple calls

**Run:** `npx jest test/integration/vcs/vcs-config-registration.integration.spec.ts`

### 5. `token-encryption.integration.spec.ts` (NEW)
**Acceptance Criteria Covered:** AC5, AC6, AC7, AC8

Comprehensive integration tests for token encryption:
- Format specification compliance ([0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+)
- Master key validation (32-byte AES-256)
- Tampered data detection (IV, authTag, ciphertext)
- Wrong key detection
- Various token formats (GitHub PAT, user tokens, etc.)
- Security properties (non-deterministic, auth tag integrity)
- Edge cases (empty plaintext, unicode, special characters, long keys)

**Run:** `npx jest test/integration/vcs/token-encryption.integration.spec.ts`

### 6. `schema-validation.integration.spec.ts` (NEW)
**Acceptance Criteria Covered:** AC1, AC2, AC3, AC4

Detailed schema validation tests verifying exact field compliance:
- VcsConnection field validation (id, projectId, provider, repoOwner, repoName, encryptedToken, syncMode, allowedAuthors, pollingIntervalMs, webhookSecret, lastSyncedAt, isActive, createdAt, updatedAt)
- VcsSyncLog field validation (id, vcsConnectionId, syncType, issuesSynced, issuesSkipped, errorMessage, startedAt, completedAt)
- Cascade delete behavior
- Nullable field handling
- JSON string field validation
- One-to-one relationship constraints

**Run:** `DATABASE_URL=file:./koda-test.db npx jest test/integration/vcs/schema-validation.integration.spec.ts`

### 7. `vcs-foundation-integration.integration.spec.ts` (NEW)
**Acceptance Criteria Covered:** AC1-AC9 (All)

End-to-end integration test simulating real usage:
- VcsService with ConfigService dependency injection
- Token encryption/decryption with vcsConfig
- VcsConnection creation with encrypted tokens
- VcsSyncLog creation and querying
- Ticket and Project extensions in context
- Full workflow: create project → create VcsConnection → sync → log results

**Run:** `DATABASE_URL=file:./koda-test.db npx jest test/integration/vcs/vcs-foundation-integration.integration.spec.ts`

## Acceptance Criteria Coverage Matrix

| AC | Description | Test Files |
|:---|:---|:---|
| AC1 | VcsConnection schema with all fields | prisma-models.integration.spec.ts, schema-validation.integration.spec.ts, vcs-foundation-integration.integration.spec.ts |
| AC2 | VcsSyncLog schema with all fields | prisma-models.integration.spec.ts, schema-validation.integration.spec.ts, vcs-foundation-integration.integration.spec.ts |
| AC3 | Ticket extensions (externalVcsId, externalVcsUrl, vcsSyncedAt) | prisma-models.integration.spec.ts, schema-validation.integration.spec.ts, vcs-foundation-integration.integration.spec.ts |
| AC4 | Project vcsConnection one-to-one relation | prisma-models.integration.spec.ts, schema-validation.integration.spec.ts, vcs-foundation-integration.integration.spec.ts |
| AC5 | encryptToken format iv:authTag:ciphertext | encryption.util.spec.ts, token-encryption.integration.spec.ts, vcs-foundation-integration.integration.spec.ts |
| AC6 | decryptToken returns original plaintext | encryption.util.spec.ts, token-encryption.integration.spec.ts, vcs-foundation-integration.integration.spec.ts |
| AC7 | decryptToken throws on tampered ciphertext | encryption.util.spec.ts, token-encryption.integration.spec.ts, vcs-foundation-integration.integration.spec.ts |
| AC8 | decryptToken throws with wrong master key | encryption.util.spec.ts, token-encryption.integration.spec.ts, vcs-foundation-integration.integration.spec.ts |
| AC9 | vcsConfig registers with namespace "vcs" | vcs.config.spec.ts, vcs-config-registration.integration.spec.ts, vcs-foundation-integration.integration.spec.ts |

## Running All Tests

**Unit tests only:**
```bash
npx jest src/common/utils/encryption.util.spec.ts src/config/vcs.config.spec.ts
```

**Integration tests only:**
```bash
DATABASE_URL=file:./koda-test.db npx jest test/integration/vcs/
```

**All tests:**
```bash
DATABASE_URL=file:./koda-test.db npx jest src/common/utils/encryption.util.spec.ts src/config/vcs.config.spec.ts test/integration/vcs/
```

## Test Statistics

- **Total Test Suites:** 7 files
- **Total Test Cases:** 150+ assertions covering all AC
- **Coverage Areas:**
  - Encryption/decryption (AES-256-GCM): 40+ tests
  - Prisma models (schema validation): 30+ tests
  - Config registration (NestJS): 25+ tests
  - Integration workflows: 20+ tests
  - Security properties: 15+ tests
  - Edge cases and error handling: 20+ tests

## Notes

- Integration tests require `DATABASE_URL` environment variable
- Encryption tests use randomly generated master keys
- Schema tests create temporary SQLite databases
- All cleanup is automatic via afterAll hooks
- Tests are hermetic (no external dependencies)
